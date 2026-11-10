# ip-search-mcp

MCP server for patent and trademark research plus review-only drafting of patent application artifacts.

It searches official and bulk-derived sources, keeps provenance on every hit, screens concepts for patentability and registrability signals, and produces drawings, claims, specifications, and an attorney packet. It never files, signs, or submits anything.

## Status

Working: ODP file wrapper, TSDR lookup, EPO OPS, local SQLite FTS index, 37 CFR 1.84 drawing generation and validation, claim parsing and linting, disclosure-clock arithmetic, concept assessment, attorney packet assembly.

Opt-in only: Patent Public Search and the Trademark Search backend. Both are undocumented USPTO surfaces with no published contract; enable with `IP_ALLOW_UNOFFICIAL=1` only if you accept that risk.

## Quickstart

```bash
pnpm install
pnpm build
node dist/src/index.js --help
```

Register it with an MCP client over stdio:

```json
{
  "mcpServers": {
    "ip-search-mcp": {
      "command": "node",
      "args": ["C:/Users/brand/Desktop/ip-search-mcp/dist/src/index.js"],
      "env": {
        "USPTO_ODP_API_KEY": "...",
        "USPTO_TSDR_API_KEY": "..."
      }
    }
  }
}
```

No keys are required to run; without them keyed tools return a `CREDENTIAL_MISSING` error with setup instructions, and unkeyed sources are what remain.

Where keys go, and how to verify them without printing their values:

```bash
node dist/src/index.js status
```

See `CREDENTIALS.md` for the MCP `env` block, shell variables, and `--env-file`.

## Tools

| Tool | Reads | Writes | Notes |
|------|-------|--------|-------|
| `credential_status` | yes | no | Provider table and required env vars |
| `concept_assessment` | yes | no | 101 screen, CPC/Nice guesses, closest hits, distinctiveness band |
| `patents_search` | yes | no | ODP, OPS, local index, opt-in PPUBS |
| `patent_get` | yes | no | File wrapper metadata, continuity, bibliographic data |
| `patent_documents` | yes | no | ODP prosecution document list |
| `patent_family` | yes | no | EPO OPS family |
| `trademarks_search` | yes | no | Candidates only; hydrate with `trademark_get` |
| `trademark_get` | yes | no | Authoritative TSDR status |
| `trademark_documents` | yes | no | TSDR documents and bundle PDF |
| `prior_art_report` | yes | no | Multi-query report with provenance and gaps |
| `drawing_spec` | no | optional file | Compliant SVG sheet |
| `drawing_validate` | yes | no | 37 CFR 1.84 findings with citations |
| `drawing_rules` | yes | no | Encoded rules and eCFR source |
| `application_draft` | no | optional file | Specification in examiner-expected order |
| `claims_draft` | no | no | Independent claim from supplied elements |
| `application_lint` | yes | no | Claim, abstract, and title checks |
| `disclosure_review` | yes | no | 102(b)(1) grace clock |
| `attorney_packet` | yes | optional file | Review packet |
| `index_build` | yes | yes | Local FTS5 index over bulk XML |

## Shell interface: `ip-axi`

An AXI-compliant CLI over the same tools, for shell use and scripted work.

```bash
node dist/src/axi/index.js                                  # live provider and index status
node dist/src/axi/index.js patents search "optical sensor" --limit 5
node dist/src/axi/index.js patents docs 19131214 --code CTNF
node dist/src/axi/index.js trademarks get 87454105
node dist/src/axi/index.js drawings validate ip/drawings/fig-1.svg --description @ip/specification.md
node dist/src/axi/index.js index build --from <dir-of-bulk-xml>
```

Run `npm link` once in the repo to put `ip-axi` on PATH; afterwards the bare command works from any directory. `pnpm exec ip-axi` also works inside the repo. `npx -y ip-axi` works only after the package is published.

Behavior: TOON output, totals on every list, `--fields` for extra columns, `--full` to stop truncation, exit codes 0 success / 1 error / 2 usage, structured errors on stdout with a fixing command, and a `next[]` block after every result.

`axi-axi validate` reports 11 pass, 0 fail, 1 warn on Windows. The warning is the validator's own limitation: it spawns `npm` without the `.cmd` suffix, so its skill freshness probe cannot start. `npm run skill:check` passes directly and is the real check.

## Local index

```bash
node dist/src/index.js index build --from <dir-of-xml> --db ~/.cache/ip-search-mcp/ip-index.sqlite
node dist/src/index.js index status
```

Bulk XML comes from the ODP bulk data directory (patent grants, published applications, trademark daily XML). The ingest is best-effort over the documented field names; verify field mapping against the USPTO data dictionary for the snapshot you use.

Verified on a real ODP product, 2026-11-10: the trademark daily applications file `apc261107.zip` (7.7 MB compressed, 143 MB XML, 7,330 case-file records) indexed in 60 seconds with zero skips. Dates are normalized to ISO. Each `case-file` becomes one row, so a daily file is searched record by record instead of collapsing to its first entry.

```bash
node dist/src/axi/index.js index build --from ./apc261107 --db ./ip-index.sqlite
```

Trademark records from TDXF carry no status description text, only a status code, so `status` is empty for those rows until a status-code table is joined.

## Documentation

- `ARCHITECTURE.md`: data flow, provider boundaries, provenance, caching, rate limits.
- `CREDENTIALS.md`: how to obtain each key and how keys are isolated.
- `LIMITS.md`: what no tool can do, and which surfaces carry terms-of-use risk.

## Legal

Not legal advice. This server produces research and drafts for review by a licensed patent or trademark practitioner. No output is a filing, an opinion of patentability, a clearance opinion, or a freedom-to-operate analysis.

Companion reactive skill: `ip-filing-prep` in `~/Desktop/skills/ip-filing-prep`.
