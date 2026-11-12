# Tools

Every tool is registered by `src/server.ts`. Keyed tools return `CREDENTIAL_MISSING` when their provider keys are absent, and unkeyed sources remain available.

| Tool | Reads | Writes | Notes |
|------|-------|--------|-------|
| `credential_status` | yes | no | Provider table and required env vars |
| `prior_art_search` | yes | no | Description or boolean queries in; one relevance-ranked list of patents, papers, preprints, and repositories out |
| `patent_read` | yes | no | Independent claims, owner, status, estimated expiry and fee state, per-claim term overlap |
| `concept_assessment` | yes | no | 101 screen, CPC/Nice guesses, closest hits from generated queries (about 30 to 75 cold ODP requests), distinctiveness band |
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
| `disclosure_review` | yes | no | 102(b)(1) grace clock plus a cited foreign grace table |
| `attorney_packet` | yes | optional file | Review packet |
| `index_build` | yes | yes | Local FTS5 index over bulk XML |

## Prior-art search

`prior_art_search` takes a plain-language description and generates several narrow queries: the two most weighted terms, each ANDed with the next terms, plus repeated phrases. Or pass your own `queries`; they accept `AND`, `OR`, `NOT`, quoted phrases, and a trailing `*`.

For patents it searches USPTO Open Data Portal titles, adds the most common CPC classes of the best title hits, and follows citations both ways (references cited by the top hits, and later applications whose examiners cited them; forward citations are examiner citations in office actions only, so that list is partial, and a failed lookup shows up as a run entry with its error). It then reads the full text and claims of the strongest candidates and re-ranks everything by BM25 weighted toward claims. Papers come from OpenAlex, preprints from arXiv, and code from GitHub repository search. Each group is ranked on its own statistics and merged by normalized score and term coverage.

The `date` of a result is the earliest relevant date, the one that decides whether a reference predates your idea: for a patent its effective filing date (else its filing date, else its earliest publication date), for a paper or preprint its publication date, for a repository its creation date. A patent's grant date is reported separately as `grantDate` (the `grant` column of `ip-axi prior-art search --fields`), with its filing and publication dates alongside, and `concept_assessment` hits carry the same dates in their own fields.

Each result says what was read (`claims`, `abstract`, or `title`), which queries found it, which key terms it shares and lacks, and the passage that overlaps most.

`patent_read` takes up to 20 patent or application numbers. It returns the current owner (latest recorded ownership assignment; security interests and licences are skipped), status, estimated expiry (earliest non-provisional filing plus 20 years plus term adjustment), maintenance-fee state, every independent claim in full, and, given a description, which key terms each independent claim shares and lacks. An eight-digit number without separators can be a grant or an application number; the reading says which one it used and how to ask for the other. Term and in-force values carry their basis and caveats, including when the continuity lookup behind the expiry failed.

`hydrate` (default 50) is a hard cap on the full texts read, counted across the first wave and the citation wave; with expansion on, a quarter of it is held back for candidates found by citation. Each full text is one ODP request.

A cold search with the default `hydrate` makes about 75 to 120 ODP requests: 21 generated title queries of one to three pages each, up to 3 class queries, up to `hydrate` full texts, and up to 5 citation lookups. At the 60-per-minute pace that is one and a half to two minutes. Repeat searches read the cache and return in seconds. Lower `hydrate` for a faster first run; `concept_assessment` uses 10 and skips citation expansion. The `ip-axi` shell client waits up to 10 minutes for a tool call. An MCP client with a shorter tool timeout (many default to 60 seconds) should raise it for `prior_art_search` and `concept_assessment`, or a cold run will fail on the client side while the server keeps spending request budget.

Search results carry `Provenance` with provider, route, retrieval time, source id, and an `undocumented` flag for the opt-in surfaces. A zero-result search is recorded as a zero-result search, never as evidence of novelty.

The same tools are available from the shell through `ip-axi`; see [../skills/ip-axi/SKILL.md](../skills/ip-axi/SKILL.md) for commands and flags.

See [LIMITS.md](LIMITS.md) for what these tools cannot decide.
