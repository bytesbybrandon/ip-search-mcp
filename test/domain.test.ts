import assert from "node:assert/strict";
import test from "node:test";
import { assessConcept } from "../src/domain/assessment.js";
import { assessDisclosure } from "../src/domain/disclosure.js";
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
