import assert from "node:assert/strict";
import test from "node:test";
import { renderSheet } from "../src/domain/drawings/render.js";
import { validateDrawing } from "../src/domain/drawings/validate.js";

const GOOD = renderSheet({
  preset: "A4",
  title: "Self-calibrating optical sensor",
  inventor: "Ada Lovelace",
  docket: "GW-102",
  sheetNumber: 1,
  totalSheets: 1,
  figures: [
    {
      label: "FIG. 1",
      elements: [
        { type: "rect", x: 40, y: 50, width: 70, height: 45 },
        { type: "circle", cx: 75, cy: 72, r: 14 },
        { type: "line", x1: 110, y1: 72, x2: 150, y2: 72 },
        { type: "reference", x: 130, y: 66, number: 10 },
        { type: "reference", x: 60, y: 60, number: 12, leaderTo: [75, 72] },
      ],
    },
  ],
});

test("generated sheet passes every encoded 1.84 check", () => {
  const report = validateDrawing(GOOD.svg, {
    descriptionText: "A housing 10 holds an optical sensor 12.",
    expectedFigures: ["FIG. 1"],
  });
  const errors = report.findings.filter((finding) => finding.severity === "error");
  assert.deepEqual(errors, []);
  assert.equal(report.ok, true);
  assert.equal(report.sheet.preset, "A4");
  assert.deepEqual(report.measurements.referenceCharacters, [10, 12]);
});

test("sheet renders margins, scan targets, header, and sheet numbering", () => {
  assert.match(GOOD.svg, /width="210mm" height="297mm"/);
  assert.equal((GOOD.svg.match(/data-role="scan-target"/g) ?? []).length, 2);
  assert.match(GOOD.svg, /Sheet 1 of 1/);
  assert.match(GOOD.svg, /data-role="header"/);
  assert.doesNotMatch(GOOD.svg, /#ff0000/i);
});

const BROKEN = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="210mm" height="297mm" viewBox="0 0 210 297">
  <g data-role="header"><text x="105" y="10" font-size="4" fill="#000000">BROKEN SHEET</text></g>
  <g data-role="scan-target"><line x1="0" y1="12" x2="22" y2="12" stroke="#000000" stroke-width="0.3"/></g>
  <rect x="10" y="40" width="50" height="50" stroke="#000000" stroke-width="0.05" fill="#ff0000"/>
  <rect x="25" y="25" width="170" height="262" fill="none" stroke="#000000" stroke-width="0.3"/>
  <line x1="30" y1="120" x2="180" y2="120" stroke="#000000" stroke-width="0.35"/>
  <text x="120" y="121" font-size="2" fill="#000000">12</text>
  <text x="100" y="200" font-size="4" fill="#000000">actual size</text>
  <g data-figure="FIG. 1"><rect x="40" y="40" width="60" height="40" stroke="#000000" stroke-width="0.35"/></g>
  <g data-figure="FIG. 2"><rect x="60" y="50" width="60" height="40" stroke="#000000" stroke-width="0.35"/></g>
</svg>`;

test("broken sheet reports each violated rule with its citation", () => {
  const report = validateDrawing(BROKEN);
  const rules = new Set(report.findings.map((finding) => finding.ruleId));
  for (const expected of [
    "sheet.margin",
    "sheet.frame",
    "ink.black",
    "line.weight",
    "text.height",
    "text.scale",
    "text.place",
    "views.separate",
    "views.labels",
  ]) {
    assert.ok(rules.has(expected), `expected finding ${expected}; got ${[...rules].join(", ")}`);
  }
  assert.equal(report.ok, false);
  assert.ok(report.findings.every((finding) => finding.citation.length > 0));
});

test("reference characters missing from the description are reported", () => {
  const rendered = renderSheet({
    figures: [{ label: "FIG. 1", elements: [{ type: "reference", x: 60, y: 60, number: 99 }] }],
  });
  const report = validateDrawing(rendered.svg, { descriptionText: "A housing 10." });
  assert.ok(report.findings.some((finding) => /character 99/.test(finding.message)));
});

test("non-A4 sheet sizes are rejected", () => {
  const report = validateDrawing(
    `<svg xmlns="http://www.w3.org/2000/svg" width="8.5in" height="8.5in" viewBox="0 0 215.9 215.9"><text x="50" y="50" font-size="4" fill="#000000">x</text></svg>`,
  );
  assert.ok(report.findings.some((finding) => finding.ruleId === "sheet.size"));
});

test("letter preset renders and validates as letter", () => {
  const letter = renderSheet({
    preset: "Letter",
    figures: [{ label: "FIG. 1", elements: [{ type: "rect", x: 30, y: 30, width: 40, height: 30 }] }],
  });
  const report = validateDrawing(letter.svg, { expectedFigures: ["FIG. 1"] });
  assert.equal(report.sheet.preset, "Letter");
  assert.deepEqual(report.findings.filter((finding) => finding.severity === "error"), []);
});
