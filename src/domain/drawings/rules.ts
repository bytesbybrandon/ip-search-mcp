/**
 * Drawing requirements encoded from 37 CFR 1.84 and MPEP 608.02.
 *
 * Source: eCFR, title 37, part 1, section 1.84, retrieved 2026-11-10.
 * https://www.ecfr.gov/current/title-37/chapter-I/subchapter-A/part-1/subpart-B/subject-group-ECFR1c9d0ba7d2c0a0f
 *
 * This module is data, not legal advice. It exists so a draft drawing can be
 * checked against the mechanical requirements an examiner applies first.
 */

export const CFR_184_URL = "https://www.ecfr.gov/current/title-37/chapter-I/subchapter-A/part-1/subpart-B/subject-group-ECFR1c9d0ba7d2c0a0f";
export const CFR_184_RETRIEVED = "2026-11-10";

export interface SheetPreset {
  id: "A4" | "Letter";
  label: string;
  widthMm: number;
  heightMm: number;
  sightWidthMm: number;
  sightHeightMm: number;
}

/** Paragraph (f) sheet sizes and paragraph (g) maximum sight derived from them. */
export const SHEET_PRESETS: readonly SheetPreset[] = [
  { id: "A4", label: "DIN A4 (21.0 cm by 29.7 cm)", widthMm: 210, heightMm: 297, sightWidthMm: 170, sightHeightMm: 262 },
  { id: "Letter", label: "8 1/2 by 11 in", widthMm: 215.9, heightMm: 279.4, sightWidthMm: 176, sightHeightMm: 244 },
] as const;

export const MARGINS_MM = {
  top: 25,
  left: 25,
  right: 15,
  bottom: 10,
} as const;

/** Paragraph (p)(3): numbers, letters, and reference characters at least .32 cm high. */
export const MIN_TEXT_HEIGHT_MM = 3.2;

/** MPEP 608.02(VI): lines at least 0.007 inch (0.18 mm) thick. */
export const MIN_LINE_WIDTH_MM = 0.18;

/** Paragraph (g): scan targets in two catercorner margin corners. */
export const SCAN_TARGET_ARM_MM = 10;

/** Paragraph (k): scale indications are prohibited on the drawing. */
export const PROHIBITED_SCALE_TEXT = /actual size|scale\s*\d+\s*[:/]\s*\d+/i;

/** Paragraph (p)(1): plain characters, no brackets, quotes, or enclosing outlines. */
export const REFERENCE_CHARACTER_PATTERN = /^\d{1,4}$/;

export type RuleSeverity = "error" | "warning" | "advisory";

export interface RuleDefinition {
  id: string;
  citation: string;
  severity: RuleSeverity;
  requirement: string;
}

export const DRAWING_RULES: readonly RuleDefinition[] = [
  { id: "sheet.size", citation: "37 CFR 1.84(f)", severity: "error", requirement: "Every sheet is A4 or 8 1/2 by 11 inches and all sheets in one application are the same size." },
  { id: "sheet.margin", citation: "37 CFR 1.84(g)", severity: "error", requirement: "Top 2.5 cm, left 2.5 cm, right 1.5 cm, bottom 1.0 cm, leaving a sight no larger than 17.0 by 26.2 cm on A4 or 17.6 by 24.4 cm on letter." },
  { id: "sheet.frame", citation: "37 CFR 1.84(g)", severity: "error", requirement: "No frame around the sight. Scan targets are permitted in two catercorner margin corners." },
  { id: "ink.black", citation: "37 CFR 1.84(a)(1), (l)", severity: "error", requirement: "Black and white drawings unless color is filed under 1.84(a)(2). Every line and letter is clean, black, dense, and uniformly thick." },
  { id: "line.weight", citation: "37 CFR 1.84(l); MPEP 608.02(VI)", severity: "error", requirement: "Lines are heavy enough for reproduction, at least 0.18 mm (0.007 inch)." },
  { id: "text.height", citation: "37 CFR 1.84(p)(3)", severity: "error", requirement: "Numbers, letters, and reference characters measure at least 0.32 cm in height." },
  { id: "text.plain", citation: "37 CFR 1.84(p)(1)", severity: "error", requirement: "Reference characters are plain, without brackets, inverted commas, or enclosing outlines." },
  { id: "text.place", citation: "37 CFR 1.84(p)(3), (p)(5)", severity: "warning", requirement: "Reference characters must not cross or mingle with lines or sit on hatched surfaces, and every character in the drawing must appear in the description." },
  { id: "text.scale", citation: "37 CFR 1.84(k)", severity: "error", requirement: "Indications such as actual size or scale 1/2 are prohibited." },
  { id: "views.separate", citation: "37 CFR 1.84(i)", severity: "error", requirement: "One view must not be placed upon another or within the outline of another." },
  { id: "views.labels", citation: "37 CFR 1.84(h), (p)(1)", severity: "error", requirement: "Views are clearly separated and labeled as views, conventionally FIG. 1, FIG. 2." },
  { id: "views.orientation", citation: "37 CFR 1.84(i)", severity: "warning", requirement: "All views on a sheet stand in the same direction and read with the sheet upright." },
  { id: "header.identifying", citation: "37 CFR 1.84(c)", severity: "advisory", requirement: "Identifying indicia in the top margin: title of the invention, inventor name, and application or docket number." },
  { id: "sheet.numbering", citation: "37 CFR 1.84(p)(1); MPEP 608.02", severity: "advisory", requirement: "Sheets are numbered (Sheet 1 of N) in a margin." },
  { id: "views.projection", citation: "37 CFR 1.84(h)", severity: "advisory", requirement: "Views are not connected by projection lines and contain no center lines." },
  { id: "scale.reproduction", citation: "37 CFR 1.84(k)", severity: "advisory", requirement: "Scale is large enough to remain legible when reduced to two-thirds." },
  { id: "hatch.spacing", citation: "37 CFR 1.84(h)(3)", severity: "advisory", requirement: "Section hatching uses regularly spaced oblique parallel lines, spaced enough to be distinguished." },
] as const;

export const RULE_BY_ID: Record<string, RuleDefinition> = Object.fromEntries(
  DRAWING_RULES.map((rule) => [rule.id, rule]),
);
