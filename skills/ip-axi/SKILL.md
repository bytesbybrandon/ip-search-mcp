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
- Trademark candidates are not a clearance opinion.

## Examples

```bash
node <repo>/dist/src/axi/index.js patents search "optical sensor calibration" --limit 5
node <repo>/dist/src/axi/index.js trademarks get 87454105
node <repo>/dist/src/axi/index.js drawings validate ip/drawings/fig-1.svg --description @ip/specification.md
```
