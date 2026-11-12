# ip-axi

Vet a new idea from the command line: prior-art search with claim reading, freedom-to-operate charts, a check of your own pages for earlier disclosure, and patent and trademark research. Runs the tools from [`ip-search-mcp`](https://www.npmjs.com/package/ip-search-mcp).

## Fastest way to use it

**Tell your agent:** use `npx -y ip-axi`

```bash
npx -y ip-axi
```

That prints which data sources are configured. Nothing to install first.

## Common tasks

```bash
# Vet each feature of an idea: closest art, claim charts, page check, recommendation
npx -y ip-axi vet @features.md --sites https://example.com/

# Search prior art from a description (patents, papers, preprints, code)
npx -y ip-axi prior-art search "A handheld optical sensor that recalibrates against a sealed reference surface" --fields why

# Read a patent: independent claims, owner, status, estimated expiry
npx -y ip-axi patents read 9765584

# Chart a feature against a patent's claim elements
npx -y ip-axi fto chart 9765584 --feature @feature.md

# Find when your own pages first showed a feature
npx -y ip-axi disclosure scan https://example.com/ --signature "Recalibrate now"

# Search patents and look up a trademark
npx -y ip-axi patents search "optical sensor" --limit 5
npx -y ip-axi trademarks get 87454105
```

`vet` takes the exact strings that would show a feature with `--signature "text one;text two"` (or `--signatures-file @signatures.txt`), and says plainly when a source failed or a check could not run.

## Configuration

Requires Node 24 or newer. Provider keys are optional: `USPTO_ODP_API_KEY`, `USPTO_TSDR_API_KEY`, and optionally `EPO_OPS_CLIENT_ID` with `EPO_OPS_CLIENT_SECRET`. Patent prior-art search needs the free `USPTO_ODP_API_KEY`; papers, preprints, and code search work without keys.

## Reference

Every command and flag: [skills/ip-axi/SKILL.md](https://github.com/bytesbybrandon/ip-search-mcp/blob/main/skills/ip-axi/SKILL.md). Project page and source: https://bytesbybrandon.github.io/ip-search-mcp/ and https://github.com/bytesbybrandon/ip-search-mcp.

Nothing here files, signs, or submits an application. Output is research and drafts for review by a licensed practitioner, not legal advice.

MIT licensed.
