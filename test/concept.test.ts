import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { withOdp } from "./odp-stub.js";

test("concept_assessment reports each patent's own dates, not the grant date as the only one", async () => {
  await withOdp(9_900_000, async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer();
    await server.connect(serverTransport);
    const client = new Client({ name: "ip-test", version: "1.0.0" });
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({
        name: "concept_assessment",
        arguments: { concept: "A handheld optical sensor that recalibrates itself against a sealed reference surface when drift exceeds a threshold." },
      });
      const content = (result.content as Array<{ text: string }>)[0]!;
      const payload = JSON.parse(content.text) as { closestPatents: Array<{ hit: Record<string, string | undefined> }> };
      const hit = payload.closestPatents[0]?.hit;
      assert.ok(hit, "the stubbed patents came back as closest hits");
      assert.equal(hit.effectiveFilingDate, "2017-06-01");
      assert.equal(hit.filingDate, "2018-05-14");
      assert.equal(hit.publicationDate, "2018-11-15");
      assert.equal(hit.grantDate, "2023-09-12");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
