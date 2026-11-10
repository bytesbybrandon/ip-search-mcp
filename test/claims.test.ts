import assert from "node:assert/strict";
import test from "node:test";
import { claimStats, lintClaims, parseClaims } from "../src/domain/claims.js";

const CLAIMS = `1. A device comprising:
   a housing;
   and a sensor disposed in the housing.
2. The device of claim 1, wherein the sensor is optical.
3. The device of claim 1 or 2, wherein the housing is sealed.
4. The device of claim 3, wherein the sensor is calibrated.
5. The device of claims 3 and 4, wherein the housing has a flange.
6. The device of claim 7, wherein the flange is rigid.
7. The device of claim 1, wherein the flange is removable.`;

test("parses numbered claims and dependency metadata", () => {
  const claims = parseClaims(CLAIMS);
  assert.equal(claims.length, 7);
  assert.equal(claims[0]?.independent, true);
  assert.deepEqual(claims[1]?.dependsOn, [1]);
  assert.deepEqual(claims[2]?.dependsOn, [1, 2]);
  assert.equal(claims[2]?.multipleDependency, true);
});

test("counts independent and dependent claims", () => {
  const stats = claimStats(parseClaims(CLAIMS));
  assert.equal(stats.total, 7);
  assert.equal(stats.independent, 1);
  assert.equal(stats.dependent, 6);
  assert.equal(stats.multipleDependent, 2);
});

test("flags multiple dependent claim that depends from another multiple dependent claim", () => {
  const { findings } = lintClaims(CLAIMS);
  const offending = findings.filter((finding) => finding.ruleId === "claims.multiple-dependent");
  assert.ok(offending.some((finding) => finding.claim === 5));
});

test("flags a forward dependency", () => {
  const { findings } = lintClaims(CLAIMS);
  assert.ok(findings.some((finding) => finding.ruleId === "claims.forward" && finding.claim === 6));
});

test("flags missing antecedent basis", () => {
  const { findings } = lintClaims(CLAIMS);
  assert.ok(
    findings.some(
      (finding) => finding.ruleId === "claims.antecedent" && /flange/.test(finding.message),
    ),
  );
});

test("flags means-plus-function language", () => {
  const { findings } = lintClaims("1. A device comprising means for sensing light.");
  assert.ok(findings.some((finding) => finding.ruleId === "claims.112f"));
});

test("enforces the 150-word abstract limit", () => {
  const abstract = Array.from({ length: 155 }, () => "word").join(" ");
  const { findings } = lintClaims("1. A device comprising a housing.", { abstractText: abstract });
  assert.ok(findings.some((finding) => finding.ruleId === "abstract.length"));
});

test("flags claim terms missing from the specification", () => {
  const { findings } = lintClaims(CLAIMS, {
    specificationText: "A device with a housing and a sensor.",
  });
  assert.ok(findings.some((finding) => finding.ruleId === "claims.support"));
});

test("specification support tolerates inflectional endings", () => {
  const { findings } = lintClaims("1. A device comprising a housing that defines a chamber and corrects drift.", {
    specificationText: "The device has a housing defining a chamber and correct drift.",
  });
  assert.equal(findings.filter((finding) => finding.ruleId === "claims.support").length, 0);
});

test("rejects claim sets with no independent claim", () => {
  const { findings } = lintClaims("2. The device of claim 1, wherein the sensor is optical.");
  assert.ok(findings.some((finding) => finding.ruleId === "claims.independent"));
});
