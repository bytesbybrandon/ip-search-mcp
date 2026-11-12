# Limits

## What no implementation can fix

- **No official USPTO trademark search API exists.** TSDR is identifier lookup only. The Trademark Search web app has no documented API; its backend is used by the UI and carries terms-of-use risk. Real discovery requires either that backend, a local index over the trademark daily XML, or a paid third party.
- **PatentsView is gone.** The legacy API was retired in May 2025 and the Search API shut down in March 2026; its data moved to ODP bulk products, its host no longer resolves, and new keys cannot be requested. Any guide pointing at `api.patentsview.org` or `search.patentsview.org` is stale. This server does not use it.
- **This server has no full-text patent search source.** The documented ODP search API matches titles and metadata only. `prior_art_search` therefore finds patent candidates by title, CPC class, and citation links, and reads full text and claims only for those candidates. A patent whose claims match the description but whose title, CPC classes, and citations miss every query is not found. That is the dangerous direction for a clearance question, so a clean result is never a clearance. The later remedy is a real full-text source: EPO OPS full-text search or the local bulk full-text index over grant XML. Neither is part of this search yet.
- **ODP API documentation requires a USPTO.gov sign-in.** Endpoint paths in this server come from the published OpenAPI surface and a bound client; response shapes for fields not exercised here can differ and surface as raw payloads rather than normalized hits.
- **EPO OPS is not a US legal record.** It is bibliographic and family data; verify status and documents against USPTO records.

## Verified against live providers, 2026-11-10

Observed with real USPTO keys, then encoded in the tests and provider code.

- **ODP free-text search works.** A plain-language phrase returned 425,510 matching applications with title, filing date, inventor, assignee, status, and application number normalized correctly.
- **ODP answers a zero-hit search with HTTP 404** and `"No matching records found"`. The provider converts that to an empty result set, not an error.
- **ODP date-range filtering is not verified.** Four documented shapes (`rangeFilters` with ISO dates, compact dates, and both `filingDate` and `applicationFilingDate`; `filters` with range strings) all returned 404 or 400. `patents_search` therefore rejects `from`/`to` for the ODP provider and routes date-bounded queries to EPO OPS or the local index. ODP sort and filter field names are likewise unverified.
- **ODP documents live under `documentBag[].downloadOptionBag[]`.** The provider flattens them to code, description, official date, page count, and PDF URL. A 2026 application returned 53 documents.
- **TSDR returns namespaced ST.96 XML.** With namespace prefixes removed, `ApplicationNumberText`, `RegistrationNumber`, `MarkVerbalElementText`, `NationalStatusExternalDescriptionText`, `ApplicationDate`, `RegistrationDate`, `ClassNumber`, and `EntityName` map correctly. Serial 87454105 returned DOCKER, ACTIVE, registration 6096739, Docker, Inc., class 9, and 57 documents.
- **Bulk ingest works at record scale.** A real trademark daily file (7.7 MB compressed, 143 MB XML, 7,330 case-file records) indexed in 60 seconds with zero skips and searchable rows. Each case-file is parsed separately, so daily files no longer collapse to one record.
- **Not yet exercised live:** EPO OPS (no credentials), Patent Public Search, and the Trademark Search backend (both opt-in).

## Prior-art search

- Query generation uses term frequency in your description. A long description that repeats a generic word (for example "device" or "signal") can push a specific term down the list; describe one feature at a time, or pass `queries` yourself.
- Ranking is BM25 over the candidate pool, weighted toward claims. It orders references for human review. It is not a novelty, obviousness, or infringement judgment.
- Forward citations come from the ODP Office Action Enriched Citation API, so they cover examiner citations in office actions only, not every later patent that cites a reference.
- `patent_read` estimates expiry from the earliest non-provisional filing plus 20 years plus term adjustment (design patents: 15 or 14 years from grant). It marks a patent lapsed only when ODP records expiry or a nonpayment status, and reports `uncertain` when a fee window has closed with no payment event but ODP still shows the patent as standing. A granted petition to accept a late fee counts as reinstatement. Terminal disclaimers and term extensions are not visible.
- ODP publishes its rate limits behind the USPTO.gov sign-in. This server paces every ODP call, searches and full-text file reads alike, through one 60-per-minute bucket and backs off on HTTP 429 with `Retry-After`. Over a few hundred file reads in testing, no 429 was returned.
- OpenAlex without a key shares one small daily budget per network address. arXiv asks for one request every three seconds. GitHub allows 10 searches a minute without a token. When a source fails or runs out, the search returns the other sources and lists the failed runs.

## Search quality

- Text search is not classification search. A keyword result set can miss an entire CPC class.
- Term overlap between a concept and a reference orders references for human review; it does not show disclosure.
- Ranking is textual. It is not a likelihood-of-confusion score for trademarks and not an obviousness judgment for patents.
- A zero-result search is recorded as a zero-result search. It is never evidence of novelty.

## Drawing validation

Checked: sheet size, margins and sight, frames, ink color, stroke weight, minimum text height, reference-character form and line crossings, view overlap, figure labels, prohibited scale text, description coverage of reference characters, sheet numbering, hatch spacing.

Not checked, because geometry cannot decide it:

- Whether the same reference character designates the same part across views.
- Whether views are connected by projection lines or contain center lines.
- Whether the scale survives two-thirds reproduction.
- Whether shading correctly communicates surface form.
- Whether a photograph is the only practicable medium (1.84(b)).

Formats: SVG only. PDF and PNG are not parsed; convert a sheet to SVG or validate the generated SVG. A PDF checklist is a practitioner task.

## Drafting

- `application_draft` assembles supplied content and reports gaps. It does not invent background, embodiments, or claim limitations.
- `claims_draft` writes one independent claim from supplied elements. Dependent claims and scope decisions are human work.
- Claim lint is heuristic. Antecedent basis uses head-final noun detection, specification support uses content-word overlap, and both can miss or over-flag. Findings are screening aids with citations, not rejections.
- No ADS, declaration, assignment, or fee calculation is produced.

## Disclosure clock

`disclosure_review` does arithmetic on dates you supply. It does not know about the inventor's earlier priority filing, derivation proceedings, experimental use, or national exceptions beyond the flags it states. Confirm every date with counsel.

The foreign table is a lay summary with statute citations (EPC Art. 55 and Rule 25, UK Patents Act s. 2(4), PatG § 3(5), CPI L611-13, PRC Patent Law Art. 24 and Implementing Regulations Rule 33, Japan Patent Act Art. 30, Korea Patent Act Art. 30, Canada Patent Act s. 28.2, Australia Patents Regulations reg. 2.2C, Brazil Law 9.279 Art. 12, India Patents Act ss. 29, 31, and 32), checked against primary text in November 2026. It counts the grace from the disclosure date. Each foreign row reports one status: `open` or `closed` for a 12-month grace measured from the disclosure date, `no-grace` for offices without one (and for the narrow CN and IN exceptions), `not-excused` when the disclosure was made by someone other than the inventor (the 12-month graces cover the applicant's own disclosure or one derived from it, so no deadline is given), and `unknown` for a jurisdiction outside the table. A disclosure by someone other than the inventor gets no window anywhere: the US row is `not-excused` too, no row carries a deadline, and urgency is `barred` until derivation from the inventor (35 U.S.C. 102(b)(1)(A)-(B)) is established. Japan, Korea, Canada, and Australia count back from the national or PCT international filing date, not a US priority date; China and Brazil count from the priority date. Japan and Korea require a claim and proof. Counsel should confirm each provision before relying on it.

## Undocumented provider risk

`IP_ALLOW_UNOFFICIAL=1` enables adapters for:

- `ppubs.uspto.gov` session and search endpoints.
- `tmsearch.uspto.gov` configuration discovery and the Elasticsearch-style search backend.

Both can break on any USPTO deploy. Both are subject to USPTO terms of use, which state that unusually high automated access may be denied and that website interfaces are not a bulk-data source. Use the local index or official APIs when reliability matters. When these adapters run, hits are labeled `undocumented: true` and are candidates only.

## Legal

Nothing here is legal advice, an opinion of patentability, a registrability opinion, a clearance search, or a freedom-to-operate analysis. Every artifact is a draft for a licensed practitioner. The server has no filing, signature, or submission capability by design.
