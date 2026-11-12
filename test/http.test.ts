import assert from "node:assert/strict";
import test from "node:test";
import { priorArtSearch } from "../src/research.js";
import { config } from "../src/config.js";
import { searchRepositories } from "../src/providers/github.js";
import { searchWorks } from "../src/providers/openalex.js";

async function withFetch<T>(handler: (url: URL, init?: RequestInit) => Response, run: (calls: { count: number }) => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  const calls = { count: 0 };
  globalThis.fetch = async (input, init) => {
    calls.count += 1;
    return handler(new URL(typeof input === "string" || input instanceof URL ? input : input.url), init);
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

test("GitHub search asks for public repositories only, with or without a token", async () => {
  const seen: Array<{ q: string | null; authorization: string | null }> = [];
  const handler = (url: URL, init?: RequestInit): Response => {
    seen.push({ q: url.searchParams.get("q"), authorization: new Headers(init?.headers).get("authorization") });
    return new Response(JSON.stringify({ items: [{ full_name: "example/optical-sensor", html_url: "https://github.com/example/optical-sensor", created_at: "2020-02-02T00:00:00Z" }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  await withFetch(handler, async () => {
    const hits = await searchRepositories('"reference surface" AND optical sensor NOT camera', 5);
    assert.equal(hits[0]?.id, "example/optical-sensor");
    Object.assign(config.providers.github, { key: "example-token" });
    try {
      await searchRepositories("optical sensor drift", 5);
    } finally {
      Object.assign(config.providers.github, { key: undefined });
    }
  });
  assert.equal(seen[0]?.q, '"reference surface" optical sensor NOT camera is:public');
  assert.equal(seen[0]?.authorization, null);
  assert.equal(seen[1]?.q, "optical sensor drift is:public");
  assert.equal(seen[1]?.authorization, "Bearer example-token", "a token is still sent, but never widens the search past public repositories");
});
