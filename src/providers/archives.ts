/**
 * Public web archives and live pages, for dating when a page first showed a
 * feature: Wayback Machine (CDX and raw captures), urlscan.io (public scans),
 * archive.today (Memento timemap), and the live page itself. No keys.
 */
import { config } from "../config.js";
import { IpError } from "../errors.js";
import { requestJson, requestText } from "../http.js";

export interface Capture {
  /** ISO date-time of the capture. */
  date: string;
  timestamp: string;
  original: string;
  digest?: string;
}

/** 20240102030405 -> 2024-01-02T03:04:05Z. Perf: P0 · O(1) · CRAP <= 10 (CC 1). */
export function waybackDate(timestamp: string): string {
  const t = timestamp.padEnd(14, "0");
  return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}T${t.slice(8, 10)}:${t.slice(10, 12)}:${t.slice(12, 14)}Z`;
}

/**
 * Wayback captures of one URL with status 200, one per distinct content
 * digest, oldest first. Perf: P1 · one request, cached 12 h · CRAP <= 10 (CC 2).
 */
export async function waybackCaptures(url: string, limit = 500): Promise<Capture[]> {
  const result = await requestJson<string[][]>({
    provider: "wayback",
    route: "/cdx/search/cdx",
    query: { url, output: "json", fl: "timestamp,original,digest", filter: "statuscode:200", collapse: "digest", limit },
    rateLimit: { name: "wayback:cdx", perMinute: 30 },
    cache: { ttlMs: 12 * 60 * 60_000 },
  });
  return (result.data ?? []).slice(1).map(([timestamp = "", original = "", digest]) => ({ date: waybackDate(timestamp), timestamp, original, digest }));
}

/**
 * Distinct HTML pages Wayback holds under a host (status 200), for when a URL
 * itself was only captured as a redirect. Perf: P1 · one request, cached 12 h · CRAP <= 10 (CC 1).
 */
export async function waybackPages(host: string, limit = 10): Promise<string[]> {
  const result = await requestJson<string[][]>({
    provider: "wayback",
    route: "/cdx/search/cdx",
    query: { url: `${host}/*`, output: "json", fl: "original,mimetype", filter: "statuscode:200", collapse: "urlkey", limit: limit * 10 },
    rateLimit: { name: "wayback:cdx", perMinute: 30 },
    cache: { ttlMs: 12 * 60 * 60_000 },
  });
  const pages = (result.data ?? []).slice(1).filter(([, mimetype = ""]) => mimetype.startsWith("text/html")).map(([original = ""]) => original).filter(Boolean);
  return [...new Set(pages)].sort((a, b) => a.length - b.length).slice(0, limit);
}

/** Raw (unrewritten) content of one capture. Captures never change, so it is cached 30 days. Perf: P1 · one request · CRAP <= 10 (CC 1). */
export async function waybackContent(capture: Capture): Promise<string> {
  const result = await requestText({
    provider: "wayback",
    route: `/web/${capture.timestamp}id_/${capture.original}`,
    rateLimit: { name: "wayback:content", perMinute: 30 },
    cache: { ttlMs: 30 * 24 * 60 * 60_000 },
  });
  return result.text;
}

export interface ScanHit {
  date: string;
  url: string;
  id: string;
}

/**
 * Public urlscan.io scans of a host, oldest first. The search returns the
 * newest scans, so the first entry is the earliest of the most recent `size`
 * scans, not necessarily the first scan ever. Presence only: a scan proves
 * the page was public on that date, not that it showed the feature.
 * Perf: P1 · one request, cached 12 h · CRAP <= 10 (CC 1).
 */
export async function urlscanScans(host: string, size = 100): Promise<ScanHit[]> {
  const result = await requestJson<{ results?: Array<{ task?: { time?: string; url?: string; uuid?: string }; page?: { url?: string } }> }>({
    provider: "urlscan",
    route: "/api/v1/search/",
    query: { q: `page.domain:${host}`, size },
    rateLimit: { name: "urlscan:search", perMinute: 20 },
    cache: { ttlMs: 12 * 60 * 60_000 },
  });
  return (result.data.results ?? [])
    .map((entry) => ({ date: entry.task?.time ?? "", url: entry.page?.url ?? entry.task?.url ?? "", id: entry.task?.uuid ?? "" }))
    .filter((entry) => entry.date)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** Parse a Memento link-format timemap into capture dates, oldest first. Perf: P0 · O(n) · CRAP <= 10 (CC 1). */
export function parseTimemap(text: string): Array<{ date: string; url: string }> {
  return [...text.matchAll(/<([^>]+)>;\s*rel="[^"]*memento[^"]*";\s*datetime="([^"]+)"/g)]
    .map((match) => ({ url: match[1] ?? "", date: new Date(match[2] ?? "").toISOString() }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * archive.today captures of a URL through its Memento timemap. Often
 * unreachable from automated clients; callers treat failure as a note.
 * Perf: P1 · one request, 15 s timeout · CRAP <= 10 (CC 1).
 */
export async function archiveTodayCaptures(url: string): Promise<Array<{ date: string; url: string }>> {
  const result = await requestText({
    provider: "archivetoday",
    route: `/timemap/${url}`,
    rateLimit: { name: "archivetoday:timemap", perMinute: 10 },
    cache: { ttlMs: 12 * 60 * 60_000 },
    timeoutMs: 15_000,
    retries: 0,
  });
  return parseTimemap(result.text);
}

/**
 * Fetch a live page (http or https only, no credentials, 2 MB cap).
 * Perf: P1 · one request · CRAP <= 10 (CC 3).
 */
export async function livePage(url: string): Promise<string> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new IpError("INVALID_INPUT", `only http and https pages can be checked: ${url}`);
  }
  const response = await fetch(parsed, {
    headers: { "user-agent": config.userAgent, accept: "text/html, application/javascript, text/plain, */*" },
    signal: AbortSignal.timeout(config.timeoutMs),
    redirect: "follow",
  }).catch((error: unknown) => {
    throw new IpError("UPSTREAM", `could not fetch ${parsed.host}: ${String(error)}`);
  });
  if (!response.ok) throw new IpError("UPSTREAM", `${parsed.host} answered ${response.status}`, { status: response.status });
  const text = await response.text();
  return text.slice(0, 2 * 1024 * 1024);
}
