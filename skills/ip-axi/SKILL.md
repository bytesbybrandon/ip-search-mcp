---
name: ip-axi
description: Patent and trademark research, 37 CFR 1.84 drawing validation, and a local bulk index from the shell. Use for quick IP lookups when an MCP server is not needed or when a script needs structured output.
---

# ip-axi

Agent-ergonomic shell interface over the same tools as `ip-search-mcp`. Output is TOON; every command ends with next steps.

## Home

Run with no arguments for live provider and index status. No side effects.

```bash
node <repo>/dist/src/axi/index.js
```

`npx -y ip-axi` runs the published package; `pnpm exec ip-axi` runs the local build.

## Commands

| Command | Purpose |
| --- | --- |
| `vet <description>` | Per feature (headings, bullets, or paragraphs; `--whole` for one): closest art, FTO flags, disclosure status, recommendation. `--sites url,url`, `--signature "a;b"` (repeatable) or `--signatures-file @file`, `--detectable yes\|no`, `--provisional`, `--fingerprints` |
| `fto chart <number...>` | In-force patents only: independent claims split into elements, each present, absent, or unclear; `--feature @file` |
| `disclosure scan <url...>` | Dated timeline of when pages first showed `--signature "a;b"` (Wayback, urlscan, archive.today, live) |
| `prior-art search <description>` | Generated queries over patents, papers, preprints, and code; one ranked list with why each hit overlaps. `--query` for your own boolean queries, `--sources`, `--fields why,url,status,grant`. `date` is the earliest relevant date (a patent's effective filing date, not its grant date); `grant` adds the grant date. See [docs/TOOLS.md](../../docs/TOOLS.md) |
| `patents read <number...>` | Independent claims, owner, status, estimated expiry, fee state; `--description` adds per-claim overlap |
| `patents search <query>` | Search across configured providers, `--provider auto\|odp\|ops\|ppubs\|index` |
| `patents get <number>` | Metadata for a grant, application, publication, or PCT number |
| `patents docs <application>` | File-wrapper documents with codes and download URLs |
| `patents family <number>` | Worldwide family via EPO OPS |
| `trademarks search <mark>` | Candidate marks; hydrate before relying on them |
| `trademarks get <identifier>` | Authoritative TSDR status |
| `trademarks docs <identifier>` | TSDR document list and bundle URL |
| `drawings validate <path>` | 37 CFR 1.84 findings with citations |
| `index build --from <dir>` | Build the local FTS5 index from bulk XML |
| `index status` | Index counts and build time |
| `status` | Provider configuration and index state |

## Flags that apply broadly

- `--limit <n>`: rows returned; totals still print.
- `--fields a,b`: opt into extra columns.
- `--full`: stop truncating long text.
- `--help`: per-command reference; never triggers work.

## Exit codes

`0` success, `1` provider or input error, `2` usage error. Errors print as TOON on stdout with a fixing command.

## Invariants

- Read-only except `index build` and commands that write a file.
- Nothing files, signs, or submits an application.
- Search hits carry provider and retrieval time; undocumented providers are labeled.
- A low or zero prior-art score is never evidence of novelty; expiry and in-force values are estimates.
- Trademark candidates are not a clearance opinion.

## Examples

```bash
node <repo>/dist/src/axi/index.js prior-art search "A handheld optical sensor that recalibrates against a sealed reference surface when drift exceeds a threshold" --fields why
node <repo>/dist/src/axi/index.js patents read 9765584 --description @idea.md
node <repo>/dist/src/axi/index.js vet @features.md --sites https://example.com/ --provisional
node <repo>/dist/src/axi/index.js fto chart 9765584 --feature @feature.md
node <repo>/dist/src/axi/index.js disclosure scan https://example.com/ --signature "Recalibrate now"
node <repo>/dist/src/axi/index.js patents search "optical sensor calibration" --limit 5
node <repo>/dist/src/axi/index.js trademarks get 87454105
node <repo>/dist/src/axi/index.js drawings validate ip/drawings/fig-1.svg --description @ip/specification.md
```
