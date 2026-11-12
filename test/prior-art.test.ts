import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { config } from "../src/config.js";
import { priorArtSearch } from "../src/research.js";

// A stand-in for the USPTO Open Data Portal: 30 made-up optical-sensor
// applications for any title query, the one cited patent by number, and the
// real-shaped grant full text for every dataset file.
const FULL_TEXT = readFileSync(new URL("../../test/fixtures-fulltext/grant-fulltext.xml", import.meta.url), "utf8");
const BASE = "https://api.uspto.gov";

function wrapper(number: number, title: string): Record<string, unknown> {
  return {
    applicationNumberText: String(15_000_000 + number),
    applicationMetaData: { patentNumber: String(number), inventionTitle: title, grantDate: "2020-01-07", applicationStatusDescriptionText: "Patented Case" },
    grantDocumentMetaData: { fileLocationURI: `${BASE}/api/v1/datasets/products/files/grants/${number}.xml` },
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

// Each test uses its own patent-number range: responses are cached on disk, and a read
// that an earlier test cached would not reach the stub or be counted.
async function withOdp<T>(firstNumber: number, run: (stats: { fullTextReads: number }) => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  const stats = { fullTextReads: 0 };
  Object.assign(config.providers.odp, { key: "example-key" });
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.pathname.startsWith("/api/v1/datasets/")) {
      stats.fullTextReads += 1;
      return new Response(FULL_TEXT, { status: 200, headers: { "content-type": "application/xml" } });
    }
    if (url.pathname.includes("/oa/")) return json({ response: { docs: [] } });
    const q = (JSON.parse(String(init?.body ?? "{}")) as { q?: string }).q ?? "";
    if (q.startsWith("applicationMetaData.patentNumber:")) return json({ count: 1, patentFileWrapperDataBag: [wrapper(7_000_001, "Optical sensor reference cited earlier")] });
    return json({ count: 30, patentFileWrapperDataBag: Array.from({ length: 30 }, (_, index) => wrapper(firstNumber + index, `Optical sensor assembly ${index + 1}`)) });
  };
  try {
    return await run(stats);
  } finally {
    globalThis.fetch = realFetch;
    Object.assign(config.providers.odp, { key: undefined });
  }
}

test("hydrate is a hard cap on full texts read, counting the citation wave", async () => {
  await withOdp(9_100_000, async (stats) => {
    const result = await priorArtSearch({ queries: ["optical AND sensor", "reference AND surface"], sources: ["patents"], hydrate: 4 });
    assert.equal(stats.fullTextReads, 4);
    assert.equal(result.results.filter((candidate) => candidate.textRead === "claims").length, 4);
    assert.ok(result.results.some((candidate) => candidate.id === "US7000001"), "the cited patent joined the pool");
  });
});

test("hydrate 0 reads no full text and expand off keeps the whole budget for the first wave", async () => {
  await withOdp(9_200_000, async (stats) => {
    await priorArtSearch({ queries: ["optical AND sensor"], sources: ["patents"], hydrate: 0 });
    assert.equal(stats.fullTextReads, 0);
    await priorArtSearch({ queries: ["optical AND sensor NOT cited"], sources: ["patents"], hydrate: 5, expand: false });
    assert.equal(stats.fullTextReads, 5);
  });
});

test("a NOT query is satisfied only by documents without the excluded word", async () => {
  await withOdp(9_300_000, async () => {
    const result = await priorArtSearch({ queries: ["optical AND sensor NOT housing"], sources: ["patents"], hydrate: 4, limit: 40 });
    const read = result.results.filter((candidate) => candidate.textRead === "claims");
    const unread = result.results.filter((candidate) => candidate.textRead === "title");
    assert.ok(read.length > 0 && unread.length > 0);
    for (const candidate of read) assert.deepEqual(candidate.matchedQueries, [], `${candidate.id} mentions housing in its full text`);
    for (const candidate of unread) assert.equal(candidate.matchedQueries.length, 1, `${candidate.id} has no excluded word`);
    assert.ok(Math.min(...unread.map((candidate) => candidate.score)) > Math.max(...read.map((candidate) => candidate.score)), "documents with the excluded word rank below those without");
  });
});
