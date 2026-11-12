import assert from "node:assert/strict";
import test from "node:test";
import { priorArtSearch } from "../src/research.js";
import { searchWorks } from "../src/providers/openalex.js";

async function withFetch<T>(handler: () => Response, run: (calls: { count: number }) => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  const calls = { count: 0 };
  globalThis.fetch = async () => {
    calls.count += 1;
    return handler();
  };
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("a provider that asks for a long wait is skipped and reported, not waited for", async () => {
  await withFetch(
    () => new Response("{}", { status: 429, headers: { "retry-after": "3600" } }),
    async (calls) => {
      const started = Date.now();
      await assert.rejects(() => searchWorks("optical sensor drift", 5), (error: unknown) => {
        const failure = error as { code?: string; message?: string };
        return failure.code === "RATE_LIMITED" && /asked to wait 3600 s/.test(failure.message ?? "");
      });
      assert.equal(calls.count, 1, "no retry after a wait the server will not honor");
      assert.ok(Date.now() - started < 2_000);
    },
  );
});

test("a rate-limited paper source becomes a failed run while the search still returns", async () => {
  await withFetch(
    () => new Response("{}", { status: 429, headers: { "retry-after": "86400" } }),
    async () => {
      const started = Date.now();
      const result = await priorArtSearch({ queries: ["optical AND sensor AND drift"], sources: ["papers"] });
      assert.ok(Date.now() - started < 5_000, "the search must not sleep for the provider's Retry-After");
      const run = result.runs.find((entry) => entry.source === "openalex");
      assert.ok(run?.error && /rate limit exceeded/.test(run.error), JSON.stringify(result.runs));
      assert.equal(result.results.length, 0);
    },
  );
});

test("a short Retry-After is still honored and the request retried", async () => {
  let answered = false;
  await withFetch(
    () => {
      if (answered) return new Response(JSON.stringify({ results: [{ id: "W1", title: "Optical drift correction", publication_date: "2021-01-01" }] }), { status: 200, headers: { "content-type": "application/json" } });
      answered = true;
      return new Response("{}", { status: 429, headers: { "retry-after": "0" } });
    },
    async (calls) => {
      const hits = await searchWorks("optical sensor retry", 5);
      assert.equal(calls.count, 2);
      assert.equal(hits[0]?.title, "Optical drift correction");
    },
  );
});
