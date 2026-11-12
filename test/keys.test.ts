import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

// Many tool calls at once, with keys that live in the Windows user environment and a
// registry read that takes 300 ms. The child process runs the real path (config.ts
// readKey, then windowsUserEnv, then `reg.exe query HKCU\Environment`); only the
// executable is a stand-in that sleeps and logs each run. Linux only: it needs a POSIX
// shell for the stand-in and WSL detection by environment variable.
const CHILD = `
const [clientUrl, transportUrl, serverUrl] = process.argv.slice(1);
const { Client } = await import(clientUrl);
const { InMemoryTransport } = await import(transportUrl);
const { createServer } = await import(serverUrl);
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const server = createServer();
await server.connect(serverTransport);
const client = new Client({ name: "ip-test", version: "1.0.0" });
await client.connect(clientTransport);
const started = Date.now();
const calls = [
  ...Array.from({ length: 12 }, () => client.callTool({ name: "credential_status", arguments: {} })),
  ...Array.from({ length: 12 }, (_, index) => client.callTool({ name: "disclosure_review", arguments: { disclosureDate: "2026-0" + ((index % 9) + 1) + "-01", byInventor: true } })),
];
const results = await Promise.all(calls);
const status = JSON.parse(results[0].content[0].text);
console.log(JSON.stringify({ callMs: Date.now() - started, count: results.length, odp: status.providers.find((entry) => entry.provider === "odp").configured }));
await client.close();
await server.close();
`;

test("parallel tool calls share one cached Windows key read", { skip: process.platform !== "linux" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "ip-search-mcp-keys-"));
  const log = join(dir, "reg-runs.log");
  const fakeReg = join(dir, "reg.exe");
  writeFileSync(
    fakeReg,
    `#!/bin/sh\necho run >> "${log}"\nsleep 0.3\nprintf '\\nHKEY_CURRENT_USER\\\\Environment\\n    USPTO_ODP_API_KEY    REG_SZ    example-odp-value\\n'\n`,
  );
  chmodSync(fakeReg, 0o755);

  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH ?? ""}`, WSL_DISTRO_NAME: "example" };
  delete env.IP_WINDOWS_ENV;
  const resolve = (specifier: string): string => import.meta.resolve(specifier);
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      CHILD,
      resolve("@modelcontextprotocol/sdk/client/index.js"),
      resolve("@modelcontextprotocol/sdk/inMemory.js"),
      new URL("../src/server.js", import.meta.url).href,
    ],
    { env, encoding: "utf8", timeout: 20_000 },
  );
  assert.equal(child.status, 0, child.stderr);
  const outcome = JSON.parse(child.stdout.trim().split("\n").pop() ?? "{}") as { callMs: number; count: number; odp: boolean };

  assert.equal(outcome.odp, true, "the key came from the stand-in registry through the real read path");
  assert.equal(outcome.count, 24);
  assert.ok(outcome.callMs < 2_000, `parallel calls took ${outcome.callMs} ms`);
  assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 1, "the slow registry read ran once for the whole process, not once per key or per call");
});
