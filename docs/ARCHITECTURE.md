# Architecture

## Shape

```
MCP client
   |
   v
src/server.ts  (tool registration, zod input schemas, output formatting)
   |
   +-- research.ts        prior-art search and top-hit reading (composes providers and domain)
   |
   +-- domain/            pure logic, no network
   |     assessment      concept screen (101 risks, CPC/Nice, closest hits)
   |     claims          claim parsing, dependency graph, 112 lint
   |     disclosure      102(b)(1) clock arithmetic and the cited foreign grace table
   |     relevance       query generation, boolean matching, BM25 ranking, overlap passages
   |     term            expiry and in-force estimate from file-wrapper data
   |     drawings/       rules (1.84), geometry (SVG parse), render, validate
   |     spec            specification assembly, claim scaffold, packet
   |
   +-- providers/         one module per data source
   |     odp   tsdr   ops   openalex   arxiv   github   ppubs (opt-in)   tmsearch (opt-in)   index (sqlite)
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
| OpenAlex | `api.openalex.org` | optional `api_key` | Documented, free tier with a daily budget |
| arXiv | `export.arxiv.org` | none | Documented, one request per three seconds |
| GitHub | `api.github.com` | optional bearer token | Documented REST search |
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
| `openalex:default` | 60/min | Conservative; the daily budget is the real limit |
| `arxiv:default` | 20/min | arXiv API terms: one request per three seconds |
| `github:search` | 10/min, 30/min with a token | GitHub search API limits |

The limiter is a sliding window shared per bucket across the process. Retries honor `Retry-After` and use exponential backoff for 429 and 5xx.

## Caching

File cache under `~/.cache/ip-search-mcp`, keyed by a SHA-256 of provider, URL, and body, with a per-call TTL (5 minutes for `patents_search`, 12 hours for prior-art title, CPC, and citation queries, 24 hours for paper, preprint, and code searches, 30 days for issued full text, 1 minute for case status, 30 minutes to 1 hour for metadata and bibliographic data). Writes are atomic (temp file then rename). Cache hits are marked `cached: true` in provenance. An expired entry is deleted when it is read, and the cache is capped at `IP_CACHE_MAX_MB` (default 300): on the first write of a process and every 50 writes after, the oldest entries are deleted until it fits. Only the cache's own `.json` entries are ever removed; the local index file that shares the directory is not touched.

A provider that answers 429 or 5xx is retried with backoff, but never for longer than 30 seconds: a `Retry-After` beyond that skips the request and the failure is reported as that run's error, so one rate-limited source cannot hold back the others.

## Prior-art pipeline

1. `relevance.generateQueries` turns a description into weighted key terms (stemmed, boilerplate removed) and several narrow queries: the two top terms each ANDed with the next ten, plus repeated phrases.
2. `research.patentLeg` runs the title queries against ODP, adds the most common CPC symbols of the best title hits as class queries, and reads the full-text XML that ODP links from each file wrapper for a diversified set of candidates (the best titles from every query, then the best overall). It then follows backward citations (patents cited by the top five, looked up by number) and forward citations (later applications whose examiners cited the top three, from the ODP Office Action Enriched Citation API), adds them to the pool, and reads those whose titles match the key terms. Forward citations are examiner citations in office actions only, so they are a partial list. A failed lookup is a run entry with its error, never silently empty. Across both waves it never reads more than `hydrate` full texts.
3. `research.artLeg` runs the text queries against OpenAlex, arXiv, and GitHub.
4. Patents, literature, and code are each ranked by BM25 on their own pool (claims weighted highest), normalized to the best hit in their group, and merged with term coverage. Explicit boolean queries are checked against each document's own text.
5. Every provider failure becomes a run entry with its error; the other sources still return.

`patent_read` resolves a number to its file wrapper, reads the issued (or published) full text, looks up the earliest non-provisional parent, and passes status, events, and term adjustment to `term.estimateTerm`.

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
