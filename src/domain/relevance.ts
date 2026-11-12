/**
 * Query generation, boolean matching, and relevance ranking for prior-art
 * search. Pure functions: no network, no provider imports.
 */

const STOPWORDS = new Set(
  (
    "a an and are as at be been being but by can could do does each either for from had has have having how if in into is it its " +
    "itself may might more most must no nor not of on once only or other our out over own same shall should so some such than that " +
    "the their them then there these they this those through to too under until up upon very was we were what when where which while " +
    "who whom why will with within without would you your also about above after again against all any because before below between " +
    "both during few further here just like make makes made many much new now off one ones per rather really since still thus two use " +
    "used uses using via way ways well whether yet " +
    // Patent and product boilerplate that matches everything.
    "system systems method methods apparatus device devices wherein comprising comprises comprise include includes including " +
    "plurality least based configured operable embodiment embodiments invention present provide provides provided providing " +
    "according associated corresponding respective first second third thereof therein whereby herein example examples feature features " +
    "product products user users data value values set sets number numbers given another call calls calling level levels keep keeps " +
    "every sits sit created create creates auto core optionally optional separate separately standalone only means mean meaning whole " +
    "becomes become beside built readme counts whose form forms along across axis axes way today shipped ships nothing something anything three four five several each"
  ).split(/\s+/),
);

/** Lower-case word tokens with a few characters minimum. Perf: P0 · O(n) · CRAP <= 10 (CC 1). */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((word) => word.length > 2);
}

const STEM_RULES: Array<[RegExp, string]> = [
  [/(encies|ency|ences|ence|ents|ent|ancies|ancy|ances|ance|ants|ant)$/, "en"],
  [/(ational|ation|ations)$/, "at"],
  [/(ization|izations|izing|ized|izes|ize)$/, "iz"],
  [/(ies|ied)$/, "y"],
  [/(ingly|ing|edly|ed|ers|er|ly|(?<!s)s)$/, ""],
  [/(ability|ible|able)$/, "ab"],
  [/(ions|ion)$/, ""],
  [/(ical|ic|al)$/, ""],
  [/y$/, ""],
  [/e$/, ""],
];

/** Words repeat across documents, so stems are remembered; the table is emptied when it grows large. */
const STEM_CACHE_LIMIT = 100_000;
const stemCache = new Map<string, string>();

/**
 * Crude suffix stripper so "invalidation", "invalidates" and "invalidated"
 * share one stem. Not linguistic; good enough to build wildcard queries.
 * Perf: P0 · O(1) after the first sight of a word · CRAP <= 10 (CC 4).
 */
export function stem(word: string): string {
  const known = stemCache.get(word);
  if (known !== undefined) return known;
  let out = word;
  for (const [pattern, replacement] of STEM_RULES) {
    const stemmed = out.replace(pattern, replacement);
    if (stemmed !== out && stemmed.length >= 3) out = stemmed;
  }
  if (stemCache.size >= STEM_CACHE_LIMIT) stemCache.clear();
  stemCache.set(word, out);
  return out;
}

export interface KeyTerm {
  term: string;
  stem: string;
  weight: number;
}

/**
 * Rank the content words of a description by frequency with an early-mention
 * bonus, merging words that share a stem.
 * Perf: P1 · O(n log n) · CRAP <= 15 (CC 5, branch coverage >= 80%).
 */
export function keyTerms(description: string, max = 12): KeyTerm[] {
  const words = tokenize(description).filter((word) => !STOPWORDS.has(word) && !/^\d+$/.test(word));
  const byStem = new Map<string, { counts: Map<string, number>; weight: number }>();
  words.forEach((word, index) => {
    const key = stem(word);
    const entry = byStem.get(key) ?? { counts: new Map<string, number>(), weight: 0 };
    entry.counts.set(word, (entry.counts.get(word) ?? 0) + 1);
    entry.weight += 1 + (index < 40 ? 0.5 : 0);
    byStem.set(key, entry);
  });
  return [...byStem.entries()]
    .map(([key, entry]) => {
      const term = [...entry.counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? key;
      return { term, stem: key, weight: entry.weight };
    })
    .sort((a, b) => b.weight - a.weight || a.term.localeCompare(b.term))
    .slice(0, max);
}

/**
 * Terms for ranking: a longer list than the query terms, with weights damped
 * (1 + ln w) so one word repeated many times cannot dominate the score.
 * Perf: P1 · O(n log n) · CRAP <= 10 (CC 1).
 */
export function rankingTerms(text: string, max = 30): KeyTerm[] {
  return keyTerms(text, max).map((term) => ({ ...term, weight: Math.round((1 + Math.log(term.weight)) * 1000) / 1000 }));
}

/** Share of the total term weight a document matches. Perf: P0 · O(terms) · CRAP <= 10 (CC 2). */
export function weightedCoverage(terms: KeyTerm[], matched: string[]): number {
  const total = terms.reduce((sum, term) => sum + term.weight, 0);
  if (total === 0) return 0;
  const hit = new Set(matched);
  return terms.filter((term) => hit.has(term.term)).reduce((sum, term) => sum + term.weight, 0) / total;
}

/** Adjacent content-word pairs that occur at least twice, as candidate phrases. Perf: P1 · O(n) · CRAP <= 10 (CC 3). */
export function keyPhrases(description: string, max = 4): string[] {
  const words = tokenize(description);
  const counts = new Map<string, number>();
  for (let index = 0; index + 1 < words.length; index += 1) {
    const [a, b] = [words[index]!, words[index + 1]!];
    if (STOPWORDS.has(a) || STOPWORDS.has(b)) continue;
    const phrase = `${a} ${b}`;
    counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([phrase]) => phrase);
}

/** ODP query form for a term: a prefix wildcard for long stems, both forms for short ones. */
export function wildcard(term: KeyTerm): string {
  if (term.stem === term.term) return term.term;
  return term.stem.length >= 4 ? `${term.stem}*` : `(${term.stem} OR ${term.term})`;
}

export interface GeneratedQueries {
  terms: KeyTerm[];
  phrases: string[];
  /** Boolean title queries for the USPTO ODP search (AND, quoted phrases, trailing wildcards). */
  patentQueries: string[];
  /** Short free-text queries for paper and code search engines. */
  textQueries: string[];
}

/**
 * Generate several queries from one description: the anchor term (most
 * weighted) ANDed with each of the next terms, a few triples, and repeated
 * phrases. Several narrow queries beat one long any-term query.
 * Perf: P1 · O(n log n) · CRAP <= 15 (CC 5).
 */
export function generateQueries(description: string, max = 21): GeneratedQueries {
  const terms = keyTerms(description, 12);
  const phrases = keyPhrases(description);
  const patentQueries: string[] = [];
  // Two anchors, each ANDed with the next terms: one generic anchor (a word
  // like "device") cannot then crowd out the specific pairings.
  const anchors = terms.slice(0, 2);
  const others = terms.slice(2, 12);
  if (anchors.length === 2) patentQueries.push(`${wildcard(anchors[0]!)} AND ${wildcard(anchors[1]!)}`);
  for (const other of others) for (const anchor of anchors) patentQueries.push(`${wildcard(anchor)} AND ${wildcard(other)}`);
  if (anchors.length === 1) patentQueries.push(wildcard(anchors[0]!));
  for (const phrase of phrases) patentQueries.push(`"${phrase}"`);
  const textQueries = [
    ...phrases.slice(0, 2).map((phrase) => `"${phrase}" ${terms.slice(0, 2).map((term) => term.term).filter((t) => !phrase.includes(t)).join(" ")}`.trim()),
    terms.slice(0, 3).map((term) => term.term).join(" "),
    [terms[1], terms[2], terms[3]].filter(Boolean).map((term) => term!.term).join(" "),
    [terms[1], terms[4], terms[5]].filter(Boolean).map((term) => term!.term).join(" "),
  ].filter((query, index, all) => query && all.indexOf(query) === index);
  return { terms, phrases, patentQueries: [...new Set(patentQueries)].slice(0, max), textQueries: textQueries.slice(0, 3) };
}

/**
 * Strip USPTO-only syntax (field:value terms, trailing wildcards, parentheses)
 * so a boolean query can go to engines that only take words, quoted phrases,
 * AND, OR and NOT. Perf: P0 · O(n) · CRAP <= 10 (CC 2).
 */
export function plainQuery(query: string): string {
  // A field term may carry a quoted value with spaces (field:"G01B  11/00"); keep it one token.
  return (query.match(/[^\s"]*"[^"]*"|\S+/g) ?? [])
    .filter((token) => token.startsWith('"') || !token.includes(":"))
    .map((token) => (token.startsWith('"') ? token : token.replace(/[()*]/g, "")))
    .filter(Boolean)
    .join(" ")
    .replace(/^(AND|OR|NOT)\s+|\s+(AND|OR|NOT)$/g, "")
    .trim();
}

/**
 * One AND clause. Positive: any alternative must match. With `not`: no
 * alternative may match. Alternatives are normalized like document text (see
 * `tokenize`); phrases are exact word sequences; `*` is a prefix.
 */
export interface Clause {
  any: string[];
  not: boolean;
}

/** A query term in the same form `tokenize` gives document text, so hyphens and short words cannot cause a miss. */
function normalizeAlternative(token: string): string {
  const words = tokenize(token).join(" ");
  return words && token.endsWith("*") ? `${words}*` : words;
}

/**
 * Parse `"exact phrase" AND term OR other AND prefix* NOT excluded` into AND
 * clauses of OR alternatives. Bare adjacent words are ANDed; NOT excludes the
 * next term and any OR alternatives that follow it. Parentheses are ignored.
 * Perf: P1 · O(n) · CRAP <= 15 (CC 11, branch coverage >= 90%).
 */
export function parseBoolean(query: string): Clause[] {
  const clauses: Clause[] = [];
  let last: Clause | undefined;
  let pendingOr = false;
  let pendingNot = false;
  for (const raw of query.match(/"[^"]+"|\S+/g) ?? []) {
    const token = raw.replace(/[()]/g, "");
    if (token === "OR") pendingOr = true;
    else if (token === "NOT") pendingNot = true;
    else if (token && token !== "AND") {
      const alternative = normalizeAlternative(token.replace(/"/g, "").toLowerCase());
      if (alternative && pendingOr && last && !pendingNot) last.any.push(alternative);
      else if (alternative) clauses.push((last = { any: [alternative], not: pendingNot }));
      pendingOr = false;
      pendingNot = false;
    }
  }
  return clauses;
}

/** A document's text, tokenized once, for matching any number of queries. */
export interface TextIndex {
  /** Content words joined by single spaces and padded with one space on each side. */
  normalized: string;
  words: Set<string>;
}

function indexTokens(tokens: string[]): TextIndex {
  return { normalized: ` ${tokens.join(" ")} `, words: new Set(tokens) };
}

/** Tokenize a text once. Perf: P0 · O(n) · CRAP <= 10 (CC 1). */
export function indexText(text: string): TextIndex {
  return indexTokens(tokenize(text));
}

function alternativeMatches(alternative: string, index: TextIndex): boolean {
  const prefix = alternative.endsWith("*");
  const body = prefix ? alternative.slice(0, -1) : alternative;
  if (body.includes(" ")) return index.normalized.includes(prefix ? ` ${body}` : ` ${body} `);
  if (!prefix) return index.words.has(body);
  for (const word of index.words) if (word.startsWith(body)) return true;
  return false;
}

/**
 * True when every positive clause has a matching alternative in the text and
 * no excluded alternative does. Perf: P0 · O(clauses x words) · CRAP <= 10 (CC 2).
 */
export function matchesAll(clauses: Clause[], text: string | TextIndex): boolean {
  const index = typeof text === "string" ? indexText(text) : text;
  return clauses.every((clause) => clause.any.some((alternative) => alternativeMatches(alternative, index)) !== clause.not);
}

export interface RankDocument {
  id: string;
  /** Weighted fields; claims weigh most because they define what is protected. */
  fields: { title?: string; abstract?: string; claims?: string; body?: string };
}

const FIELD_WEIGHT = { title: 2.5, abstract: 2, claims: 3, body: 1 } as const;

interface Prepared {
  tokens: string[];
  stems: Map<string, number>;
}

/** A document is tokenized and stemmed once, however many times it is ranked or matched. */
const prepared = new WeakMap<RankDocument, Prepared>();

function prepare(doc: RankDocument): Prepared {
  const known = prepared.get(doc);
  if (known) return known;
  const tokens: string[] = [];
  const stems = new Map<string, number>();
  for (const [field, weight] of Object.entries(FIELD_WEIGHT) as Array<[keyof typeof FIELD_WEIGHT, number]>) {
    const text = doc.fields[field];
    if (!text) continue;
    for (const word of tokenize(text)) {
      tokens.push(word);
      const key = stem(word);
      stems.set(key, (stems.get(key) ?? 0) + weight);
    }
  }
  const entry = { tokens, stems };
  prepared.set(doc, entry);
  return entry;
}

/** The words of every field of a document, for boolean matching, without tokenizing it again. */
export function documentIndex(doc: RankDocument): TextIndex {
  return indexTokens(prepare(doc).tokens);
}

export interface RankResult {
  id: string;
  score: number;
  matched: string[];
  missing: string[];
}

/**
 * BM25 over the candidate pool with per-field weights. IDF is computed on
 * the pool itself, which is what matters for ordering it.
 * Perf: P1 · O(docs x tokens) first time, O(docs x terms) again · CRAP <= 15 (CC 6, branch coverage >= 80%).
 */
export function rankDocuments(documents: RankDocument[], terms: KeyTerm[], k1 = 1.2, b = 0.75): RankResult[] {
  if (documents.length === 0 || terms.length === 0) return documents.map((doc) => ({ id: doc.id, score: 0, matched: [], missing: terms.map((t) => t.term) }));
  const ready = documents.map((doc) => {
    const { tokens, stems } = prepare(doc);
    return { doc, stems, length: tokens.length };
  });
  const average = ready.reduce((sum, entry) => sum + entry.length, 0) / ready.length || 1;
  const df = new Map<string, number>();
  for (const term of terms) df.set(term.stem, ready.filter((entry) => entry.stems.has(term.stem)).length);
  const n = ready.length;
  return ready
    .map(({ doc, stems, length }) => {
      let score = 0;
      const matched: string[] = [];
      const missing: string[] = [];
      for (const term of terms) {
        const tf = stems.get(term.stem) ?? 0;
        if (tf === 0) {
          missing.push(term.term);
          continue;
        }
        matched.push(term.term);
        const docs = df.get(term.stem) ?? 0;
        const idf = Math.log(1 + (n - docs + 0.5) / (docs + 0.5));
        score += term.weight * idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * length) / average)));
      }
      return { id: doc.id, score: Math.round(score * 1000) / 1000, matched, missing };
    })
    .sort((a, b2) => b2.score - a.score || a.id.localeCompare(b2.id));
}

/**
 * The sentence-sized passage of a text that shares the most key terms, for
 * a "why it overlaps" line. Perf: P1 · O(sentences x terms) · CRAP <= 10 (CC 3).
 */
export function bestPassage(text: string, terms: KeyTerm[], maxLength = 320): { passage: string; shared: string[] } {
  const sentences = text.split(/(?<=[.;:])\s+/).filter((sentence) => sentence.trim().length > 0);
  let best = { passage: "", shared: [] as string[] };
  for (const sentence of sentences) {
    const stems = new Set(tokenize(sentence).map(stem));
    const shared = terms.filter((term) => stems.has(term.stem)).map((term) => term.term);
    if (shared.length > best.shared.length) best = { passage: sentence.trim(), shared };
  }
  if (best.passage.length > maxLength) best.passage = `${best.passage.slice(0, maxLength - 3)}...`;
  return best;
}
