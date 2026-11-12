/**
 * Prior-art search and top-hit reading. Composes providers (network) with
 * domain/relevance (pure ranking). Every provider failure becomes a note,
 * never an unhandled rejection, so one slow source cannot stall the rest.
 */
import { config } from "./config.js";
import { IpError } from "./errors.js";
import type { Provenance } from "./http.js";
import { parsePatentNumber } from "./numbers.js";
import {
  bestPassage,
  documentIndex,
  generateQueries,
  keyTerms,
  matchesAll,
  parseBoolean,
  rankDocuments,
  rankingTerms,
  stem,
  weightedCoverage,
  wildcard,
  type KeyTerm,
  type RankDocument,
} from "./domain/relevance.js";
import { estimateTerm, type TermEstimate } from "./domain/term.js";
import * as arxiv from "./providers/arxiv.js";
import * as github from "./providers/github.js";
import * as odp from "./providers/odp.js";
import * as openalex from "./providers/openalex.js";
import type { ArtHit } from "./types.js";

export type ArtSource = "patents" | "papers" | "preprints" | "code";
export const ALL_SOURCES: readonly ArtSource[] = ["patents", "papers", "preprints", "code"];

export interface SearchInput {
  description?: string;
  queries?: string[];
  sources?: ArtSource[];
  limit?: number;
  /** How many patent candidates to fetch full text and claims for. */
  hydrate?: number;
  /** Expand by CPC class and citations (default true). */
  expand?: boolean;
}

export interface Candidate {
  rank: number;
  source: "patent" | "paper" | "preprint" | "code";
  id: string;
  title: string;
  /**
   * The earliest relevant date, for judging whether a reference predates an idea.
   * Patents: effective filing date, else filing date, else earliest publication
   * date. Papers and preprints: publication date. Repositories: creation date.
   */
  date?: string;
  /** Patents only: the dates behind `date`, and the grant date, kept apart from it. */
  effectiveFilingDate?: string;
  filingDate?: string;
  publicationDate?: string;
  grantDate?: string;
  owner?: string;
  url?: string;
  status?: string;
  score: number;
  /** Fraction of the key terms found anywhere in the document. */
  coverage: number;
  matched: string[];
  missing: string[];
  /** Whether full text and claims were read (patents) or only title and abstract. */
  textRead: "claims" | "abstract" | "title";
  matchedQueries: string[];
  foundBy: string[];
  why?: string;
  applicationNumber?: string;
  provenance: Provenance;
}

export interface SearchRun {
  source: string;
  query: string;
  count: number;
  error?: string;
}

export interface SearchOutput {
  terms: Array<{ term: string; weight: number }>;
  queries: { patent: string[]; text: string[] };
  results: Candidate[];
  runs: SearchRun[];
  notes: string[];
}

/** Run `fn` over items with at most `limit` in flight. Perf: P2 · O(items) · CRAP <= 10 (CC 2). */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return out;
}

function message(error: unknown): string {
  return error instanceof IpError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error);
}

interface PatentEntry {
  wrapper: odp.OdpWrapper;
  foundBy: Set<string>;
  full?: odp.FullText;
  fullSource?: "grant" | "publication";
  /** Built once per entry so ranking reuses its tokens; dropped when full text arrives. */
  doc?: RankDocument;
  provenance: Provenance;
}

function patentId(wrapper: odp.OdpWrapper): string {
  const number = wrapper.applicationMetaData?.patentNumber;
  return number ? `US${number}` : `US-APP-${wrapper.applicationNumberText ?? "?"}`;
}

function patentDoc(id: string, entry: PatentEntry): RankDocument {
  const full = entry.full;
  entry.doc ??= {
    id,
    fields: {
      title: full?.title ?? entry.wrapper.applicationMetaData?.inventionTitle,
      abstract: full?.abstract,
      claims: full?.claims.map((claim) => claim.text).join(" "),
      body: full?.description,
    },
  };
  return entry.doc;
}

/** A Google Patents page for grants and published applications; Patent Center for an unpublished application. */
function patentUrl(wrapper: odp.OdpWrapper, full?: odp.FullText): string | undefined {
  const number = wrapper.applicationMetaData?.patentNumber;
  if (number) return `https://patents.google.com/patent/US${number}`;
  if (full?.documentNumber) return `https://patents.google.com/patent/US${full.documentNumber}${full.kind ?? ""}`;
  return wrapper.applicationNumberText ? `https://patentcenter.uspto.gov/applications/${wrapper.applicationNumberText}` : undefined;
}

function addWrappers(pool: Map<string, PatentEntry>, wrappers: odp.OdpWrapper[], via: string, provenance: Provenance): string[] {
  const ids: string[] = [];
  for (const wrapper of wrappers) {
    const id = patentId(wrapper);
    ids.push(id);
    const existing = pool.get(id);
    if (existing) existing.foundBy.add(via);
    else pool.set(id, { wrapper, foundBy: new Set([via]), provenance });
  }
  return ids;
}

async function hydrate(entries: PatentEntry[], notes: string[]): Promise<void> {
  await mapLimit(entries, 6, async (entry) => {
    if (entry.full) return;
    try {
      const fetched = await odp.fullTextFor(entry.wrapper);
      if (fetched) {
        entry.full = fetched.text;
        entry.fullSource = fetched.source;
        entry.doc = undefined;
      }
    } catch (error) {
      notes.push(`full text for ${entry.wrapper.applicationNumberText} failed: ${message(error)}`);
    }
  });
}

/** The three most common full CPC symbols among the given wrappers. Perf: P1 · O(symbols) · CRAP <= 10 (CC 2). */
export function topCpc(wrappers: odp.OdpWrapper[], max = 3): string[] {
  const counts = new Map<string, number>();
  for (const wrapper of wrappers) {
    for (const symbol of (wrapper.applicationMetaData?.cpcClassificationBag ?? []).slice(0, 4)) counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, count]) => count >= 2).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, max).map(([symbol]) => symbol);
}

/**
 * Patent leg: title queries, CPC expansion, full-text hydration, citation
 * expansion, then a claims-weighted re-rank. `options.hydrate` caps the full
 * texts read across both waves. Perf: P2 · on a cold cache 21 to 63 title
 * pages, up to 3 class queries, at most `hydrate` full-text reads, and up to 5
 * citation requests; seconds when cached · CRAP <= 25 (CC 12).
 */
async function patentLeg(
  patentQueries: string[],
  terms: KeyTerm[],
  rankTerms: KeyTerm[],
  options: { hydrate: number; expand: boolean },
  runs: SearchRun[],
  notes: string[],
): Promise<Map<string, PatentEntry>> {
  const pool = new Map<string, PatentEntry>();
  if (!config.providers.odp.key) {
    notes.push("patents skipped: USPTO_ODP_API_KEY not set. Create one at https://data.uspto.gov (Manage API Key).");
    return pool;
  }
  const rankLists: Array<{ ids: string[]; total: number }> = [];
  await mapLimit(patentQueries, 4, async (query) => {
    try {
      const result = await odp.searchTitles(query, 100);
      // ODP pages are newest first; for a moderate result set read up to three
      // pages so older grants are not cut off. Broad sets stay at one page.
      const wrappers = [...result.wrappers];
      for (let offset = 100; offset < Math.min(result.count, 300); offset += 100) {
        wrappers.push(...(await odp.searchTitles(query, 100, offset)).wrappers);
      }
      runs.push({ source: "odp", query, count: result.count });
      rankLists.push({ ids: addWrappers(pool, wrappers, `title: ${query}`, result.provenance), total: result.count });
    } catch (error) {
      runs.push({ source: "odp", query, count: 0, error: message(error) });
    }
  });

  // ODP returns title matches newest first, so a hit's position carries no
  // relevance; order candidates by title BM25 over the pool instead.
  const titleRank = (): string[] => {
    const scores = rankDocuments([...pool.entries()].map(([id, entry]) => ({ id, fields: { title: entry.wrapper.applicationMetaData?.inventionTitle } })), terms);
    return scores.map((result) => result.id);
  };

  if (options.expand && pool.size > 0 && terms.length > 0) {
    const leaders = titleRank().slice(0, 12).map((id) => pool.get(id)!.wrapper);
    const anyTerm = terms.slice(0, 4).map(wildcard).join(" OR ");
    await mapLimit(topCpc(leaders), 3, async (symbol) => {
      const query = `${odp.cpcQuery(symbol)} AND (${anyTerm})`;
      try {
        const result = await odp.searchTitles(query, 100);
        runs.push({ source: "odp", query, count: result.count });
        rankLists.push({ ids: addWrappers(pool, result.wrappers, `cpc: ${symbol.replace(/\s+/g, " ")}`, result.provenance), total: result.count });
      } catch (error) {
        runs.push({ source: "odp", query, count: 0, error: message(error) });
      }
    });
  }

  // Diversify what gets read in full: the best titles from every query (six
  // from a specific query with 50 or fewer hits, three up to 300, two from a
  // broad one), then the best titles overall, so one crowded term cannot take
  // every slot. A quarter of the budget is held back for citation finds.
  const firstCount = options.hydrate - (options.expand ? Math.floor(options.hydrate / 4) : 0);
  const order = titleRank();
  const position = new Map(order.map((id, index) => [id, index]));
  const picks = new Set<string>();
  // Round-robin: every query's best title first, then every query's second,
  // so the cap trims the deepest picks, never a whole query.
  const perList = rankLists.map((list) => {
    const take = list.total <= 50 ? 6 : list.total <= 300 ? 3 : 2;
    return [...new Set(list.ids)].sort((a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0)).slice(0, take);
  });
  for (let round = 0; round < 6; round += 1) for (const list of perList) if (list[round] && picks.size < firstCount) picks.add(list[round]!);
  for (const id of order) {
    if (picks.size >= firstCount) break;
    picks.add(id);
  }
  const firstWave = [...picks].map((id) => pool.get(id)!);
  await hydrate(firstWave, notes);

  if (options.expand) {
    const ranked = rankDocuments(firstWave.filter((entry) => entry.full).map((entry) => patentDoc(patentId(entry.wrapper), entry)), rankTerms);
    const leaders = ranked.slice(0, 5).map((result) => pool.get(result.id)!);
    const cited = [...new Set(leaders.flatMap((entry) => entry.full?.citedUs ?? []).filter((number) => /^\d{6,8}$/.test(number) && !pool.has(`US${number}`)))];
    const added: PatentEntry[] = [];
    if (cited.length > 0) {
      try {
        const wrappers = await odp.byPatentNumbers(cited);
        runs.push({ source: "odp", query: `cited by top ${leaders.length}`, count: wrappers.length });
        const ids = addWrappers(pool, wrappers, "cited by a top hit", { provider: "odp", route: "citations", retrievedAt: new Date().toISOString() });
        added.push(...ids.map((id) => pool.get(id)!));
      } catch (error) {
        runs.push({ source: "odp", query: "backward citations", count: 0, error: message(error) });
      }
    }
    try {
      const citing = (await mapLimit(leaders.slice(0, 3), 3, async (entry) => {
        const number = entry.wrapper.applicationMetaData?.patentNumber;
        if (!number) return [];
        const query = `examiner citations of US${number}`;
        try {
          const applications = await odp.examinerForwardCitations(number);
          runs.push({ source: "odp", query, count: applications.length });
          return applications;
        } catch (error) {
          runs.push({ source: "odp", query, count: 0, error: message(error) });
          return [];
        }
      })).flat();
      const fresh = [...new Set(citing)].filter((application) => ![...pool.values()].some((entry) => entry.wrapper.applicationNumberText === application)).slice(0, 25);
      if (fresh.length > 0) {
        const result = await odp.searchTitles(`applicationNumberText:(${fresh.join(" OR ")})`, fresh.length);
        runs.push({ source: "odp", query: `examiner citations of top ${Math.min(3, leaders.length)}`, count: result.wrappers.length });
        const ids = addWrappers(pool, result.wrappers, "cites a top hit (examiner)", result.provenance);
        added.push(...ids.map((id) => pool.get(id)!));
      }
    } catch (error) {
      runs.push({ source: "odp", query: "examiner forward citations", count: 0, error: message(error) });
    }
    const termStems = new Set(terms.map((term) => term.stem));
    const worth = added.filter((entry) => (entry.wrapper.applicationMetaData?.inventionTitle ?? "").toLowerCase().split(/\W+/).some((word) => termStems.has(stem(word))));
    await hydrate(worth.slice(0, options.hydrate - firstWave.length), notes);
  }
  return pool;
}

/**
 * Paper, preprint and code leg. Perf: P2 · up to 3 requests per source · CRAP <= 15 (CC 8).
 */
async function artLeg(textQueries: string[], sources: ArtSource[], runs: SearchRun[]): Promise<ArtHit[]> {
  const jobs: Array<{ source: string; query: string; run: () => Promise<ArtHit[]> }> = [];
  for (const query of textQueries) {
    if (sources.includes("papers")) jobs.push({ source: "openalex", query, run: () => openalex.searchWorks(query, 15) });
    if (sources.includes("preprints")) jobs.push({ source: "arxiv", query, run: () => arxiv.searchArxiv(query, 10) });
    if (sources.includes("code")) jobs.push({ source: "github", query, run: () => github.searchRepositories(query, 10) });
  }
  const results = await mapLimit(jobs, 4, async (job) => {
    try {
      const hits = await job.run();
      runs.push({ source: job.source, query: job.query, count: hits.length });
      return hits;
    } catch (error) {
      runs.push({ source: job.source, query: job.query, count: 0, error: message(error) });
      return [];
    }
  });
  const seen = new Map<string, ArtHit>();
  for (const hit of results.flat()) {
    const key = (hit.url ?? hit.id ?? hit.title).toLowerCase();
    if (!seen.has(key) && hit.title) seen.set(key, hit);
  }
  return [...seen.values()];
}

/**
 * Description (or explicit queries) in, one merged relevance-ranked list of
 * patents, papers, preprints and repositories out.
 * Perf: P2 · network-bound, cached per request · CRAP <= 25 (CC 10).
 */
export async function priorArtSearch(input: SearchInput): Promise<SearchOutput> {
  const description = input.description?.trim();
  const explicit = (input.queries ?? []).map((query) => query.trim()).filter(Boolean);
  if (!description && explicit.length === 0) throw new IpError("INVALID_INPUT", "give a description or at least one query");
  const sources = input.sources?.length ? input.sources : [...ALL_SOURCES];
  const generated = generateQueries(description ?? explicit.join(" "));
  const clausesPerQuery = explicit.map((query) => ({ query, clauses: parseBoolean(query) }));
  // Excluded (NOT) words are not ranking terms.
  const queryText = clausesPerQuery.flatMap((entry) => entry.clauses.filter((clause) => !clause.not).flatMap((clause) => clause.any)).join(" ");
  // A user's trailing wildcard (calibrat*) stays a prefix in later CPC queries and in the output.
  const prefixes = new Set([...explicit.join(" ").matchAll(/([a-z0-9-]{3,})\*/gi)].map((match) => match[1]!.toLowerCase()));
  const markPrefix = (term: KeyTerm): KeyTerm => (prefixes.has(term.term) ? { ...term, term: `${term.term}*`, stem: term.term } : term);
  const terms = (description ? generated.terms : keyTerms(queryText, 10)).map(markPrefix);
  // Ranking uses a longer, damped term list than query generation.
  const rankTerms = rankingTerms(description ?? queryText, 30).map(markPrefix);
  const patentQueries = explicit.length > 0 ? explicit : generated.patentQueries;
  const textQueries = explicit.length > 0 ? explicit.slice(0, 3) : generated.textQueries;
  const runs: SearchRun[] = [];
  const notes: string[] = [];

  const [pool, art] = await Promise.all([
    sources.includes("patents")
      ? patentLeg(patentQueries, terms, rankTerms, { hydrate: input.hydrate ?? 50, expand: input.expand ?? true }, runs, notes)
      : Promise.resolve(new Map<string, PatentEntry>()),
    artLeg(textQueries, sources, runs),
  ]);

  const documents: RankDocument[] = [];
  const meta = new Map<string, Omit<Candidate, "rank" | "score" | "coverage" | "matched" | "missing" | "matchedQueries" | "why">>();
  const texts = new Map<string, string>();
  for (const [id, entry] of pool) {
    const doc = patentDoc(id, entry);
    documents.push(doc);
    texts.set(id, Object.values(doc.fields).filter(Boolean).join(" "));
    const metaData = entry.wrapper.applicationMetaData ?? {};
    meta.set(id, {
      source: "patent",
      id,
      title: doc.fields.title ?? "(untitled)",
      date: metaData.effectiveFilingDate ?? metaData.filingDate ?? metaData.earliestPublicationDate,
      effectiveFilingDate: metaData.effectiveFilingDate,
      filingDate: metaData.filingDate,
      publicationDate: metaData.earliestPublicationDate,
      grantDate: metaData.grantDate,
      owner: odp.currentOwner(entry.wrapper),
      url: patentUrl(entry.wrapper, entry.full),
      status: metaData.applicationStatusDescriptionText,
      textRead: entry.full ? "claims" : "title",
      foundBy: [...entry.foundBy],
      applicationNumber: entry.wrapper.applicationNumberText,
      provenance: entry.provenance,
    });
  }
  for (const hit of art) {
    const id = `${hit.kind}:${hit.id || hit.url || hit.title}`;
    documents.push({ id, fields: { title: hit.title, abstract: hit.summary } });
    texts.set(id, `${hit.title} ${hit.summary ?? ""}`);
    meta.set(id, {
      source: hit.kind,
      id: hit.id || hit.url || hit.title,
      title: hit.title,
      date: hit.date,
      owner: hit.authors?.slice(0, 3).join(", "),
      url: hit.url,
      textRead: hit.summary ? "abstract" : "title",
      foundBy: [hit.provenance.provider],
      provenance: hit.provenance,
    });
  }

  // Patents (claims and description) and abstracts differ in length by two
  // orders of magnitude, so BM25 is normalized within each group. The merged
  // score adds how much of the description's term weight a document covers,
  // which a short repository blurb cannot fake.
  const docById = new Map(documents.map((doc) => [doc.id, doc]));
  const groupOf = (id: string): string => (pool.has(id) ? "patent" : meta.get(id)?.source === "code" ? "code" : "literature");
  const ranked = ["patent", "literature", "code"].flatMap((group) => {
    const results = rankDocuments(documents.filter((doc) => groupOf(doc.id) === group), rankTerms);
    const top = results[0]?.score || 1;
    return results.map((result) => {
      const index = clausesPerQuery.length > 0 ? documentIndex(docById.get(result.id)!) : undefined;
      const matchedQueries = index ? clausesPerQuery.filter((entry) => matchesAll(entry.clauses, index)).map((entry) => entry.query) : [];
      let score = 0.5 * weightedCoverage(rankTerms, result.matched) + 0.5 * (result.score / top);
      // An explicit boolean query that the document's own text does not satisfy halves its score.
      if (clausesPerQuery.length > 0 && matchedQueries.length === 0) score /= 2;
      return { ...result, score: Math.round(score * 1000) / 1000, matchedQueries };
    });
  });
  ranked.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  const limit = input.limit ?? 25;
  const results: Candidate[] = ranked.slice(0, limit).map((result, index) => {
    const base = meta.get(result.id)!;
    const entry = pool.get(result.id);
    const claimsText = entry?.full?.claims.filter((claim) => claim.independent).map((claim) => claim.text).join(" ");
    const passage = bestPassage(claimsText || texts.get(result.id) || "", rankTerms.slice(0, 12));
    return {
      ...base,
      rank: index + 1,
      score: result.score,
      coverage: Math.round(weightedCoverage(rankTerms, result.matched) * 100) / 100,
      matched: result.matched,
      missing: result.missing,
      matchedQueries: result.matchedQueries,
      why: passage.passage ? `${claimsText ? "Independent claim" : "Text"} shares ${passage.shared.join(", ")}: "${passage.passage}"` : undefined,
    };
  });

  notes.push(
    "Patents are found by title, CPC class and citation links in the USPTO Open Data Portal, then re-ranked on full text and claims. A patent whose title, class and citations miss every query is not seen. The PatentsView search API that once offered full-text search was retired in 2026.",
    "A low or zero score is not evidence of novelty. Read the claims of every candidate before relying on a ranking.",
    "date is the earliest relevant date: a patent's effective filing date (else its filing date, else its earliest publication date), a paper's or preprint's publication date, a repository's creation date. A patent's grant date is the separate grantDate field.",
  );
  return {
    terms: terms.map((term) => ({ term: term.term, weight: term.weight })),
    queries: { patent: sources.includes("patents") ? patentQueries : [], text: textQueries },
    results,
    runs,
    notes: [...new Set(notes)],
  };
}

export interface ClaimOverlap {
  number: number;
  text: string;
  shared: string[];
  notInClaim: string[];
}

export interface PatentReading {
  id: string;
  applicationNumber?: string;
  title?: string;
  owner?: string;
  status?: string;
  filingDate?: string;
  grantDate?: string;
  term: TermEstimate;
  claimCount: number;
  independentClaims: ClaimOverlap[];
  citedUsCount: number;
  textSource?: "grant" | "publication";
  why?: string;
  /** How the number was read, when more than one reading was possible. */
  note?: string;
  url?: string;
  provenance: Provenance[];
}

/**
 * Resolve a grant or application number to its file wrapper. Eight-digit
 * values are ambiguous (see numbers.ts); a grant reading is tried first.
 * Perf: P1 · 1-2 requests · CRAP <= 10 (CC 4).
 */
async function wrapperFor(identifier: string): Promise<{ wrapper: odp.OdpWrapper; note?: string } | undefined> {
  const parsed = parsePatentNumber(identifier);
  if (parsed.kind === "publication" || parsed.kind === "pct") {
    throw new IpError("INVALID_INPUT", `${identifier} is a ${parsed.kind} number`, { hint: "Pass a US grant number or an application number." });
  }
  const readings = parsed.kind === "ambiguous" ? parsed.alternatives.map((entry) => entry.kind) : [parsed.kind];
  for (const kind of readings.includes("grant") ? ["grant", ...readings.filter((k) => k !== "grant")] : readings) {
    const found = kind === "grant" ? (await odp.byPatentNumbers([parsed.digits]))[0] : (await odp.searchTitles(`applicationNumberText:${parsed.digits}`, 1)).wrappers[0];
    if (!found) continue;
    const other = parsed.alternatives.find((entry) => entry.kind !== kind);
    return { wrapper: found, note: other ? `${identifier} fits both a grant and an application number; read as the ${kind}. Pass ${other.display} to read the ${other.kind}.` : undefined };
  }
  return undefined;
}

/**
 * Read one patent: owner, status, term estimate, independent claims, and, when
 * a description is given, which of its key terms each independent claim shares.
 * Perf: P1 · 2-3 ODP requests, cached · CRAP <= 15 (CC 8).
 */
export async function readPatent(identifier: string, description?: string): Promise<PatentReading> {
  if (!config.providers.odp.key) {
    throw new IpError("CREDENTIAL_MISSING", "USPTO Open Data Portal key is not configured", {
      provider: "odp",
      hint: "Create a key at https://data.uspto.gov (Manage API Key) and set USPTO_ODP_API_KEY.",
    });
  }
  const resolved = await wrapperFor(identifier);
  if (!resolved) throw new IpError("NOT_FOUND", `no USPTO record for ${identifier}`, { provider: "odp", hint: "Pass a US patent number (9765584) or an application number (15/234,567)." });
  const { wrapper } = resolved;
  const meta = wrapper.applicationMetaData ?? {};
  const provenance: Provenance[] = [];
  const full = await odp.fullTextFor(wrapper);
  if (full) provenance.push(full.provenance);
  let earliest: string | undefined;
  let continuity: "checked" | "failed" | undefined;
  if (wrapper.applicationNumberText) {
    try {
      earliest = await odp.earliestNonProvisional(wrapper.applicationNumberText);
      continuity = "checked";
    } catch {
      continuity = "failed";
    }
  }
  const term = estimateTerm({
    status: meta.applicationStatusDescriptionText,
    applicationType: meta.applicationTypeCode ?? meta.applicationTypeLabelName,
    filingDate: meta.filingDate,
    earliestNonProvisionalDate: earliest,
    continuity,
    grantDate: meta.grantDate,
    ptaDays: wrapper.patentTermAdjustmentData?.adjustmentTotalQuantity,
    events: (wrapper.eventDataBag ?? []).map((event) => ({ date: event.eventDate, description: event.eventDescriptionText })),
  });
  const terms = description ? keyTerms(description, 12) : [];
  const independentClaims = (full?.text.claims ?? []).filter((claim) => claim.independent).map((claim) => {
    const stems = new Set(claim.text.toLowerCase().split(/\W+/).map(stem));
    return {
      number: claim.number,
      text: claim.text,
      shared: terms.filter((term) => stems.has(term.stem)).map((term) => term.term),
      notInClaim: terms.filter((term) => !stems.has(term.stem)).map((term) => term.term),
    };
  });
  const best = [...independentClaims].sort((a, b) => b.shared.length - a.shared.length)[0];
  const id = meta.patentNumber ? `US${meta.patentNumber}` : `US-APP-${wrapper.applicationNumberText}`;
  return {
    id,
    applicationNumber: wrapper.applicationNumberText,
    title: full?.text.title ?? meta.inventionTitle,
    owner: odp.currentOwner(wrapper),
    status: meta.applicationStatusDescriptionText,
    filingDate: meta.filingDate,
    grantDate: meta.grantDate,
    term,
    claimCount: full?.text.claims.length ?? 0,
    independentClaims,
    citedUsCount: full?.text.citedUs.length ?? 0,
    textSource: full?.source,
    why:
      best && terms.length > 0
        ? `Claim ${best.number} shares ${best.shared.length} of ${terms.length} key terms (${best.shared.join(", ") || "none"}); not in that claim: ${best.notInClaim.join(", ") || "none"}. Term overlap is a pointer for a human read, not an element-by-element comparison.`
        : undefined,
    note: resolved.note,
    url: patentUrl(wrapper, full?.text),
    provenance,
  };
}
