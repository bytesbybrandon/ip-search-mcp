import assert from "node:assert/strict";
import test from "node:test";
import { callTool, getClient, shutdown } from "../src/axi/client.js";

test("the in-process shell client allows a cold prior-art search far longer than the SDK's 60 s default", async () => {
  const client = await getClient();
  const seen: Array<{ timeout?: number } | undefined> = [];
  const original = client.callTool.bind(client);
  client.callTool = ((params, schema, options) => {
    seen.push(options);
    return original(params, schema, options);
  }) as typeof client.callTool;
  try {
    const payload = await callTool<{ providers: unknown[] }>("credential_status", {});
    assert.ok(payload.providers.length > 0);
    assert.equal(seen.length, 1);
    assert.ok((seen[0]?.timeout ?? 0) >= 5 * 60_000, `timeout was ${seen[0]?.timeout}`);
  } finally {
    client.callTool = original;
    await shutdown();
  }
});
