import { MARGINS_MM, SCAN_TARGET_ARM_MM, SHEET_PRESETS, type SheetPreset } from "./rules.js";

export type Shape =
  | { type: "rect"; x: number; y: number; width: number; height: number; hatch?: boolean; strokeWidth?: number; rx?: number }
  | { type: "circle"; cx: number; cy: number; r: number; hatch?: boolean; strokeWidth?: number }
  | { type: "ellipse"; cx: number; cy: number; rx: number; ry: number; strokeWidth?: number }
  | { type: "line"; x1: number; y1: number; x2: number; y2: number; dashed?: boolean; strokeWidth?: number }
  | { type: "polyline"; points: Array<[number, number]>; closed?: boolean; strokeWidth?: number }
  | { type: "path"; d: string; strokeWidth?: number }
  | { type: "text"; x: number; y: number; text: string; size?: number; anchor?: "start" | "middle" | "end" }
  | { type: "reference"; x: number; y: number; number: number; leaderTo?: [number, number] };

export interface FigureSpec {
  /** Defaults to FIG. <index>. */
  label?: string;
  elements: Shape[];
}

export interface SheetSpec {
  preset?: SheetPreset["id"];
  title?: string;
  inventor?: string;
  docket?: string;
  sheetNumber?: number;
  totalSheets?: number;
  figures: FigureSpec[];
}

export interface FigureLayout {
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RenderedSheet {
  svg: string;
  preset: SheetPreset;
  sight: { x: number; y: number; width: number; height: number };
  figures: FigureLayout[];
  warnings: string[];
}

const FIGURE_GAP_MM = 8;
const MIN_TEXT_MM = 3.2;

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function printf(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function renderShape(shape: Shape, originX: number, originY: number): string {
  const stroke = `stroke="#000000" fill="none" stroke-linecap="round" stroke-linejoin="round"`;
  switch (shape.type) {
    case "rect": {
      const width = Math.max(0.5, shape.strokeWidth ?? 0.35);
      return `<rect x="${printf(originX + shape.x)}" y="${printf(originY + shape.y)}" width="${printf(shape.width)}" height="${printf(shape.height)}" rx="${printf(shape.rx ?? 0)}" ${stroke} stroke-width="${printf(width)}"${shape.hatch ? ' fill="url(#hatch)"' : ""}/>`;
    }
    case "circle": {
      const width = Math.max(0.5, shape.strokeWidth ?? 0.35);
      return `<circle cx="${printf(originX + shape.cx)}" cy="${printf(originY + shape.cy)}" r="${printf(shape.r)}" ${stroke} stroke-width="${printf(width)}"${shape.hatch ? ' fill="url(#hatch)"' : ""}/>`;
    }
    case "ellipse": {
      const width = Math.max(0.5, shape.strokeWidth ?? 0.35);
      return `<ellipse cx="${printf(originX + shape.cx)}" cy="${printf(originY + shape.cy)}" rx="${printf(shape.rx)}" ry="${printf(shape.ry)}" ${stroke} stroke-width="${printf(width)}"/>`;
    }
    case "line": {
      const width = Math.max(0.5, shape.strokeWidth ?? 0.35);
      return `<line x1="${printf(originX + shape.x1)}" y1="${printf(originY + shape.y1)}" x2="${printf(originX + shape.x2)}" y2="${printf(originY + shape.y2)}" ${stroke} stroke-width="${printf(width)}"${shape.dashed ? ' stroke-dasharray="2 1"' : ""}/>`;
    }
    case "polyline": {
      const width = Math.max(0.5, shape.strokeWidth ?? 0.35);
      const points = shape.points.map(([x, y]) => `${printf(originX + x)},${printf(originY + y)}`).join(" ");
      return shape.closed
        ? `<polygon points="${points}" ${stroke} stroke-width="${printf(width)}"/>`
        : `<polyline points="${points}" ${stroke} stroke-width="${printf(width)}"/>`;
    }
    case "path": {
      const width = Math.max(0.5, shape.strokeWidth ?? 0.35);
      return `<path d="${escapeXml(shape.d)}" transform="translate(${printf(originX)} ${printf(originY)})" ${stroke} stroke-width="${printf(width)}"/>`;
    }
    case "text": {
      const size = Math.max(MIN_TEXT_MM, shape.size ?? 4);
      const anchor = shape.anchor ?? "middle";
      return `<text x="${printf(originX + shape.x)}" y="${printf(originY + shape.y)}" font-family="Arial, Helvetica, sans-serif" font-size="${printf(size)}" text-anchor="${anchor}" fill="#000000" stroke="none" data-role="label">${escapeXml(shape.text)}</text>`;
    }
    case "reference": {
      const size = Math.max(MIN_TEXT_MM, 4);
      const label = `<text x="${printf(originX + shape.x)}" y="${printf(originY + shape.y)}" font-family="Arial, Helvetica, sans-serif" font-size="${printf(size)}" text-anchor="middle" fill="#000000" stroke="none" data-role="reference">${shape.number}</text>`;
      if (!shape.leaderTo) return label;
      const [tx, ty] = shape.leaderTo;
      return `${label}<line x1="${printf(originX + shape.x)}" y1="${printf(originY + shape.y + 1)}" x2="${printf(originX + tx)}" y2="${printf(originY + ty)}" stroke="#000000" stroke-width="0.25"/>`;
    }
  }
}

function scanTarget(x: number, y: number, arm: number): string {
  return `<g data-role="scan-target" stroke="#000000" stroke-width="0.3"><line x1="${printf(x - arm)}" y1="${printf(y)}" x2="${printf(x + arm)}" y2="${printf(y)}"/><line x1="${printf(x)}" y1="${printf(y - arm)}" x2="${printf(x)}" y2="${printf(y + arm)}"/></g>`;
}

/**
 * Render a sheet that satisfies the mechanical requirements of 37 CFR 1.84:
 * A4 or letter, fixed margins, no sight frame, scan targets in two catercorner
 * margin corners, header indicia inside the top margin, black line art, and
 * reference characters no smaller than 0.32 cm.
 */
export function renderSheet(spec: SheetSpec): RenderedSheet {
  const preset = SHEET_PRESETS.find((entry) => entry.id === (spec.preset ?? "A4")) ?? SHEET_PRESETS[0]!;
  const warnings: string[] = [];
  const figures = spec.figures ?? [];
  if (figures.length === 0) warnings.push("no figures provided; rendering an empty compliant sheet");

  const sight = {
    x: MARGINS_MM.left,
    y: MARGINS_MM.top,
    width: preset.widthMm - MARGINS_MM.left - MARGINS_MM.right,
    height: preset.heightMm - MARGINS_MM.top - MARGINS_MM.bottom,
  };

  const available = sight.height - FIGURE_GAP_MM * Math.max(0, figures.length - 1);
  const blockHeight = figures.length > 0 ? available / figures.length : 0;
  if (blockHeight < 45) {
    warnings.push(
      `figure block height is ${blockHeight.toFixed(1)} mm; split ${figures.length} figures across more sheets`,
    );
  }

  const layout: FigureLayout[] = figures.map((figure, index) => ({
    label: figure.label ?? `FIG. ${index + 1}`,
    x: sight.x,
    y: sight.y + index * (blockHeight + FIGURE_GAP_MM),
    width: sight.width,
    height: blockHeight,
  }));

  const totalSheets = spec.totalSheets ?? 1;
  const sheetNumber = spec.sheetNumber ?? 1;
  const title = spec.title?.trim() || "DRAFT PATENT DRAWINGS";
  const inventor = spec.inventor?.trim() || "Inventor: ____________________";
  const docket = spec.docket?.trim() ? `Docket ${spec.docket.trim()}` : "Docket: __________";

  const header = `<g data-role="header" font-family="Arial, Helvetica, sans-serif" fill="#000000" text-anchor="middle">
    <text x="${printf(preset.widthMm / 2)}" y="9" font-size="4.2">${escapeXml(title.toUpperCase())}</text>
    <text x="${printf(preset.widthMm / 2)}" y="15" font-size="3.6">${escapeXml(inventor)}</text>
    <text x="${printf(preset.widthMm / 2)}" y="20" font-size="3.6">${escapeXml(docket)}</text>
    <text x="${printf(preset.widthMm / 2)}" y="${printf(preset.heightMm - 6)}" font-size="3.6">Sheet ${sheetNumber} of ${totalSheets}</text>
  </g>`;

  const body = layout
    .map((block, index) => {
      const figure = figures[index]!;
      const shapes = figure.elements.map((shape) => renderShape(shape, block.x, block.y)).join("\n    ");
      return `<g data-figure="${escapeXml(block.label)}">
    ${shapes}
    <text x="${printf(block.x + block.width / 2)}" y="${printf(block.y + block.height - 2)}" font-family="Arial, Helvetica, sans-serif" font-size="4.2" text-anchor="middle" fill="#000000" stroke="none" data-role="label">${escapeXml(block.label)}</text>
  </g>`;
    })
    .join("\n  ");

  const defs = `<defs>
    <pattern id="hatch" width="3" height="3" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <line x1="0" y1="0" x2="0" y2="3" stroke="#000000" stroke-width="0.18"/>
    </pattern>
  </defs>`;

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${printf(preset.widthMm)}mm" height="${printf(preset.heightMm)}mm" viewBox="0 0 ${printf(preset.widthMm)} ${printf(preset.heightMm)}">
  ${defs}
  ${scanTarget(12, 12, SCAN_TARGET_ARM_MM)}
  ${scanTarget(preset.widthMm - 12, preset.heightMm - 12, SCAN_TARGET_ARM_MM)}
  ${header}
  ${body}
</svg>
`;

  return { svg, preset, sight, figures: layout, warnings };
}

/** Shape vocabulary help, kept next to the renderer so the two cannot drift. */
export const SHAPE_DOCS = {
  rect: "x, y, width, height, hatch?, strokeWidth?, rx?",
  circle: "cx, cy, r, hatch?, strokeWidth?",
  ellipse: "cx, cy, rx, ry, strokeWidth?",
  line: "x1, y1, x2, y2, dashed?, strokeWidth?",
  polyline: "points: [[x, y], ...], closed?, strokeWidth?",
  path: "d (SVG path data), strokeWidth?",
  text: "x, y, text, size?, anchor? (start | middle | end)",
  reference: "x, y, number, leaderTo?: [x, y]",
} as const;

export { MIN_TEXT_MM };
