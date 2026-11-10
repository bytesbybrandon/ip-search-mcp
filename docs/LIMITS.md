# Limits

## What no implementation can fix

- **No official USPTO trademark search API exists.** TSDR is identifier lookup only. The Trademark Search web app has no documented API; its backend is used by the UI and carries terms-of-use risk. Real discovery requires either that backend, a local index over the trademark daily XML, or a paid third party.
- **PatentsView is gone.** The legacy API was retired in May 2025 and the Search API shut down in March 2026; its data moved to ODP bulk products. Any guide pointing at `api.patentsview.org` or `search.patentsview.org` is stale.
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

## Undocumented provider risk

`IP_ALLOW_UNOFFICIAL=1` enables adapters for:

- `ppubs.uspto.gov` session and search endpoints.
- `tmsearch.uspto.gov` configuration discovery and the Elasticsearch-style search backend.

Both can break on any USPTO deploy. Both are subject to USPTO terms of use, which state that unusually high automated access may be denied and that website interfaces are not a bulk-data source. Use the local index or official APIs when reliability matters. When these adapters run, hits are labeled `undocumented: true` and are candidates only.

## Legal

Nothing here is legal advice, an opinion of patentability, a registrability opinion, a clearance search, or a freedom-to-operate analysis. Every artifact is a draft for a licensed practitioner. The server has no filing, signature, or submission capability by design.
