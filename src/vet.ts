/**
 * Disclosure scan, freedom-to-operate charts, and the per-feature vet.
 * Composes providers with pure domain logic; provider failures become notes.
 */
import { IpError } from "./errors.js";
import { assessDisclosure, type DisclosureAssessment } from "./domain/disclosure.js";
import { chartClaims, FTO_DISCLAIMER, type ClaimChart } from "./domain/fto.js";
import { decide, deriveSignatures, fingerprints, provisionalSection, splitFeatures, type Feature, type Fingerprint, type Verdict } from "./domain/vet.js";
import * as archives from "./providers/archives.js";
import { mapLimit, priorArtSearch, readPatent, type Candidate, type PatentReading } from "./research.js";

export interface TimelineEvent {
  date: string;
  source: "wayback" | "urlscan" | "archive.today" | "live";
  url: string;
  /** "match": the signature text was in the content; "capture": the page was public then, content not checked; "no-match": checked, not found. */
  kind: "match" | "capture" | "no-match";
  signature?: string;
}

export interface DisclosureScan {
  earliestMatch?: TimelineEvent;
  earliestCapture?: TimelineEvent;
  timeline: TimelineEvent[];
  notes: string[];
  assessment?: DisclosureAssessment;
}

function firstSignature(text: string, signatures: string[]): string | undefined {
  const haystack = text.toLowerCase();
  return signatures.find((signature) => haystack.includes(signature.toLowerCase()));
}

/**
 * Earliest Wayback capture of a URL that contains a signature, assuming a
 * feature stays on a page once it appears: probe the newest capture and a few
 * evenly spaced ones, then binary-search between the last miss and the first hit.
 * Perf: P2 · at most about 6 + log2(captures) fetches per URL · CRAP <= 15 (CC 8).
 */
export async function earliestWaybackMatch(
  captures: archives.Capture[],
  signatures: string[],
  fetch: (capture: archives.Capture) => Promise<string> = archives.waybackContent,
): Promise<{ capture: archives.Capture; signature: string } | undefined> {
  if (captures.length === 0) return undefined;
  const memo = new Map<number, string | undefined>();
  const probe = async (index: number): Promise<string | undefined> => {
    if (!memo.has(index)) memo.set(index, firstSignature(await fetch(captures[index]!).catch(() => ""), signatures));
    return memo.get(index);
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
  if (hit < 0) return undefined;
  let low = samples[samples.indexOf(hit) - 1] ?? -1;
  let high = hit;
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (await probe(mid)) high = mid;
    else low = mid;
  }
  return { capture: captures[high]!, signature: (await probe(high))! };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Where and since when a feature's signatures are public on the given pages.
 * Perf: P2 · network-bound, bounded per URL · CRAP <= 15 (CC 9).
 */
export async function disclosureScan(urls: string[], signatures: string[]): Promise<DisclosureScan> {
  if (urls.length === 0 || signatures.length === 0) throw new IpError("INVALID_INPUT", "give at least one page URL and one signature");
  const timeline: TimelineEvent[] = [];
  const notes: string[] = [];
  const hosts = [...new Set(urls.map((url) => new URL(url).host))];
  await mapLimit(urls, 2, async (url) => {
    try {
      let pages = [url];
      let captures = await archives.waybackCaptures(url);
      if (captures.length === 0) {
        // The URL itself may only have been captured as a redirect; search the host's archived HTML pages instead.
        pages = await archives.waybackPages(new URL(url).host);
        if (pages.length > 0) notes.push(`wayback: no direct capture of ${url}; searched ${pages.length} archived page(s) on its host`);
      }
      for (const page of pages) {
        if (page !== url) captures = await archives.waybackCaptures(page);
        if (captures[0]) timeline.push({ date: captures[0].date, source: "wayback", url: page, kind: "capture" });
        const found = await earliestWaybackMatch(captures, signatures);
        if (found) timeline.push({ date: found.capture.date, source: "wayback", url: page, kind: "match", signature: found.signature });
        else if (captures.length > 0) notes.push(`wayback: no capture of ${page} contains a signature`);
      }
    } catch (error) {
      notes.push(`wayback ${url} failed: ${message(error)}`);
    }
    try {
      const captures = await archives.archiveTodayCaptures(url);
      if (captures[0]) timeline.push({ date: captures[0].date, source: "archive.today", url, kind: "capture" });
    } catch (error) {
      notes.push(`archive.today ${url} unavailable: ${message(error)}`);
    }
    try {
      const signature = firstSignature(await archives.livePage(url), signatures);
      timeline.push({ date: new Date().toISOString(), source: "live", url, kind: signature ? "match" : "no-match", signature });
    } catch (error) {
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
  const earliestMatch = timeline.find((event) => event.kind === "match");
  const earliestCapture = timeline.find((event) => event.kind === "capture");
  notes.push(
    "Archives hold only what they crawled: a page can have been public earlier than its first capture. A capture without a match shows the page was public, not that it showed the feature.",
    "urlscan lists the earliest of the host's 100 most recent public scans, not necessarily its first scan.",
  );
  return {
    earliestMatch,
    earliestCapture,
    timeline,
    notes,
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

/**
 * Element charts for in-force patents only; expired, lapsed, abandoned and
 * pending records are listed as skipped. Perf: P1 · one patent_read per number · CRAP <= 10 (CC 5).
 */
export async function ftoCharts(numbers: string[], feature: string): Promise<{ charts: PatentChart[]; skipped: Array<{ id: string; reason: string }>; disclaimer: string }> {
  const charts: PatentChart[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  const readings = await mapLimit(numbers, 3, (number) => readPatent(number, feature).then((reading) => ({ number, reading }), (error: unknown) => ({ number, error: message(error) })));
  for (const entry of readings) {
    if (!("reading" in entry)) {
      skipped.push({ id: entry.number, reason: entry.error });
      continue;
    }
    const reading: PatentReading = entry.reading;
    if (reading.term.inForce !== "in-force" && reading.term.inForce !== "uncertain") {
      skipped.push({ id: reading.id, reason: `not in force (${reading.term.inForce})` });
      continue;
    }
    const claims = chartClaims(reading.independentClaims.map((claim) => ({ number: claim.number, text: claim.text })), feature);
    const flag = claims.some((claim) => claim.flag === "all-elements-present") ? "all-elements-present" : claims.every((claim) => claim.flag === "element-absent") ? "element-absent" : "review";
    charts.push({ id: reading.id, title: reading.title, owner: reading.owner, inForce: reading.term.inForce, estimatedExpiry: reading.term.estimatedExpiry, claims, flag });
  }
  return { charts, skipped, disclaimer: FTO_DISCLAIMER };
}

export interface FeatureVet {
  feature: Feature;
  closestArt: Candidate[];
  fto: Awaited<ReturnType<typeof ftoCharts>>;
  disclosure?: DisclosureScan;
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
  /** Whether the features can be seen from outside the product. */
  detectable?: boolean;
  /** Patents to chart per feature (default 5). */
  chartTop?: number;
}

/**
 * Vet one feature: prior-art search, element charts for the in-force top
 * patents, disclosure scan, verdict, provisional-ready section, fingerprints.
 * Perf: P2 · one prior-art search plus up to chartTop patent reads · CRAP <= 15 (CC 6).
 */
async function vetFeature(feature: Feature, input: VetInput): Promise<FeatureVet> {
  const search = await priorArtSearch({ description: feature.description, limit: 25, hydrate: 30 });
  const patents = search.results.filter((hit) => hit.source === "patent" && !hit.id.startsWith("US-APP-"));
  const fto = await ftoCharts(patents.slice(0, input.chartTop ?? 5).map((hit) => hit.id.replace(/^US/, "")), feature.description);
  const signatures = feature.signatures?.length ? feature.signatures : deriveSignatures(feature.description);
  const notes: string[] = [];
  let disclosure: DisclosureScan | undefined;
  if (input.sites && input.sites.length > 0) {
    if (signatures.length > 0) disclosure = await disclosureScan(input.sites, signatures);
    else notes.push("Disclosure scan skipped: the description repeats no distinctive phrase. Pass the exact strings that would show this feature as its signatures.");
  }
  const us = disclosure?.assessment?.jurisdictions.find((entry) => entry.code === "US");
  const verdict = decide({
    closestCoverage: search.results[0]?.coverage ?? 0,
    ftoFlags: fto.charts.filter((chart) => chart.flag === "all-elements-present").map((chart) => chart.id),
    disclosedOn: disclosure?.earliestMatch?.date.slice(0, 10),
    usGrace: us?.status === "closed" ? "closed" : us ? "open" : undefined,
    usDeadline: us?.deadline,
    detectable: input.detectable,
  });
  const closestArt = search.results.slice(0, 5);
  return {
    feature,
    closestArt,
    fto,
    disclosure,
    verdict,
    provisional: provisionalSection({ feature, closestArt: closestArt.map((hit) => ({ id: hit.id, title: hit.title, date: hit.date })) }),
    fingerprints: fingerprints(feature.name, signatures),
    notes: [...notes, ...search.notes, ...search.runs.filter((run) => run.error).map((run) => `${run.source} "${run.query}" failed: ${run.error}`)],
  };
}

/**
 * Vet a description feature by feature (the default), or as one whole.
 * Perf: P2 · features run one after another to stay inside provider limits · CRAP <= 10 (CC 4).
 */
export async function vet(input: VetInput): Promise<{ features: FeatureVet[]; disclaimer: string }> {
  const features = input.features?.length
    ? input.features
    : input.description
      ? input.whole
        ? [{ name: input.description.trim().split(/\s+/).slice(0, 8).join(" "), description: input.description.trim() }]
        : splitFeatures(input.description)
      : [];
  if (features.length === 0) throw new IpError("INVALID_INPUT", "give a description or a list of features");
  const results: FeatureVet[] = [];
  for (const feature of features.slice(0, 10)) results.push(await vetFeature(feature, input));
  return {
    features: results,
    disclaimer: "Not legal advice. Prior-art ranking, element charts, disclosure dates, and the recommendation are triage aids for a licensed practitioner.",
  };
}
