import assert from "node:assert/strict";
import test from "node:test";
import { chartClaims, claimElements, classifyElement } from "../src/domain/fto.js";
import { stem, tokenize } from "../src/domain/relevance.js";
import { createHash } from "node:crypto";
import { decide, deriveSignatures, fingerprints, provisionalSection, splitFeatures } from "../src/domain/vet.js";
import { parseTimemap, waybackDate, type Capture } from "../src/providers/archives.js";
import { earliestWaybackMatch } from "../src/vet.js";

const CLAIM =
  "1. A sensor assembly comprising: a housing; an optical sensor disposed in the housing; and a reference surface sealed in a chamber of the housing, wherein the optical sensor recalibrates against the reference surface when drift exceeds a threshold.";
const FEATURE =
  "A handheld optical sensor sits in a housing and recalibrates against a reference surface sealed in a chamber whenever measured drift exceeds a threshold.";

test("claim elements split on semicolons and wherein clauses", () => {
  const { preamble, elements } = claimElements(CLAIM);
  assert.equal(preamble, "A sensor assembly comprising");
  assert.deepEqual(elements, [
    "a housing",
    "an optical sensor disposed in the housing",
    "a reference surface sealed in a chamber of the housing",
    "wherein the optical sensor recalibrates against the reference surface when drift exceeds a threshold",
  ]);
});

test("elements are present, absent, or unclear by shared content terms", () => {
  const stems = new Set(tokenize(FEATURE).map(stem));
  assert.equal(classifyElement("an optical sensor disposed in the housing", stems).status, "present");
  assert.equal(classifyElement("a wireless radio transmitting packets to a base station", stems).status, "absent");
  assert.equal(classifyElement("a battery powering the optical sensor", stems).status, "unclear");
});

test("a claim with every element present is flagged; one absent element clears it", () => {
  const [flagged] = chartClaims([{ number: 1, text: CLAIM }], FEATURE);
  assert.equal(flagged?.flag, "all-elements-present");
  const [cleared] = chartClaims([{ number: 1, text: `${CLAIM.replace(/\.$/, "")}; and a wireless radio transmitting packets to a base station.` }], FEATURE);
  assert.equal(cleared?.flag, "element-absent");
});

test("descriptions split into features by headings, bullets, or paragraphs", () => {
  const headed = splitFeatures("# Drift recalibration\nThe sensor recalibrates against a sealed reference surface when drift exceeds a threshold.\n\n# Thermal guard\nA thermistor pauses measurement while the housing warms above a set temperature limit.");
  assert.deepEqual(headed.map((feature) => feature.name), ["Drift recalibration", "Thermal guard"]);
  assert.match(headed[1]!.description, /thermistor/);
  const paragraphs = splitFeatures("The sensor recalibrates against a sealed reference surface when drift exceeds a threshold.\n\nA thermistor pauses measurement while the housing warms above a set temperature limit.");
  assert.equal(paragraphs.length, 2);
  assert.equal(splitFeatures("One short feature about a sensor that recalibrates itself in the field.").length, 1);
});

test("verdict: closed grace publishes, crowded publishes, open grace files, undetectable keeps secret", () => {
  assert.equal(decide({ closestCoverage: 0.3, ftoFlags: [], disclosedOn: "2024-01-01", usGrace: "closed" }).recommendation, "publish-defensively");
  assert.equal(decide({ closestCoverage: 0.9, ftoFlags: [] }).recommendation, "publish-defensively");
  const open = decide({ closestCoverage: 0.3, ftoFlags: ["US9765584"], disclosedOn: "2026-06-01", usGrace: "open", usDeadline: "2027-06-01" });
  assert.equal(open.recommendation, "file");
  assert.ok(open.reasons.some((reason) => reason.includes("2027-06-01")));
  assert.ok(open.cautions.some((caution) => caution.includes("US9765584")));
  assert.equal(decide({ closestCoverage: 0.3, ftoFlags: [], detectable: false }).recommendation, "keep-secret");
  const unknown = decide({ closestCoverage: 0.3, ftoFlags: [] });
  assert.equal(unknown.recommendation, "file");
  assert.ok(unknown.cautions.some((caution) => /secret/.test(caution)));
});

test("fingerprints normalize and hash each signature", () => {
  const [print] = fingerprints("Drift recalibration", ["  Recalibrate   NOW "]);
  assert.equal(print?.normalized, "recalibrate now");
  assert.equal(print?.sha256, createHash("sha256").update("recalibrate now").digest("hex"));
  assert.deepEqual(deriveSignatures("The reference surface is sealed. Drift is measured against the reference surface."), ["reference surface"]);
  assert.deepEqual(deriveSignatures(FEATURE), [], "single words are never derived: they match almost any page");
});

test("provisional section marks gaps and keeps the draft banner", () => {
  const text = provisionalSection({ feature: { name: "Drift recalibration", description: FEATURE }, closestArt: [{ id: "US9765584", title: "Self-calibrating optical sensor housing", date: "2010-01-01" }] });
  assert.match(text, /DRAFT/);
  assert.match(text, /US9765584 \(2010-01-01\)/);
  assert.match(text, /ATTORNEY INPUT REQUIRED: embodiments/);
  assert.match(text, /comprising:/);
});

test("archive date helpers", () => {
  assert.equal(waybackDate("20150930234511"), "2015-09-30T23:45:11Z");
  const map = parseTimemap('<https://archive.ph/b>; rel="memento"; datetime="Tue, 02 Jan 2024 00:00:00 GMT",\n<https://archive.ph/a>; rel="first memento"; datetime="Mon, 01 Jan 2024 00:00:00 GMT"');
  assert.deepEqual(map.map((entry) => entry.date.slice(0, 10)), ["2024-01-01", "2024-01-02"]);
});

test("earliest Wayback match binary-searches with few fetches", async () => {
  const captures: Capture[] = Array.from({ length: 64 }, (_, index) => ({ date: `d${index}`, timestamp: String(index), original: "https://example.com/" }));
  let fetches = 0;
  const content = async (capture: Capture) => {
    fetches += 1;
    return Number(capture.timestamp) >= 37 ? "<p>Recalibrate now</p>" : "<p>coming soon</p>";
  };
  const found = await earliestWaybackMatch(captures, ["recalibrate NOW"], content);
  assert.equal(found?.capture.timestamp, "37");
  assert.equal(found?.signature, "recalibrate NOW");
  assert.ok(fetches <= 12, `fetches ${fetches}`);
  assert.equal(await earliestWaybackMatch(captures, ["absent text"], async () => "nothing"), undefined);
});
