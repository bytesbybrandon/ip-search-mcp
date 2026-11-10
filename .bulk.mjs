import { readFileSync } from "node:fs";
import { homedir } from "node:os";
const cfg = JSON.parse(readFileSync(`${homedir()}/.agents/mcp.json`, "utf8"));
const key = cfg.mcpServers["ip-search-mcp"].env.USPTO_ODP_API_KEY;
const H = { "X-API-KEY": key, "content-type": "application/json" };

for (const body of [{}, { pagination: { offset: 0, limit: 100 } }]) {
  const res = await fetch("https://api.uspto.gov/api/v1/datasets/products/search", {
    method: "POST",
    headers: H,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  console.log("status", res.status, "bytes", text.length);
  if (res.ok) {
    const parsed = JSON.parse(text);
    const bag = parsed.bulkDataProductBag ?? parsed.products ?? [];
    console.log("count", parsed.count, "bag", bag.length);
    for (const p of bag.slice(0, 15)) {
      console.log([p.productIdentifier, p.productName, p.productFrequency, p.productTitle].join(" | "));
    }
    break;
  }
  console.log(text.slice(0, 300));
}
