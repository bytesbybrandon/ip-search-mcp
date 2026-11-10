# Tools

Every tool is registered by `src/server.ts`. Keyed tools return `CREDENTIAL_MISSING` when their provider keys are absent, and unkeyed sources remain available.

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

Search results carry `Provenance` with provider, route, retrieval time, source id, and an `undocumented` flag for the opt-in surfaces. A zero-result search is recorded as a zero-result search, never as evidence of novelty.

See [LIMITS.md](LIMITS.md) for what these tools cannot decide.
