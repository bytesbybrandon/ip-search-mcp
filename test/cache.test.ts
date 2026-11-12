import assert from "node:assert/strict";
import { existsSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { config } from "../src/config.js";
import { cacheKey, evictCache, readCache, writeCache } from "../src/util/cache.js";

// The scratch cache directory is created per test process by test/setup.ts.
function entryPath(key: string): string {
  return join(config.cacheDir, key.slice(0, 2), `${key}.json`);
}

test("an expired entry is deleted when it is read", async () => {
  const key = cacheKey({ test: "expired" });
  await writeCache(key, "stale", "text/plain", 1);
  assert.ok(existsSync(entryPath(key)));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(await readCache(key), undefined);
  assert.equal(existsSync(entryPath(key)), false, "the expired file is removed, not left to accumulate");

  const live = cacheKey({ test: "live" });
  await writeCache(live, "fresh", "text/plain", 60_000);
  assert.equal((await readCache(live))?.body, "fresh");
  assert.ok(existsSync(entryPath(live)), "a live entry is kept");
});

test("the size cap evicts the oldest entries first and leaves other files alone", async () => {
  await evictCache(0);
  const keys = Array.from({ length: 6 }, (_, index) => cacheKey({ test: "cap", index }));
  for (const key of keys) await writeCache(key, "x".repeat(1_000), "text/plain", 60_000);
  const base = Date.now() / 1000 - 3_600;
  keys.forEach((key, index) => utimesSync(entryPath(key), base + index * 60, base + index * 60));
  const sizes = keys.map((key) => statSync(entryPath(key)).size);
  const bystander = join(config.cacheDir, "ip-index.sqlite");
  writeFileSync(bystander, "not a cache entry");

  await evictCache(sizes.slice(3).reduce((sum, size) => sum + size, 0));

  for (const key of keys.slice(0, 3)) assert.equal(existsSync(entryPath(key)), false, "the three oldest entries are evicted");
  for (const key of keys.slice(3)) assert.equal(existsSync(entryPath(key)), true, "the three newest entries stay");
  assert.ok(existsSync(bystander), "files that are not cache entries are never evicted");
  assert.ok(readdirSync(config.cacheDir).includes("ip-index.sqlite"));

  await evictCache(0);
  for (const key of keys) assert.equal(existsSync(entryPath(key)), false);
  assert.ok(existsSync(bystander));
});
