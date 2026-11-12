import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";

function textOf(result: unknown): string {
  if (result === null || typeof result !== "object" || !("content" in result)) {
    throw new Error("tool result has no content");
  }
  const content: unknown = result.content;
  if (!Array.isArray(content) || content.length === 0) {
    throw new Error("tool result content is empty");
  }
  const first: unknown = content[0];
  if (
    first === null ||
    typeof first !== "object" ||
    !("type" in first) ||
    first.type !== "text" ||
    !("text" in first) ||
    typeof first.text !== "string"
  ) {
    throw new Error("expected a text content block");
  }
  return first.text;
}

test("server registers the full tool surface", async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  await server.connect(serverTransport);
  const client = new Client({ name: "ip-test", version: "1.0.0" });
  await client.connect(clientTransport);

  const { tools } = await client.listTools();
  const names = new Set(tools.map((tool) => tool.name));
  for (const expected of [
    "credential_status",
    "concept_assessment",
    "patents_search",
    "patent_get",
    "patent_documents",
    "patent_family",
    "trademarks_search",
    "trademark_get",
    "trademark_documents",
    "prior_art_report",
    "prior_art_search",
    "patent_read",
    "drawing_spec",
    "drawing_validate",
    "drawing_rules",
    "application_draft",
    "claims_draft",
    "application_lint",
    "disclosure_review",
    "attorney_packet",
    "index_build",
  ]) {
    assert.ok(names.has(expected), `missing tool ${expected}`);
  }

  const status = await client.callTool({ name: "credential_status", arguments: {} });
  const payload = JSON.parse(textOf(status)) as { providers: Array<{ provider: string; configured: boolean }>; allowUnofficial: boolean };
  // Was 6; the paper, preprint, and code sources add openalex, arxiv, and github.
  assert.equal(payload.providers.length, 9);
  for (const name of ["odp", "tsdr", "ops", "ppubs", "tmsearch", "index", "openalex", "arxiv", "github"]) {
    assert.ok(payload.providers.some((entry) => entry.provider === name), `missing provider ${name}`);
  }
  assert.equal(payload.allowUnofficial, false);

  await client.close();
  await server.close();
});

test("drawing_spec output validates cleanly over the wire", async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  await server.connect(serverTransport);
  const client = new Client({ name: "ip-test", version: "1.0.0" });
  await client.connect(clientTransport);

  const specResult = await client.callTool({
    name: "drawing_spec",
    arguments: {
      sheet: {
        title: "Test sheet",
        inventor: "Ada Lovelace",
        figures: [
          {
            label: "FIG. 1",
            elements: [
              { type: "rect", x: 40, y: 40, width: 60, height: 40 },
              { type: "reference", x: 70, y: 60, number: 10 },
            ],
          },
        ],
      },
    },
  });
  const spec = JSON.parse(textOf(specResult)) as { svg: string };

  const validateResult = await client.callTool({
    name: "drawing_validate",
    arguments: { svg: spec.svg, descriptionText: "A housing 10." },
  });
  const report = JSON.parse(textOf(validateResult)) as { ok: boolean; findings: Array<{ severity: string }> };
  assert.equal(report.ok, true, JSON.stringify(report.findings));
  assert.deepEqual(report.findings.filter((finding) => finding.severity === "error"), []);

  await client.close();
  await server.close();
});

test("missing credentials produce an actionable error, not a crash", async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  await server.connect(serverTransport);
  const client = new Client({ name: "ip-test", version: "1.0.0" });
  await client.connect(clientTransport);

  const result = await client.callTool({
    name: "trademark_get",
    arguments: { identifier: "87454105" },
  });
  assert.equal(result.isError, true);
  const payload = JSON.parse(textOf(result)) as { code: string; hint: string };
  assert.equal(payload.code, "CREDENTIAL_MISSING");
  assert.match(payload.hint, /api-manager/);

  await client.close();
  await server.close();
});

test("concurrent tool calls all complete (no hang under parallel load)", async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  await server.connect(serverTransport);
  const client = new Client({ name: "ip-test", version: "1.0.0" });
  await client.connect(clientTransport);

  const calls = [
    ...Array.from({ length: 12 }, (_, index) =>
      client.callTool({ name: "disclosure_review", arguments: { disclosureDate: `2026-0${(index % 9) + 1}-01`, byInventor: true } }),
    ),
    ...Array.from({ length: 4 }, () => client.callTool({ name: "credential_status", arguments: {} })),
    ...Array.from({ length: 4 }, () => client.callTool({ name: "patent_read", arguments: { numbers: ["9765584"] } })),
  ];
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("parallel calls did not finish within 10 s")), 10_000);
  });
  const results = await Promise.race([Promise.all(calls), deadline]);
  clearTimeout(timer);
  assert.equal(results.length, 20);
  const read = JSON.parse(textOf(results[19])) as { readings: Array<{ ok: boolean; error?: { code?: string } }> };
  assert.equal(read.readings[0]?.ok, false);
  assert.equal(read.readings[0]?.error?.code, "CREDENTIAL_MISSING");

  await client.close();
  await server.close();
});

test("disclosure_review applies the cited foreign grace table over the wire", async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  await server.connect(serverTransport);
  const client = new Client({ name: "ip-test", version: "1.0.0" });
  await client.connect(clientTransport);
  const result = await client.callTool({
    name: "disclosure_review",
    arguments: { disclosureDate: "2026-06-01", byInventor: true, plannedFilingDate: "2026-12-01" },
  });
  const payload = JSON.parse(textOf(result)) as { jurisdictions: Array<{ code: string; status: string; citation?: string }> };
  const byCode = new Map(payload.jurisdictions.map((entry) => [entry.code, entry]));
  assert.equal(byCode.get("JP")?.status, "open");
  assert.equal(byCode.get("EP")?.status, "no-grace");
  assert.match(byCode.get("CA")?.citation ?? "", /28\.2/);
  await client.close();
  await server.close();
});
