import assert from "node:assert/strict";
import test from "node:test";
import { priorArtSearch } from "../src/research.js";
import { withOdp } from "./odp-stub.js";

test("citation expansion adds cited and citing patents to the pool", async () => {
  await withOdp(
    9_400_000,
    async () => {
      const result = await priorArtSearch({ queries: ["optical AND sensor", "reference AND surface"], sources: ["patents"], hydrate: 6, limit: 100 });
      const cited = result.results.find((candidate) => candidate.id === "US7000001");
      assert.ok(cited?.foundBy.includes("cited by a top hit"), "a patent cited by a top hit joined the pool");
      const citing = result.results.find((candidate) => candidate.id === "US-APP-15999001");
      assert.ok(citing?.foundBy.includes("cites a top hit (examiner)"), "an application whose examiner cited a top hit joined the pool");
      assert.equal(citing?.url, "https://patentcenter.uspto.gov/applications/15999001", "an unpublished application links to Patent Center, not a Google Patents page that does not exist");
      assert.match(cited?.url ?? "", /^https:\/\/patents\.google\.com\/patent\/US7000001$/);
      const lookups = result.runs.filter((run) => run.query.startsWith("examiner citations of US"));
      assert.ok(lookups.length > 0 && lookups.every((run) => !run.error && run.count === 1), JSON.stringify(lookups));
    },
    { citing: ["15999001"] },
  );
});

test("a failed forward-citation lookup is reported as a run with its error, not swallowed", async () => {
  await withOdp(
    9_500_000,
    async () => {
      const result = await priorArtSearch({ queries: ["optical AND sensor AND drift", "reference AND surface AND drift"], sources: ["patents"], hydrate: 6, limit: 100 });
      const failed = result.runs.filter((run) => run.query.startsWith("examiner citations of US"));
      assert.ok(failed.length > 0 && failed.every((run) => run.error && run.count === 0), JSON.stringify(failed));
      assert.ok(result.results.some((candidate) => candidate.id === "US7000001"), "backward citations still joined the pool");
      assert.ok(!result.results.some((candidate) => candidate.id.startsWith("US-APP-")), "no citing application was invented");
    },
    { citationStatus: 400 },
  );
});
