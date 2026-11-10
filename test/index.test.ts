import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildIndex, indexStatus, searchPatents, searchTrademarks } from "../src/providers/index.js";

const fixtures = new URL("../../test/fixtures", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

test("builds an FTS index over patent and trademark bulk XML", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ip-index-"));
  const dbPath = join(dir, "test.sqlite");
  const result = await buildIndex(fixtures, dbPath);
  assert.equal(result.patents, 1);
  assert.equal(result.trademarks, 1);

  const status = indexStatus(dbPath);
  assert.equal(status.patents, 1);
  assert.equal(status.trademarks, 1);
  assert.ok(status.builtAt);

  const patentHits = searchPatents("calibrating", { dbPath });
  assert.equal(patentHits.hits.length, 1);
  assert.equal(patentHits.hits[0]?.number, "9765584");
  assert.match(patentHits.hits[0]?.title ?? "", /optical sensor/i);
  assert.equal(patentHits.hits[0]?.provenance.provider, "index");

  const inRange = searchPatents("calibrating", { dbPath, from: "2009-01-01", to: "2011-12-31" });
  assert.equal(inRange.hits.length, 1);
  const outOfRange = searchPatents("calibrating", { dbPath, from: "2020-01-01" });
  assert.equal(outOfRange.hits.length, 0);

  const trademarkHits = searchTrademarks("acme", { dbPath });
  assert.equal(trademarkHits.hits.length, 1);
  assert.equal(trademarkHits.hits[0]?.markText, "ACME GIZMO");
  assert.deepEqual(trademarkHits.hits[0]?.internationalClasses, [9]);

  await rm(dir, { recursive: true, force: true });
});

test("status of a missing index reports absence instead of throwing", () => {
  const status = indexStatus(join(tmpdir(), "does-not-exist-ip-index.sqlite"));
  assert.equal(status.exists, false);
});
