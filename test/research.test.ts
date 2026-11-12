import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  bestPassage,
  generateQueries,
  keyTerms,
  matchesAll,
  parseBoolean,
  rankDocuments,
  plainQuery,
  stem,
  wildcard,
} from "../src/domain/relevance.js";
import { estimateTerm } from "../src/domain/term.js";
import { arxivQuery, parseArxivFeed } from "../src/providers/arxiv.js";
import { cpcQuery, parseFullTextXml } from "../src/providers/odp.js";
import { abstractFromIndex } from "../src/providers/openalex.js";
import { mapLimit, priorArtSearch, topCpc } from "../src/research.js";
import { parseRegQuery } from "../src/util/winenv.js";

const SENSOR =
  "A handheld optical sensor recalibrates itself against a sealed reference surface. The optical sensor measures drift; " +
  "when drift exceeds a threshold, the sensor recalibrates against the reference surface. The reference surface sits in a " +
  "sealed chamber so the optical sensor can recalibrate in the field.";

test("stemming merges inflections that queries must treat as one term", () => {
  for (const [a, b] of [
    ["calibration", "calibrating"],
    ["measured", "measuring"],
    ["sensors", "sensor"],
    ["optical", "optics"],
    ["indexes", "index"],
  ] as const) {
    assert.equal(stem(a), stem(b), `${a} vs ${b}`);
  }
});

test("key terms rank content words and drop boilerplate", () => {
  const terms = keyTerms(SENSOR, 6).map((term) => term.term);
  assert.equal(terms[0], "sensor");
  assert.ok(terms.includes("reference"));
  assert.ok(!terms.includes("the") && !terms.includes("when") && !terms.includes("sits"));
});

test("generated queries are several narrow AND queries, not one any-term query", () => {
  const generated = generateQueries(SENSOR);
  assert.ok(generated.patentQueries.length >= 6);
  assert.ok(generated.patentQueries.every((query) => query.includes(" AND ") || query.startsWith('"')));
  assert.ok(generated.patentQueries.some((query) => /recalibrat\*/.test(query)));
  assert.ok(generated.phrases.includes("optical sensor") || generated.phrases.includes("reference surface"));
  assert.ok(generated.textQueries.length >= 1);
});

test("short stems query both forms instead of a broad prefix", () => {
  assert.equal(wildcard({ term: "arms", stem: "arm", weight: 1 }), "(arm OR arms)");
  assert.equal(wildcard({ term: "calibration", stem: "calibrat", weight: 1 }), "calibrat*");
  assert.equal(wildcard({ term: "lens", stem: "lens", weight: 1 }), "lens");
});

test("boolean queries enforce AND, OR, phrases, and prefixes", () => {
  const clauses = parseBoolean('"reference surface" AND (drift OR offset) AND recalibrat*');
  assert.deepEqual(clauses, [["reference surface"], ["drift", "offset"], ["recalibrat*"]]);
  assert.equal(matchesAll(clauses, "The reference surface corrects offset; it recalibrates."), true);
  assert.equal(matchesAll(clauses, "A surface reference corrects offset and recalibrates."), false, "phrase order matters");
  assert.equal(matchesAll(clauses, "The reference surface corrects offset."), false, "every AND clause must match");
  assert.deepEqual(parseBoolean("optical sensor"), [["optical"], ["sensor"]], "bare words are ANDed");
});

test("claims-weighted ranking puts the document that claims the idea first", () => {
  const terms = keyTerms(SENSOR, 6);
  const ranked = rankDocuments(
    [
      { id: "unrelated", fields: { title: "Ice maker with auger", claims: "An ice maker comprising an auger." } },
      { id: "mentions", fields: { title: "Camera module", body: "An optical sensor may drift." } },
      { id: "claims", fields: { title: "Sensor housing", claims: "An optical sensor that recalibrates against a sealed reference surface when drift exceeds a threshold." } },
    ],
    terms,
  );
  assert.deepEqual(ranked.map((result) => result.id), ["claims", "mentions", "unrelated"]);
  assert.ok(ranked[0]!.matched.includes("reference"));
  assert.equal(ranked[2]!.score, 0);
});

test("best passage explains an overlap with shared terms", () => {
  const terms = keyTerms(SENSOR, 6);
  const passage = bestPassage("A lid closes. The optical sensor recalibrates against the reference surface. A strap holds it.", terms);
  assert.match(passage.passage, /reference surface/);
  assert.ok(passage.shared.length >= 3);
});

test("full-text grant XML yields claims, dependencies, independents, and citations", () => {
  const xml = readFileSync(new URL("../../test/fixtures-fulltext/grant-fulltext.xml", import.meta.url), "utf8");
  const text = parseFullTextXml(xml);
  assert.equal(text.documentNumber, "9765584");
  assert.equal(text.kind, "B2");
  assert.equal(text.title, "Self-calibrating optical sensor housing");
  assert.equal(text.claims.length, 3);
  assert.deepEqual(text.claims.filter((claim) => claim.independent).map((claim) => claim.number), [1, 3]);
  assert.deepEqual(text.claims[1]?.dependsOn, [1]);
  assert.match(text.claims[0]?.text ?? "", /^1\. A sensor assembly comprising: a housing;/);
  assert.deepEqual(text.citedUs, ["7000001"]);
  assert.equal(text.citedOtherCount, 2);
  assert.match(text.description ?? "", /stored value & records/);
  assert.match(text.abstract ?? "", /sealed reference surface/);
});

test("CPC queries keep ODP's padded symbol form", () => {
  assert.equal(cpcQuery("G01B  11/00"), 'applicationMetaData.cpcClassificationBag:"G01B  11/00"');
  const wrappers = [
    { applicationMetaData: { cpcClassificationBag: ["G01B  11/00", "G02B   7/00"] } },
    { applicationMetaData: { cpcClassificationBag: ["G01B  11/00"] } },
    { applicationMetaData: { cpcClassificationBag: ["G02B   7/00", "H04N   5/00"] } },
  ];
  assert.deepEqual(topCpc(wrappers), ["G01B  11/00", "G02B   7/00"]);
});

test("patent term estimate: in force, lapsed, expired, pending", () => {
  const granted = estimateTerm({ filingDate: "2019-03-11", grantDate: "2021-06-01", ptaDays: 120, status: "Patented Case", events: [{ description: "Payment of Maintenance Fee, 4th Year, Large Entity" }], today: "2026-11-11" });
  assert.equal(granted.inForce, "in-force");
  assert.equal(granted.estimatedExpiry, "2039-07-09");
  assert.deepEqual(granted.maintenance.map((fee) => fee.state), ["paid", "due-later", "due-later"]);

  const lapsed = estimateTerm({ filingDate: "2012-08-20", grantDate: "2016-02-02", status: "Patent Expired Due to NonPayment of Maintenance Fees Under 37 CFR 1.362", events: [{ date: "2020-03-09", description: "Expire Patent" }], today: "2026-11-11" });
  assert.equal(lapsed.inForce, "lapsed");

  const unpaid = estimateTerm({ filingDate: "2012-01-01", grantDate: "2014-01-01", status: "Patented Case", events: [], today: "2026-11-11" });
  assert.equal(unpaid.inForce, "uncertain", "a missing payment event alone is not proof of lapse while ODP records no expiry");

  const smallEntity = estimateTerm({ filingDate: "2014-02-01", grantDate: "2016-03-01", status: "Patented Case", events: [{ description: "Payment of Maintenance Fee, 4th Yr, Small Entity" }, { description: "7.5 yr surcharge - late pmt w/in 6 mo, Small Entity" }], today: "2026-11-11" });
  assert.equal(smallEntity.inForce, "in-force");
  assert.deepEqual(smallEntity.maintenance.map((fee) => fee.state), ["paid", "paid", "due-later"]);

  const reinstated = estimateTerm({ filingDate: "2012-05-01", grantDate: "2015-05-05", status: "Patented Case", events: [{ date: "2019-06-01", description: "Expire Patent" }, { date: "2019-09-01", description: "Petition Decision - Accept Late Payment of Maintenance Fees - Granted" }, { description: "Payment of Maintenance Fee, 4th Year, Large Entity" }, { description: "Payment of Maintenance Fee, 8th Year, Large Entity" }], today: "2026-11-11" });
  assert.equal(reinstated.inForce, "in-force");

  const design = estimateTerm({ applicationType: "DES", filingDate: "2016-01-04", grantDate: "2018-02-06", status: "Patented Case", today: "2026-11-11" });
  assert.equal(design.inForce, "in-force");
  assert.equal(design.estimatedExpiry, "2033-02-06");
  assert.equal(design.maintenance.length, 0);

  const old = estimateTerm({ filingDate: "2001-01-01", grantDate: "2004-01-01", status: "Patented Case", events: ["4th", "8th", "12th"].map((year) => ({ description: `Payment of Maintenance Fee, ${year} Year, Large Entity` })), today: "2026-11-11" });
  assert.equal(old.inForce, "expired");

  const continuation = estimateTerm({ filingDate: "2018-05-14", earliestNonProvisionalDate: "2014-09-30", grantDate: "2020-01-07", status: "Patented Case", events: [{ description: "Payment of Maintenance Fee, 4th Year, Large Entity" }], today: "2026-11-11" });
  assert.equal(continuation.estimatedExpiry, "2034-09-30", "term runs from the earliest non-provisional parent");

  assert.equal(estimateTerm({ status: "Docketed New Case - Ready for Examination" }).inForce, "pending");
  assert.equal(estimateTerm({ status: "Abandoned -- Failure to Respond to an Office Action" }).inForce, "abandoned");
});

test("arXiv feed and query translation", () => {
  assert.equal(arxivQuery('"optical sensor" AND drift'), 'all:"optical sensor" AND all:drift');
  assert.equal(arxivQuery('"reference surface" AND (drift OR offset) AND recalibrat* NOT camera'), 'all:"reference surface" AND all:drift OR all:offset AND all:recalibrat ANDNOT all:camera');
  assert.equal(plainQuery('applicationMetaData.cpcClassificationBag:"G01B  11/00" AND "reference surface" AND calibrat*'), '"reference surface" AND calibrat');
  const feed = `<feed><entry><id>http://arxiv.org/abs/2101.00001v1</id><published>2021-01-01T00:00:00Z</published>
    <title>Drift   correction for optical sensors</title><summary>We recalibrate &amp; correct drift.</summary>
    <author><name>A. Example</name></author></entry></feed>`;
  const hits = parseArxivFeed(feed, { provider: "arxiv", route: "test", retrievedAt: "now" });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.id, "arXiv:2101.00001v1");
  assert.equal(hits[0]?.title, "Drift correction for optical sensors");
  assert.equal(hits[0]?.summary, "We recalibrate & correct drift.");
  assert.equal(hits[0]?.date, "2021-01-01");
});

test("OpenAlex inverted abstracts are rebuilt in order", () => {
  assert.equal(abstractFromIndex({ sensor: [1], optical: [0], drifts: [2] }), "optical sensor drifts");
  assert.equal(abstractFromIndex(undefined), undefined);
});

test("Windows user environment parsing keeps only allowlisted names", () => {
  const output = [
    "",
    "HKEY_CURRENT_USER\\Environment",
    "    Path    REG_EXPAND_SZ    C:\\tools",
    "    USPTO_ODP_API_KEY    REG_SZ    example-odp-value",
    "    UNRELATED_SECRET    REG_SZ    keep-out",
    "    GITHUB_TOKEN    REG_SZ    not-allowlisted",
    "    OPENALEX_API_KEY    REG_SZ    ",
    "",
  ].join("\r\n");
  assert.deepEqual(parseRegQuery(output), { USPTO_ODP_API_KEY: "example-odp-value" });
});

test("mapLimit keeps order and bounds concurrency", async () => {
  let inFlight = 0;
  let peak = 0;
  const out = await mapLimit([5, 1, 4, 2, 3], 2, async (value) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, value));
    inFlight -= 1;
    return value * 10;
  });
  assert.deepEqual(out, [50, 10, 40, 20, 30]);
  assert.ok(peak <= 2);
});

test("prior-art search without an ODP key reports the setup step and still returns", async () => {
  const result = await priorArtSearch({ description: SENSOR, sources: ["patents"] });
  assert.equal(result.results.length, 0);
  assert.ok(result.notes.some((note) => /USPTO_ODP_API_KEY not set/.test(note)));
  assert.ok(result.queries.patent.length > 0);
  await assert.rejects(() => priorArtSearch({}), /description or at least one query/);
});

test("rate limiter spaces requests by the minimum interval", async () => {
  const { RateLimiter } = await import("../src/util/rate.js");
  const limiter = new RateLimiter(20, 60);
  const started = Date.now();
  const stamps: number[] = [];
  await Promise.all([1, 2, 3].map(async () => {
    await limiter.acquire();
    stamps.push(Date.now() - started);
  }));
  stamps.sort((a, b) => a - b);
  assert.ok(stamps[1]! - stamps[0]! >= 55 && stamps[2]! - stamps[1]! >= 55, `stamps ${stamps.join(",")}`);
});
