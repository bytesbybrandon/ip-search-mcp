import { boxHeightMm, boxWidthMm, intersects, parseSvg, type Box, type Primitive } from "./geometry.js";
import {
  CFR_184_RETRIEVED,
  CFR_184_URL,
  MARGINS_MM,
  MIN_LINE_WIDTH_MM,
  MIN_TEXT_HEIGHT_MM,
  PROHIBITED_SCALE_TEXT,
  REFERENCE_CHARACTER_PATTERN,
  RULE_BY_ID,
  SHEET_PRESETS,
  type RuleSeverity,
} from "./rules.js";

export interface Finding {
  ruleId: string;
  citation: string;
  severity: RuleSeverity;
  message: string;
  element?: string;
}

export interface ValidationContext {
  /** Description or specification text used to check reference-character coverage. */
  descriptionText?: string;
  /** Figure labels the specification promises, e.g. ["FIG. 1", "FIG. 2"]. */
  expectedFigures?: string[];
}

export interface ValidationReport {
  ok: boolean;
  sheet: { widthMm: number; heightMm: number; preset?: string };
  measurements: {
    minStrokeWidthMm?: number;
    minFontSizeMm?: number;
    primitiveCount: number;
    textCount: number;
    referenceCharacters: number[];
    sightUsage: { usedWidthMm: number; usedHeightMm: number; allowedWidthMm: number; allowedHeightMm: number };
  };
  findings: Finding[];
  unverifiable: string[];
  rules: { source: string; retrieved: string };
}

const ALLOWED_PAINT = /^(none|#000|#000000|black|url\(#[\w.-]+\))$/i;

function colorProblem(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  if (ALLOWED_PAINT.test(trimmed)) return undefined;
  return trimmed;
}

function sightBox(preset: (typeof SHEET_PRESETS)[number]): Box {
  return {
    x1: MARGINS_MM.left,
    y1: MARGINS_MM.top,
    x2: preset.widthMm - MARGINS_MM.right,
    y2: preset.heightMm - MARGINS_MM.bottom,
  };
}

function contains(outer: Box, inner: Box, tolerance = 0.75): boolean {
  return (
    inner.x1 >= outer.x1 - tolerance &&
    inner.y1 >= outer.y1 - tolerance &&
    inner.x2 <= outer.x2 + tolerance &&
    inner.y2 <= outer.y2 + tolerance
  );
}

function area(box: Box): number {
  return Math.max(0, box.x2 - box.x1) * Math.max(0, box.y2 - box.y1);
}

export function validateDrawing(svg: string, context: ValidationContext = {}): ValidationReport {
  const parsed = parseSvg(svg);
  const findings: Finding[] = [];
  const add = (
    ruleId: string,
    message: string,
    element?: string,
  ): void => {
    const rule = RULE_BY_ID[ruleId];
    findings.push({
      ruleId,
      citation: rule?.citation ?? "unknown",
      severity: rule?.severity ?? "warning",
      message,
      element,
    });
  };

  const preset = SHEET_PRESETS.find(
    (entry) =>
      Math.abs(entry.widthMm - parsed.widthMm) <= 1.0 &&
      Math.abs(entry.heightMm - parsed.heightMm) <= 1.0,
  );
  if (!preset) {
    add(
      "sheet.size",
      `sheet is ${parsed.widthMm.toFixed(1)} by ${parsed.heightMm.toFixed(1)} mm; use A4 (210 by 297) or letter (215.9 by 279.4)`,
    );
  }
  const effective = preset ?? SHEET_PRESETS[0]!;
  const allowed = sightBox(effective);

  const content = parsed.primitives.filter(
    (primitive) => primitive.role !== "header" && primitive.role !== "scan-target",
  );

  for (const primitive of content) {
    if (!contains(allowed, primitive.box)) {
      add(
        "sheet.margin",
        `element leaves the sight: ${describe(primitive)}`,
        primitive.attributes.id,
      );
    }
  }

  const frame = parsed.primitives.find(
    (primitive) =>
      primitive.type === "rect" &&
      primitive.stroke !== undefined &&
      area(primitive.box) >= area(allowed) * 0.9,
  );
  if (frame) {
    add("sheet.frame", "a rectangle surrounds the sight; 37 CFR 1.84(g) prohibits frames", frame.attributes.id);
  }

  for (const primitive of parsed.primitives) {
    const badStroke = colorProblem(primitive.stroke);
    const badFill = colorProblem(primitive.fill);
    if (badStroke) add("ink.black", `stroke is ${badStroke}; drawings must be black and white`, primitive.attributes.id);
    if (badFill) add("ink.black", `fill is ${badFill}; drawings must be black and white`, primitive.attributes.id);
    if (badStroke || badFill) break;
  }

  const stroked = parsed.primitives.filter(
    (primitive) => primitive.type !== "text" && primitive.stroke !== undefined && primitive.stroke !== "none",
  );
  for (const primitive of stroked) {
    const width = primitive.strokeWidthMm ?? 0;
    if (width > 0 && width < MIN_LINE_WIDTH_MM - 0.001) {
      add(
        "line.weight",
        `stroke is ${width.toFixed(2)} mm, below the ${MIN_LINE_WIDTH_MM} mm floor`,
        primitive.attributes.id,
      );
    }
  }

  const texts = parsed.primitives.filter((primitive) => primitive.type === "text");
  for (const text of texts) {
    const size = text.fontSizeMm ?? 0;
    if (size > 0 && size < MIN_TEXT_HEIGHT_MM - 0.01) {
      add(
        "text.height",
        `text "${text.text ?? ""}" is ${size.toFixed(2)} mm, below the 3.2 mm floor`,
        text.attributes.id,
      );
    }
    if (text.text && PROHIBITED_SCALE_TEXT.test(text.text)) {
      add("text.scale", `prohibited scale indication: "${text.text}"`, text.attributes.id);
    }
    if (text.attributes.transform && /rotate/.test(text.attributes.transform)) {
      add("views.orientation", `rotated text: "${text.text ?? ""}"`, text.attributes.id);
    }
  }

  const references = texts.filter(
    (text) => text.attributes["data-role"] === "reference" || (text.text !== undefined && REFERENCE_CHARACTER_PATTERN.test(text.text ?? "")),
  );
  for (const reference of references) {
    const value = reference.text ?? "";
    if (!REFERENCE_CHARACTER_PATTERN.test(value)) {
      add("text.plain", `reference character "${value}" is not a plain numeral`, reference.attributes.id);
    }
    const crossed = parsed.primitives.find(
      (primitive) => primitive.type === "line" && intersects(primitive.box, reference.box),
    );
    if (crossed) {
      add("text.place", `reference character "${value}" crosses a line`, reference.attributes.id);
    }
  }

  const figureGroups = new Map<string, Primitive[]>();
  for (const primitive of content) {
    if (!primitive.figure) continue;
    const bucket = figureGroups.get(primitive.figure);
    if (bucket) bucket.push(primitive);
    else figureGroups.set(primitive.figure, [primitive]);
  }

  const groupBoxes = [...figureGroups.entries()].map(([label, primitives]) => ({
    label,
    box: unionBox(primitives.map((primitive) => primitive.box)),
  }));
  for (let i = 0; i < groupBoxes.length; i += 1) {
    for (let j = i + 1; j < groupBoxes.length; j += 1) {
      const left = groupBoxes[i]!;
      const right = groupBoxes[j]!;
      if (intersects(left.box, right.box)) {
        add("views.separate", `views ${left.label} and ${right.label} overlap`, `${left.label}/${right.label}`);
      }
    }
  }

  for (const [label, primitives] of figureGroups) {
    const hasLabel = primitives.some(
      (primitive) => primitive.type === "text" && /^FIG\.\s*\d+$/i.test(primitive.text ?? ""),
    );
    if (!hasLabel) add("views.labels", `view ${label} has no FIG. label`, label);
  }

  if (context.expectedFigures) {
    const drawn = new Set(
      texts.map((text) => (text.text ?? "").toUpperCase().replace(/\s+/g, " ").trim()).filter(Boolean),
    );
    for (const expected of context.expectedFigures) {
      if (!drawn.has(expected.toUpperCase().replace(/\s+/g, " ").trim())) {
        add("views.labels", `specification references ${expected} but the sheet does not label it`);
      }
    }
  }

  const referenceNumbers = references
    .map((reference) => Number(reference.text))
    .filter((value) => Number.isFinite(value));
  if (context.descriptionText) {
    const description = context.descriptionText;
    for (const number of [...new Set(referenceNumbers)]) {
      const pattern = new RegExp(`\\b${number}\\b`);
      if (!pattern.test(description)) {
        add(
          "text.place",
          `reference character ${number} appears in the drawing but not in the description (1.84(p)(5))`,
        );
      }
    }
  }

  const headerText = texts.filter((text) => text.role === "header");
  if (headerText.length === 0 && parsed.primitives.every((primitive) => !primitive.role)) {
    add("header.identifying", "no header block found in the top margin");
  }
  if (!texts.some((text) => /^Sheet\s+\d+\s+of\s+\d+$/i.test(text.text ?? ""))) {
    add("sheet.numbering", "no Sheet N of M numbering found");
  }

  const patternMatch = svg.match(/<pattern[^>]*width="([\d.]+)"[^>]*height="([\d.]+)"/);
  if (patternMatch) {
    const spacing = Number(patternMatch[1] ?? 0);
    if (Number.isFinite(spacing) && spacing < 1.5) {
      add("hatch.spacing", `hatch spacing is ${spacing} mm; increase it for legibility`);
    }
  }

  if (parsed.unsupported.length > 0) {
    add("views.labels", `unparsed drawing constructs: ${parsed.unsupported.join(", ")}`);
  }

  const strokeWidths = stroked.map((primitive) => primitive.strokeWidthMm ?? 0).filter((value) => value > 0);
  const fontSizes = texts.map((text) => text.fontSizeMm ?? 0).filter((value) => value > 0);
  const usedBox = unionBox(content.map((primitive) => primitive.box));

  return {
    ok: findings.every((finding) => finding.severity !== "error"),
    sheet: { widthMm: parsed.widthMm, heightMm: parsed.heightMm, preset: preset?.id },
    measurements: {
      minStrokeWidthMm: strokeWidths.length > 0 ? Math.min(...strokeWidths) : undefined,
      minFontSizeMm: fontSizes.length > 0 ? Math.min(...fontSizes) : undefined,
      primitiveCount: parsed.primitives.length,
      textCount: texts.length,
      referenceCharacters: [...new Set(referenceNumbers)].sort((a, b) => a - b),
      sightUsage: {
        usedWidthMm: boxWidthMm(usedBox, parsed.unitScaleMm),
        usedHeightMm: boxHeightMm(usedBox, parsed.unitScaleMm),
        allowedWidthMm: allowed.x2 - allowed.x1,
        allowedHeightMm: allowed.y2 - allowed.y1,
      },
    },
    findings,
    unverifiable: [
      "Whether the same reference character designates the same part across views (1.84(p)(4)) requires the part identity, which is not encoded in the drawing.",
      "Whether views are connected by projection lines or contain center lines (1.84(h)) is a drafting judgment, not a geometry test.",
      "Whether the scale survives two-thirds reproduction (1.84(k)) depends on the print run.",
      "Whether shading correctly indicates surface form (1.84(m)) is a judgment call.",
    ],
    rules: { source: CFR_184_URL, retrieved: CFR_184_RETRIEVED },
  };
}

function describe(primitive: Primitive): string {
  const id = primitive.attributes.id ? `#${primitive.attributes.id}` : "element";
  return `${id} (${primitive.type}) at ${primitive.box.x1.toFixed(1)}, ${primitive.box.y1.toFixed(1)}`;
}

function unionBox(boxes: Box[]): Box {
  if (boxes.length === 0) return { x1: 0, y1: 0, x2: 0, y2: 0 };
  return boxes.reduce<Box>(
    (acc, box) => ({
      x1: Math.min(acc.x1, box.x1),
      y1: Math.min(acc.y1, box.y1),
      x2: Math.max(acc.x2, box.x2),
      y2: Math.max(acc.y2, box.y2),
    }),
    { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity },
  );
}

export function formatReport(report: ValidationReport): string {
  const lines: string[] = [];
  lines.push(`# Drawing compliance report (37 CFR 1.84)`);
  lines.push("");
  lines.push(`Sheet: ${report.sheet.widthMm.toFixed(1)} x ${report.sheet.heightMm.toFixed(1)} mm${report.sheet.preset ? ` (${report.sheet.preset})` : ""}`);
  lines.push(`Result: ${report.ok ? "no blocking errors" : "blocking errors found"}`);
  lines.push("");
  if (report.findings.length === 0) {
    lines.push("No findings.");
  } else {
    for (const finding of report.findings) {
      lines.push(`- [${finding.severity}] ${finding.ruleId} (${finding.citation}): ${finding.message}`);
    }
  }
  lines.push("");
  lines.push("## Not machine-verifiable");
  for (const item of report.unverifiable) lines.push(`- ${item}`);
  lines.push("");
  lines.push(`Rules encoded from ${report.rules.source} (retrieved ${report.rules.retrieved}).`);
  return lines.join("\n");
}
