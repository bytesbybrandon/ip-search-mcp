# Architecture

## Shape

```
MCP client
   |
   v
src/server.ts  (tool registration, zod input schemas, output formatting)
   |
   +-- domain/            pure logic, no network
   |     assessment      concept screen (101 risks, CPC/Nice, closest hits)
   |     claims          claim parsing, dependency graph, 112 lint
   |     disclosure      102(b)(1) clock arithmetic
   |     drawings/       rules (1.84), geometry (SVG parse), render, validate
   |     spec            specification assembly, claim scaffold, packet
   |
   +-- providers/         one module per data source
   |     odp   tsdr   ops   ppubs (opt-in)   tmsearch (opt-in)   index (sqlite)
   |
   +-- http.ts            fetch, retry, rate limit, cache, credential host check
   +-- numbers.ts         patent and trademark identifier normalization
   +-- config.ts          env parsing, provider flags, credential state
```

Domain modules never import providers. Providers never format user-facing text. The server composes them.

`ip-axi` sits beside the server as a presentation layer. It creates the same server in process, connects over an in-memory MCP transport, and calls tools through the MCP client, so command behavior cannot drift from tool behavior. Only formatting, flag parsing, and exit codes live in `src/axi/`.

## Provider boundaries

| Provider | Host | Auth | Stability |
|----------|------|------|-----------|
| ODP | `api.uspto.gov` | `X-API-KEY` | Documented API, docs and swagger behind a USPTO.gov login |
| TSDR | `tsdrapi.uspto.gov` | `USPTO-API-KEY` | Documented, identifier lookup only |
| EPO OPS | `ops.epo.org` | OAuth2 client credentials | Documented, fair-use quota |
| PPUBS | `ppubs.uspto.gov` | session token | Undocumented, opt-in |
| tmsearch | `tmsearch.uspto.gov` | WAF cookie (optional) | Undocumented, opt-in, backend base discovered at runtime |
| index | local file | none | Derived from ODP bulk XML |

Each provider normalizes into `PatentHit`, `TrademarkHit`, `PatentDocument`, or a raw record, and every hit carries `Provenance`: provider, route, retrieval time, source id, and an `undocumented` flag when it applies.

## Credential isolation

`http.ts` refuses to send a request whose host is not the provider's configured host. Keys are attached inside the provider module, never passed in by a tool argument, never logged, and redacted in error details. ODP and TSDR use separate keys; the server never substitutes one for the other.

## Rate limits

| Bucket | Limit | Basis |
|--------|-------|-------|
| `tsdr:default` | 60/min | USPTO published limit |
| TSDR PDF/ZIP | 4/min | Not wired: this server links to bundles rather than downloading them |
| `odp:default` | 60/min | Conservative; ODP publishes limits on its own page |
| `ops:default` | 60/min | EPO fair-use charter |
| `ppubs:default` | 30/min | Undocumented; deliberately conservative |
| `tmsearch:default` | 30/min | Undocumented; deliberately conservative |

The limiter is a sliding window shared per bucket across the process. Retries honor `Retry-After` and use exponential backoff for 429 and 5xx.

## Caching

File cache under `~/.cache/ip-search-mcp`, keyed by a SHA-256 of provider, URL, and body, with a per-call TTL (5 minutes for searches, 1 minute for case status, 30 minutes to 1 hour for metadata and bibliographic data). Writes are atomic (temp file then rename). Cache hits are marked `cached: true` in provenance.

## Drawing pipeline

1. `renderSheet` emits an SVG in millimetre coordinates: A4 or letter, fixed margins, no sight frame, scan targets in two catercorner corners, header indicia inside the top margin, sheet numbering, and reference characters at 4 mm.
2. `geometry.ts` parses any SVG back into primitives with transforms applied: rect, line, circle, ellipse, polygon, polyline, path (M/L/H/V/C/Q/S/T/A/Z with curve sampling), and text with estimated bounds. Unsupported constructs are reported, not guessed.
3. `validate.ts` checks the parsed primitives against the encoded rules and returns findings with rule ids and citations, plus a list of things geometry cannot verify (part identity across views, projection lines, print reduction, shading correctness).

The rule set is data in `rules.ts`, sourced from eCFR title 37 section 1.84 on 2026-11-10. `drawing_rules` returns it with the source URL and retrieval date so a reader can check freshness.

## Claims pipeline

`parseClaims` splits numbered claims, extracts dependency phrases (including ranges and "or"/"and"), and builds a dependency graph. Lint covers sequential numbering, forward references, multiple dependent claims built on multiple dependent claims, alternative form, antecedent basis using transitive ancestors, means-plus-function triggers, relative terms, specification support, abstract length, and title limits. Antecedent basis uses a head-final noun heuristic; it is a screening aid, not a parser.

## Drafting

`draftSpecification` assembles sections in the order examiners expect and reports every section the caller did not supply as a gap. It never invents content. `draftClaims` builds an independent claim from supplied elements and never adds limitations. Every artifact starts with `DRAFT - NOT FOR FILING`.

There is no submission code path anywhere in the server: no EFS-Web, Patent Center, TEAS, or EPO Online Filing client, no signature handling, and no credentials for any filing system.

## Local index

`node:sqlite` with FTS5 over `patents` and `trademarks` tables. Ingest walks a directory of XML, detects patent grant, published application, and trademark record shapes, extracts text subtrees (abstract, claims, description, goods and services), and writes both the row and its FTS entry. Search returns `bm25` order with the `index` provider label.

One file can hold thousands of records: `<case-file>` blocks are split and parsed individually so a daily TDXF file indexes every application and memory stays bounded. Patent grant and application XML files are parsed whole. Limits: ingest is not incremental across releases beyond `INSERT OR REPLACE`; field mapping follows the documented TDXF and ICE names and must be checked against the data dictionary for a given snapshot. Measured: 7,330 trademark records from a 143 MB file in 60 seconds.

## Project site

`site/` holds a static project page with no build step: tokens, base rules, one stylesheet, and one HTML file. `.github/workflows/pages.yml` deploys that directory to GitHub Pages on every push to main that touches it. The page is presentation only; it is not an input to the server or the package.

## Failure behavior

Errors are typed (`CREDENTIAL_MISSING`, `PROVIDER_DISABLED`, `RATE_LIMITED`, `UPSTREAM`, `NOT_FOUND`, `INVALID_INPUT`, `UNSUPPORTED_FORMAT`). Tools return them as `isError` results with an actionable hint. Nothing crashes the process, and no error is converted into an empty success.
