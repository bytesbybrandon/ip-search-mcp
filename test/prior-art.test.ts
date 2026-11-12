import assert from "node:assert/strict";
import test from "node:test";
import { priorArtSearch } from "../src/research.js";
import { withOdp } from "./odp-stub.js";

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
