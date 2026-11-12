# ip-axi

AXI CLI for patent and trademark research. Runs the tools from [`ip-search-mcp`](https://www.npmjs.com/package/ip-search-mcp).

```bash
npx -y ip-axi
npx -y ip-axi patents search "optical sensor" --limit 5
npx -y ip-axi trademarks get 87454105
```

Requires Node 24 or newer. Provider keys are optional: `USPTO_ODP_API_KEY`, `USPTO_TSDR_API_KEY`, and optionally `EPO_OPS_CLIENT_ID` with `EPO_OPS_CLIENT_SECRET`.

Nothing here files, signs, or submits an application. Output is research and drafts for review by a licensed practitioner.

MIT licensed.
