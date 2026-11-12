# Tools

Every tool is registered by `src/server.ts`. Keyed tools return `CREDENTIAL_MISSING` when their provider keys are absent, and unkeyed sources remain available.

| Tool | Reads | Writes | Notes |
|------|-------|--------|-------|
| `credential_status` | yes | no | Provider table and required env vars |
| `prior_art_search` | yes | no | Description or boolean queries in; one relevance-ranked list of patents, papers, preprints, and repositories out |
| `patent_read` | yes | no | Independent claims, owner, status, estimated expiry and fee state, per-claim term overlap |
| `fto_chart` | yes | no | In-force patents only: each independent claim split into elements, each marked present, absent, or unclear in a feature |
| `disclosure_scan` | yes | no | Dated timeline of when pages first showed given strings (Wayback, urlscan, archive.today, live) and the grace assessment |
| `vet` | yes | no | Per feature: closest art, freedom-to-operate flags, disclosure status, recommendation, provisional-ready section, fingerprints |
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

## Vetting a feature

`vet` takes a description and, by default, splits it into features: markdown headings or bullets when present, otherwise blank-line paragraphs; a short title line before the first feature joins it. One feature at a time ranks far better than a long multi-feature paragraph. Pass `whole: true` to keep it as one, or pass `features` with names, descriptions, and optional `signatures`. At most 10 features are vetted per call; the rest are named in `notes` so they can be run again. For each feature it:

1. runs `prior_art_search` on the feature (`hydrate` 30, keeping its 200 best-ranked results; the closest five are returned and the granted patents among them supply the charting candidates);
2. charts the first five in-force granted patents with `fto_chart`: candidates are read in rank order, up to 15 (taken from the ranked patent results, not only the first few merged with papers), and expired, lapsed, abandoned, and pending patents, and patents whose claims cannot be read, are listed as skipped with the reason (an unreadable patent is never reported as cleared);
3. when `sites` are given, runs `disclosure_scan` on them with the feature's signatures: its own `signatures`, else the `signatures` given for every feature (the CLI's `--signature "a;b"`, repeated or separated by `;`, and `--signatures-file @file` with one per line), else two-word-or-longer phrases its description repeats. Derived signatures can match ordinary page copy, so the output says when they were derived. With no sites, or no signatures, the output says the disclosure check did not run and why;
4. returns one verdict: the closest art, the patents flagged because every element of an independent claim appears in the feature, the earliest dated public match, and a recommendation (`file`, `publish-defensively`, or `keep-secret`) with its reasons and cautions. When part of the evidence is missing (a search source failed or was skipped, a patent could not be read, the disclosure check did not run or could not finish), the verdict adds an "Evidence is partial" caution and does not claim that nothing was found;
5. adds a provisional-ready draft section (title, classification guesses, closest art as background, summary, elements, and a claim scaffold, with attorney gaps marked) and fingerprints: each signature normalized and SHA-256 hashed, for a pre-publication check that scans outgoing text.

The recommendation rules are simple and stated in each verdict: public for more than a year means publish defensively (a US patent is likely barred); close art covering about three quarters or more of the feature's key terms means publish defensively; public within the year means file before the US deadline; no disclosure, no close art, and `detectable: false` means keep secret; otherwise file. An archive date is the latest the feature can have become public, so a deadline computed from it is the latest it can be. A feature seen only on the live page is public now with an unknown first date: the verdict computes no deadline and says the grace period may already have run.

`fto_chart` splits a claim after its transitional phrase on semicolons, with each "wherein" clause as its own element. An element is present when at least 60% of its content terms appear in the feature, absent at 25% or less, and unclear otherwise. A patent is skipped, with its reason, when it is expired, lapsed, abandoned, or pending, or when its independent claims could not be read; a patent whose status is uncertain or unknown is charted with that status shown.

`disclosure_scan` finds the earliest Wayback capture of each URL whose content contains a signature: it checks the first and last capture and a few evenly spaced ones, then binary-searches between the last miss and the first hit, so a page with hundreds of captures costs about a dozen fetches. A fetch that fails is counted and reported in the notes (the match may be earlier), never read as a miss. A URL with more than 500 distinct captures is searched through its oldest 500; if none of those matches, the notes say so and the scan is incomplete (a match in the oldest 500 is already the earliest). If the URL has no capture of its own (it may only have been archived as a redirect), the scan falls back to at most 3 other archived HTML pages on the same host, at most about 15 fetches each; each match names the page it came from, never the URL that was asked about. It also lists the first archive.today capture, the earliest of the host's 100 most recent public urlscan.io scans, and whether the live page shows a signature now. The earliest archive match feeds the `disclosure_review` arithmetic; a live-only match has no date and gets no deadline. `incomplete` is true when a match may have been missed or dated too late: a fetch failed, a live page was cut short at 2 MB, a Wayback history longer than 500 captures had no match in its oldest 500, or the host fallback left archived pages unsearched and found nothing.

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
