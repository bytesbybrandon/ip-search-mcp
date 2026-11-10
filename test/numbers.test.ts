import assert from "node:assert/strict";
import test from "node:test";
import {
  applicationNumberText,
  normalizeRegistration,
  normalizeSerial,
  parsePatentNumber,
  patentQueryVariants,
} from "../src/numbers.js";

test("classifies a seven-digit grant", () => {
  const parsed = parsePatentNumber("6,103,599");
  assert.equal(parsed.kind, "grant");
  assert.equal(parsed.digits, "6103599");
  assert.equal(parsed.display, "6,103,599");
});

test("classifies an eight-digit application written with a slash", () => {
  const parsed = parsePatentNumber("15/234,567");
  assert.equal(parsed.kind, "application");
  assert.equal(parsed.digits, "15234567");
  assert.equal(parsed.display, "15/234,567");
});

test("classifies a publication number", () => {
  const parsed = parsePatentNumber("US 2020/0123456 A1");
  assert.equal(parsed.kind, "publication");
  assert.equal(parsed.digits, "20200123456");
  assert.equal(parsed.display, "US 2020/0123456 A1");
});

test("flags an eight-digit value that fits both series codes and grants", () => {
  const parsed = parsePatentNumber("10123456");
  assert.equal(parsed.kind, "ambiguous");
  assert.deepEqual(
    parsed.alternatives.map((entry) => entry.kind).sort(),
    ["application", "grant"],
  );
});

test("query variants cover both readings of an ambiguous number", () => {
  const variants = patentQueryVariants("10123456");
  assert.ok(variants.includes("10123456"));
  assert.ok(variants.includes("10,123,456"));
  assert.ok(variants.includes("10/123,456"));
});

test("applicationNumberText rejects a grant", () => {
  assert.throws(() => applicationNumberText("9,765,584"), /not an application number/);
});

test("serial and registration normalization", () => {
  assert.equal(normalizeSerial("SN 87,454,105"), "87454105");
  assert.equal(normalizeRegistration("RN 6096739"), "6096739");
  assert.throws(() => normalizeSerial("1234"), /8 digits/);
});

test("PCT numbers keep their shape", () => {
  const parsed = parsePatentNumber("PCT/US2020/012345");
  assert.equal(parsed.kind, "pct");
  assert.equal(parsed.display, "PCT/US2020/012345");
});
