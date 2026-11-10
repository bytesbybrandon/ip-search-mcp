# Local index

The local index is a SQLite FTS5 database built over USPTO bulk XML, so patent and trademark text search works without a provider key.

```bash
node dist/src/index.js index build --from <dir-of-xml> --db ~/.cache/ip-search-mcp/ip-index.sqlite
node dist/src/index.js index status
```

Bulk XML comes from the ODP bulk data directory: patent grants, published applications, and trademark daily XML. The ingest is best-effort over the documented field names; verify field mapping against the USPTO data dictionary for the snapshot you use.

The index path defaults to `~/.cache/ip-search-mcp/ip-index.sqlite` and can be overridden with `IP_INDEX_DB` or `--db`. Once built, searches can target the index alongside the official providers, and every hit keeps its provenance.

Verified on a real ODP product, 2026-11-10: the trademark daily applications file `apc261107.zip` (7.7 MB compressed, 143 MB XML, 7,330 case-file records) indexed in 60 seconds with zero skips. Dates are normalized to ISO.
Each `case-file` becomes one row, so a daily file is searched record by record instead of collapsing to its first entry.

```bash
node dist/src/axi/index.js index build --from ./apc261107 --db ./ip-index.sqlite
```

Trademark records from TDXF carry no status description text, only a status code, so `status` is empty for those rows until a status-code table is joined.

The same index backs `index_build` when you call it as an MCP tool.
