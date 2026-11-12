/**
 * Disclosure scan, freedom-to-operate charts, and the per-feature vet.
 * Composes providers with pure domain logic; provider failures become notes.
 */
import { IpError } from "./errors.js";
import { assessDisclosure, type DisclosureAssessment } from "./domain/disclosure.js";
import { chartClaims, FTO_DISCLAIMER, type ClaimChart } from "./domain/fto.js";
import { decide, deriveSignatures, fingerprints, provisionalSection, splitFeatures, type Feature, type Fingerprint, type Verdict } from "./domain/vet.js";
import * as archives from "./providers/archives.js";
import { mapLimit, priorArtSearch, readPatent, type Candidate, type PatentReading, type SearchOutput } from "./research.js";

/** Features vetted per call, patents charted in force per feature, and candidates read to find them. */
export const MAX_FEATURES = 10;
export const FTO_CHARTED = 5;
export const FTO_MAX_READS = 15;
/** Other archived pages on a host searched when a URL has no capture of its own. */
export const WAYBACK_FALLBACK_PAGES = 3;

export interface TimelineEvent {
  date: string;
  source: "wayback" | "urlscan" | "archive.today" | "live";
  url: string;
  /** "match": the signature text was in the content; "capture": the page was public then, content not checked; "no-match": checked, not found. */
  kind: "match" | "capture" | "no-match";
  signature?: string;
}

export interface DisclosureScan {
  /** Earliest archive capture containing a signature: the latest date the feature can have become public. */
  earliestMatch?: TimelineEvent;
  /** A signature seen on a live page now; with no archive match, the first public date is unknown. */
  liveMatch?: TimelineEvent;
  earliestCapture?: TimelineEvent;
  timeline: TimelineEvent[];
  notes: string[];
  /** A fetch failed or a page was cut short, so a match may have been missed or dated too late. */
  incomplete: boolean;
  /** Grace arithmetic from `earliestMatch` only; never from a live-only match. */
  assessment?: DisclosureAssessment;
}

function firstSignature(text: string, signatures: string[]): string | undefined {
  const haystack = text.toLowerCase();
  return signatures.find((signature) => haystack.includes(signature.toLowerCase()));
}

/**
 * Earliest Wayback capture of a URL that contains a signature, assuming a
 * feature stays on a page once it appears: probe the first and last capture and
 * a few evenly spaced ones, then binary-search between the last miss and the
 * first hit. A fetch that fails is neither a hit nor a miss: it is not
 * remembered and is counted in `failed`, because the match may be earlier.
 * Perf: P2 · at most about 6 + log2(captures) fetches per URL · CRAP <= 15 (CC 9).
 */
export async function earliestWaybackMatch(
  captures: archives.Capture[],
  signatures: string[],
  fetch: (capture: archives.Capture) => Promise<string> = archives.waybackContent,
): Promise<{ found?: { capture: archives.Capture; signature: string }; failed: number }> {
  if (captures.length === 0) return { failed: 0 };
  const memo = new Map<number, string | undefined>();
  const failed = new Set<number>();
  const probe = async (index: number): Promise<string | undefined> => {
    if (memo.has(index)) return memo.get(index);
    let text: string;
    try {
      text = await fetch(captures[index]!);
    } catch {
      failed.add(index);
      return undefined;
    }
    const signature = firstSignature(text, signatures);
    memo.set(index, signature);
    return signature;
  };
  const last = captures.length - 1;
  const samples = [...new Set([0, ...[1, 2, 3, 4].map((step) => Math.floor((last * step) / 5)), last])].sort((a, b) => a - b);
  let hit = -1;
  for (const index of samples) {
    if (await probe(index)) {
      hit = index;
      break;
    }
  }
  if (hit < 0) return { failed: failed.size };
  let low = samples[samples.indexOf(hit) - 1] ?? -1;
  let high = hit;
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (await probe(mid)) high = mid;
    else low = mid;
  }
  return { found: { capture: captures[high]!, signature: (await probe(high))! }, failed: failed.size };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Wayback timeline of one URL. A URL with no capture of its own (it may only
 * have been captured as a redirect) falls back to at most
 * WAYBACK_FALLBACK_PAGES other archived HTML pages on its host; every event
 * names the page it came from, never the URL that was asked about. Returns
 * whether anything could not be checked.
 * Perf: P2 · 1 + pages CDX requests and at most about 15 fetches per page · CRAP <= 20 (CC 11).
 */
async function waybackTimeline(url: string, signatures: string[], timeline: TimelineEvent[], notes: string[]): Promise<boolean> {
  let incomplete = false;
  try {
    const direct = await archives.waybackCaptures(url);
    let pages = [url];
    if (direct.length === 0) {
      pages = await archives.waybackPages(new URL(url).host, WAYBACK_FALLBACK_PAGES);
      notes.push(
        pages.length > 0
          ? `wayback: no direct capture of ${url}; searched ${pages.length} other archived page(s) on its host (at most ${WAYBACK_FALLBACK_PAGES}): ${pages.join(", ")}`
          : `wayback: no capture of ${url} or of any other archived HTML page on its host`,
      );
    }
    for (const page of pages) {
      const captures = page === url ? direct : await archives.waybackCaptures(page);
      if (captures[0]) timeline.push({ date: captures[0].date, source: "wayback", url: page, kind: "capture" });
      if (captures.length >= archives.WAYBACK_CAPTURE_LIMIT) {
        notes.push(`wayback: ${page} has at least ${captures.length} distinct captures; only the oldest ${archives.WAYBACK_CAPTURE_LIMIT} were searched, so a feature that first appeared later is not found`);
      }
      const { found, failed } = await earliestWaybackMatch(captures, signatures);
      if (found) timeline.push({ date: found.capture.date, source: "wayback", url: page, kind: "match", signature: found.signature });
      else if (captures.length > 0) notes.push(`wayback: no capture of ${page} contains a signature`);
      if (failed > 0) {
        incomplete = true;
        notes.push(`wayback: ${failed} capture fetch(es) of ${page} failed; ${found ? `the earliest match may be earlier than ${found.capture.date.slice(0, 10)}` : "a match may have been missed"}`);
      }
    }
  } catch (error) {
    incomplete = true;
    notes.push(`wayback ${url} failed: ${message(error)}`);
  }
  return incomplete;
}

/**
 * Where and since when a feature's signatures are public on the given pages.
 * An archive match dates the feature no later than its capture; a live-only
 * match has no date, so it carries no grace deadline.
 * Perf: P2 · network-bound, bounded per URL · CRAP <= 15 (CC 10).
 */
export async function disclosureScan(urls: string[], signatures: string[]): Promise<DisclosureScan> {
  if (urls.length === 0 || signatures.length === 0) throw new IpError("INVALID_INPUT", "give at least one page URL and one signature");
  const timeline: TimelineEvent[] = [];
  const notes: string[] = [];
  let incomplete = false;
  const hosts = [...new Set(urls.map((url) => new URL(url).host))];
  await mapLimit(urls, 2, async (url) => {
    if (await waybackTimeline(url, signatures, timeline, notes)) incomplete = true;
    try {
      const captures = await archives.archiveTodayCaptures(url);
      if (captures[0]) timeline.push({ date: captures[0].date, source: "archive.today", url, kind: "capture" });
    } catch (error) {
      notes.push(`archive.today ${url} unavailable: ${message(error)}`);
    }
    try {
      const page = await archives.livePage(url);
      const signature = firstSignature(page.text, signatures);
      timeline.push({ date: new Date().toISOString(), source: "live", url, kind: signature ? "match" : "no-match", signature });
      if (page.truncated && !signature) {
        incomplete = true;
        notes.push(`live ${url}: only the first ${archives.LIVE_PAGE_LIMIT / (1024 * 1024)} MB was read; a signature further in would not be found`);
      }
    } catch (error) {
      incomplete = true;
      notes.push(`live ${url} failed: ${message(error)}`);
    }
  });
  await mapLimit(hosts, 2, async (host) => {
    try {
      const scans = await archives.urlscanScans(host);
      if (scans[0]) timeline.push({ date: scans[0].date, source: "urlscan", url: scans[0].url, kind: "capture" });
    } catch (error) {
      notes.push(`urlscan ${host} failed: ${message(error)}`);
    }
  });
  timeline.sort((a, b) => a.date.localeCompare(b.date));
  const earliestMatch = timeline.find((event) => event.kind === "match" && event.source !== "live");
  const liveMatch = timeline.find((event) => event.kind === "match" && event.source === "live");
  const earliestCapture = timeline.find((event) => event.kind === "capture");
  if (!earliestMatch && liveMatch) {
    notes.push(`Seen live on ${liveMatch.date.slice(0, 10)} (${liveMatch.url}) but in no archive capture: it is public now and its first public date is unknown, so the US grace period may already have run. No deadline is computed.`);
  }
  notes.push(
    "Archives hold only what they crawled: a page can have been public earlier than its first capture, so a match date is the latest the feature can have become public and a US deadline computed from it is the latest it can be. A capture without a match shows the page was public, not that it showed the feature.",
    "urlscan lists the earliest of the host's 100 most recent public scans, not necessarily its first scan.",
  );
  return {
    earliestMatch,
    liveMatch,
    earliestCapture,
    timeline,
    notes,
    incomplete,
    assessment: earliestMatch ? assessDisclosure({ disclosureDate: earliestMatch.date.slice(0, 10), disclosureKind: "publication", byInventor: true }) : undefined,
  };
}

export interface PatentChart {
  id: string;
  title?: string;
  owner?: string;
  inForce: string;
  estimatedExpiry?: string;
  claims: ClaimChart[];
  flag: "all-elements-present" | "element-absent" | "review";
}

export interface SkippedPatent {
  id: string;
  reason: string;
  /** True when the patent could not be read, so nothing is known about whether it needs clearing. */
  unreadable?: boolean;
}

const OUT_OF_FORCE = new Set(["expired", "lapsed", "abandoned", "pending"]);

/**
 * Element charts for the first `top` patents that are not known to be out of
 * force, read in the order given; expired, lapsed, abandoned and pending
 * records, and patents whose claims could not be read, are listed as skipped
 * with the reason. A patent whose status is uncertain or unknown is charted.
 * Perf: P1 · one patent_read per number read, in batches of the charts still needed · CRAP <= 15 (CC 8).
 */
export async function ftoCharts(numbers: string[], feature: string, top = numbers.length): Promise<{ charts: PatentChart[]; skipped: SkippedPatent[]; disclaimer: string }> {
  const charts: PatentChart[] = [];
  const skipped: SkippedPatent[] = [];
  for (let next = 0; next < numbers.length && charts.length < top; ) {
    const batch = numbers.slice(next, next + top - charts.length);
    next += batch.length;
    const readings = await mapLimit(batch, 3, (number) => readPatent(number, feature).then((reading) => ({ number, reading }), (error: unknown) => ({ number, error: message(error) })));
    for (const entry of readings) {
      if (!("reading" in entry)) {
        skipped.push({ id: entry.number, reason: `could not be read: ${entry.error}`, unreadable: true });
        continue;
      }
      const reading: PatentReading = entry.reading;
      if (OUT_OF_FORCE.has(reading.term.inForce)) {
        skipped.push({ id: reading.id, reason: `not in force (${reading.term.inForce})` });
        continue;
      }
      if (reading.independentClaims.length === 0) {
        skipped.push({ id: reading.id, reason: "claims not readable", unreadable: true });
        continue;
      }
      const claims = chartClaims(reading.independentClaims.map((claim) => ({ number: claim.number, text: claim.text })), feature);
      const flag = claims.some((claim) => claim.flag === "all-elements-present") ? "all-elements-present" : claims.every((claim) => claim.flag === "element-absent") ? "element-absent" : "review";
      charts.push({ id: reading.id, title: reading.title, owner: reading.owner, inForce: reading.term.inForce, estimatedExpiry: reading.term.estimatedExpiry, claims, flag });
    }
  }
  return { charts, skipped, disclaimer: FTO_DISCLAIMER };
}

export interface FeatureVet {
  feature: Feature;
  closestArt: Candidate[];
  fto: Awaited<ReturnType<typeof ftoCharts>>;
  disclosure?: DisclosureScan;
  /** Why the disclosure check did not run, when it did not. */
  disclosureSkipped?: string;
  verdict: Verdict;
  provisional: string;
  fingerprints: Fingerprint[];
  notes: string[];
}

export interface VetInput {
  /** Free text; split into features (headings, bullets, or paragraphs) unless `whole` is true. */
  description?: string;
  features?: Feature[];
  whole?: boolean;
  /** Public pages to check for each feature's signatures. */
  sites?: string[];
  /** Signatures for every feature that has none of its own. */
  signatures?: string[];
  /** Whether the features can be seen from outside the product. */
  detectable?: boolean;
}

/**
 * What a prior-art search could not cover: skipped or failed sources and
 * unread full texts. Perf: P0 · O(runs + notes) · CRAP <= 10 (CC 5).
 */
export function searchGaps(search: Pick<SearchOutput, "runs" | "notes">): string[] {
  const failedSources = [...new Set(search.runs.filter((run) => run.error).map((run) => run.source))];
  const unreadFullTexts = search.notes.filter((note) => note.startsWith("full text for ")).length;
  return [
    ...(search.notes.some((note) => note.startsWith("patents skipped")) ? ["patents were not searched (USPTO_ODP_API_KEY not set)"] : []),
    ...(failedSources.length > 0 ? [`searches failed: ${failedSources.join(", ")}`] : []),
    ...(unreadFullTexts > 0 ? [`full text unread for ${unreadFullTexts} patent(s)`] : []),
  ];
}

/** Failed search runs, one note per source. Perf: P0 · O(runs) · CRAP <= 10 (CC 4). */
function failedRunNotes(runs: SearchOutput["runs"]): string[] {
  const bySource = new Map<string, SearchOutput["runs"]>();
  for (const run of runs) bySource.set(run.source, [...(bySource.get(run.source) ?? []), run]);
  return [...bySource.entries()].flatMap(([source, list]) => {
    const failed = list.filter((run) => run.error);
    return failed.length > 0 ? [`${source}: ${failed.length} of ${list.length} search run(s) failed, e.g. "${failed[0]!.query}": ${failed[0]!.error}`] : [];
  });
}

/**
 * Vet one feature: prior-art search, element charts for the first
 * FTO_CHARTED in-force patents (reading at most FTO_MAX_READS candidates),
 * disclosure scan, verdict, provisional-ready section, fingerprints.
 * Perf: P2 · one prior-art search plus up to FTO_MAX_READS patent reads · CRAP <= 20 (CC 11).
 */
async function vetFeature(feature: Feature, input: VetInput): Promise<FeatureVet> {
  const search = await priorArtSearch({ description: feature.description, limit: 25, hydrate: 30 });
  const patents = search.results.filter((hit) => hit.source === "patent" && !hit.id.startsWith("US-APP-"));
  const fto = await ftoCharts(patents.slice(0, FTO_MAX_READS).map((hit) => hit.id.replace(/^US/, "")), feature.description, FTO_CHARTED);
  const given = feature.signatures?.length ? feature.signatures : input.signatures;
  const signatures = given?.length ? given : deriveSignatures(feature.description);
  const notes: string[] = [];
  if (signatures.length > 0 && !given?.length) {
    notes.push(`Signatures were derived from the description (${signatures.join("; ")}), not given: a generic phrase can match ordinary page copy. Pass the exact strings that would show this feature for a reliable check.`);
  }
  const gaps = searchGaps(search);
  const unreadable = fto.skipped.filter((entry) => entry.unreadable).length;
  if (unreadable > 0) gaps.push(`${unreadable} candidate patent(s) could not be charted (not read, or claims not readable)`);
  if (fto.charts.length < FTO_CHARTED && patents.length > FTO_MAX_READS) gaps.push(`only the top ${FTO_MAX_READS} granted candidates were read for charting; ${patents.length - FTO_MAX_READS} more were not`);
  let disclosure: DisclosureScan | undefined;
  let disclosureSkipped: string | undefined;
  if (!input.sites || input.sites.length === 0) disclosureSkipped = "no sites given; pass the public pages to check";
  else if (signatures.length === 0) disclosureSkipped = "no signatures given and none could be derived from the description; pass the exact strings that would show this feature";
  else disclosure = await disclosureScan(input.sites, signatures);
  if (disclosureSkipped) gaps.push(`public disclosure not checked (${disclosureSkipped})`);
  else if (disclosure?.incomplete) gaps.push("the disclosure scan could not check everything (see notes)");
  const us = disclosure?.assessment?.jurisdictions.find((entry) => entry.code === "US");
  const verdict = decide({
    closestCoverage: search.results[0]?.coverage ?? 0,
    ftoFlags: fto.charts.filter((chart) => chart.flag === "all-elements-present").map((chart) => chart.id),
    disclosedOn: disclosure?.earliestMatch?.date.slice(0, 10),
    seenLiveOn: disclosure?.liveMatch?.date.slice(0, 10),
    usGrace: us?.status === "closed" ? "closed" : us ? "open" : undefined,
    usDeadline: us?.deadline,
    detectable: input.detectable,
    gaps,
  });
  const closestArt = search.results.slice(0, 5);
  return {
    feature,
    closestArt,
    fto,
    disclosure,
    disclosureSkipped,
    verdict,
    provisional: provisionalSection({ feature, closestArt: closestArt.map((hit) => ({ id: hit.id, title: hit.title, date: hit.date })) }),
    fingerprints: fingerprints(feature.name, signatures),
    notes: [...notes, ...search.notes, ...failedRunNotes(search.runs)],
  };
}

/**
 * Vet a description feature by feature (the default), or as one whole. At most
 * MAX_FEATURES are vetted; the rest are named in `notes`.
 * Perf: P2 · features run one after another to stay inside provider limits · CRAP <= 10 (CC 6).
 */
export async function vet(input: VetInput): Promise<{ features: FeatureVet[]; notes: string[]; disclaimer: string }> {
  const features = input.features?.length
    ? input.features
    : input.description
      ? input.whole
        ? [{ name: input.description.trim().split(/\s+/).slice(0, 8).join(" "), description: input.description.trim() }]
        : splitFeatures(input.description)
      : [];
  if (features.length === 0) throw new IpError("INVALID_INPUT", "give a description or a list of features");
  const notes: string[] = [];
  if (features.length > MAX_FEATURES) {
    notes.push(`${features.length - MAX_FEATURES} feature(s) were not vetted because at most ${MAX_FEATURES} are checked per call: ${features.slice(MAX_FEATURES).map((feature) => feature.name).join("; ")}. Run vet again with them.`);
  }
  const results: FeatureVet[] = [];
  for (const feature of features.slice(0, MAX_FEATURES)) results.push(await vetFeature(feature, input));
  return {
    features: results,
    notes,
    disclaimer: "Not legal advice. Prior-art ranking, element charts, disclosure dates, and the recommendation are triage aids for a licensed practitioner.",
  };
}
