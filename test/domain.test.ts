import assert from "node:assert/strict";
import test from "node:test";
import { assessConcept } from "../src/domain/assessment.js";
import { GRACE_RULES, assessDisclosure } from "../src/domain/disclosure.js";
import { buildSearchBody } from "../src/providers/tmsearch.js";

test("software concept flags 101 risks and proposes classifications", () => {
  const assessment = assessConcept({
    concept:
      "A software platform that collects candidate profiles, ranks them with a statistical model, and collects a subscription payment for access.",
    productName: "QUICKRANK",
  });
  const ids = new Set(assessment.subjectMatter.map((finding) => finding.id));
  assert.ok(ids.has("101.software"));
  assert.ok(ids.has("101.math") || ids.has("101.commercial") || ids.has("101.mental"));
  assert.ok(assessment.classifications.some((entry) => entry.scheme === "CPC" && entry.code.startsWith("G06")));
  assert.ok(assessment.classifications.some((entry) => entry.scheme === "Nice"));
});

test("trademark screen marks a laudatory wordmark as possibly descriptive", () => {
  const assessment = assessConcept({ concept: "payment processing software", productName: "QUICKPAY" });
  assert.match(assessment.trademark.distinctiveness.band, /descriptive/i);
  assert.ok(assessment.trademark.dupontFactors.length >= 5);
});

test("classification matches whole words, not substrings", () => {
  const assessment = assessConcept({
    concept: "A housing that holds a reference surface and measures drift inside a sealed chamber.",
  });
  assert.equal(assessment.classifications.filter((entry) => entry.code === "25").length, 0);
  assert.ok(assessment.classifications.every((entry) => entry.confidence === "low" || entry.confidence === "medium"));
  assert.ok(assessment.classifications.some((entry) => entry.code === "G01B" || entry.code === "G02B"));
});

test("assessment states what evidence is missing", () => {
  const assessment = assessConcept({ concept: "A mechanical valve with a ceramic seat for high temperature service." });
  assert.ok(assessment.missingEvidence.some((entry) => /No patent or application hits/.test(entry)));
  assert.ok(assessment.disclaimer.includes("Not legal advice"));
});

test("disclosure screen computes the one-year US grace deadline", () => {
  const result = assessDisclosure({
    disclosureDate: "2026-06-01",
    disclosureKind: "publication",
    byInventor: true,
    plannedFilingDate: "2026-12-01",
    jurisdictions: ["US", "EP"],
  });
  assert.equal(result.usDeadline, "2027-06-01");
  assert.equal(result.urgency, "routine");
  const us = result.jurisdictions.find((entry) => entry.code === "US");
  const ep = result.jurisdictions.find((entry) => entry.code === "EP");
  assert.equal(us?.status, "open");
  assert.equal(ep?.status, "no-grace");
});

test("disclosure screen reports a closed US grace period", () => {
  const result = assessDisclosure({
    disclosureDate: "2025-01-15",
    plannedFilingDate: "2026-06-01",
    jurisdictions: ["US"],
  });
  assert.equal(result.urgency, "barred");
  assert.equal(result.jurisdictions[0]?.status, "closed");
});

test("disclosure screen with no recorded disclosure stays neutral", () => {
  const result = assessDisclosure({});
  assert.equal(result.urgency, "none-recorded");
  assert.equal(result.jurisdictions.length, 0);
});

test("trademark search body zero-pads classes and filters live marks", () => {
  const body = buildSearchBody({ internationalClass: 9, status: "live", markText: "ACME", limit: 10 });
  const bool = body.query.bool as { must: unknown[]; filter: Array<Record<string, unknown>> };
  assert.equal(body.size, 10);
  assert.equal(body.track_total_hits, true);
  assert.ok(bool.must.some((entry) => JSON.stringify(entry).includes("ACME")));
  assert.ok(bool.filter.some((entry) => JSON.stringify(entry).includes("009")));
  assert.ok(bool.filter.some((entry) => JSON.stringify(entry).includes('"alive":true')));
  assert.equal(body.from, 0);
});

test("foreign grace table: every jurisdiction carries a citation and the right kind of grace", () => {
  const expected: Record<string, { kind: string; months: number }> = {
    EP: { kind: "none", months: 0 },
    GB: { kind: "none", months: 0 },
    DE: { kind: "none", months: 0 },
    FR: { kind: "none", months: 0 },
    CN: { kind: "narrow", months: 6 },
    IN: { kind: "narrow", months: 12 },
    JP: { kind: "conditional", months: 12 },
    KR: { kind: "conditional", months: 12 },
    CA: { kind: "conditional", months: 12 },
    AU: { kind: "conditional", months: 12 },
    BR: { kind: "general", months: 12 },
  };
  assert.deepEqual(GRACE_RULES.map((rule) => rule.code).sort(), Object.keys(expected).sort());
  for (const rule of GRACE_RULES) {
    assert.equal(rule.kind, expected[rule.code]?.kind, rule.code);
    assert.equal(rule.graceMonths, expected[rule.code]?.months, rule.code);
    assert.ok(rule.citation.length > 5 && rule.conditions.length > 20, `${rule.code} needs a citation and conditions`);
  }
});

test("disclosure screen: limited 12-month graces stay open and close on time; no-grace offices stay barred", () => {
  const open = assessDisclosure({ disclosureDate: "2026-06-01", byInventor: true, plannedFilingDate: "2026-12-01" });
  const status = (code: string) => open.jurisdictions.find((entry) => entry.code === code);
  for (const code of ["JP", "KR", "CA", "AU", "BR"]) {
    assert.equal(status(code)?.status, "open", code);
    assert.equal(status(code)?.deadline, "2027-06-01", code);
  }
  for (const code of ["EP", "GB", "DE", "FR", "CN", "IN"]) assert.equal(status(code)?.status, "no-grace", code);
  assert.match(status("JP")?.citation ?? "", /Art\. 30/);
  assert.ok(open.actions.some((action) => /JP and KR: claim the exception/.test(action)));

  const late = assessDisclosure({ disclosureDate: "2025-01-15", byInventor: true, plannedFilingDate: "2026-06-01", jurisdictions: ["JP", "AU"] });
  assert.deepEqual(late.jurisdictions.filter((entry) => entry.code !== "US").map((entry) => entry.status), ["closed", "closed"]);
});
