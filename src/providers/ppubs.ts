import { config } from "../config.js";
import { IpError } from "../errors.js";
import { requestJson } from "../http.js";
import type { Provenance } from "../http.js";
import type { PatentHit } from "../types.js";

/**
 * Undocumented USPTO Patent Public Search API.
 *
 * The web app at ppubs.uspto.gov establishes a session from /pubwebapp/, then
 * calls /api/users/me/session which returns an X-Access-Token header. Search
 * and document calls need that token. Nothing here is a published contract.
 */
let session: { token: string; caseId: string; expiresAt: number } | undefined;

function requireEnabled(): void {
  if (!config.allowUnofficial) {
    throw new IpError("PROVIDER_DISABLED", "Patent Public Search is disabled", {
      provider: "ppubs",
      hint:
        "Set IP_ALLOW_UNOFFICIAL=1 to enable the undocumented Patent Public Search adapter. It has no published contract and USPTO terms allow access to be withdrawn.",
    });
  }
}

async function establishSession(): Promise<{ token: string; caseId: string }> {
  if (session && Date.now() < session.expiresAt) return session;

  const base = config.providers.ppubs.baseUrl;
  const cookies: string[] = [];
  const bootstrap = await fetch(`${base}/pubwebapp/`, {
    headers: { "user-agent": config.userAgent },
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  const setCookie = bootstrap.headers.getSetCookie?.() ?? [];
  for (const entry of setCookie) cookies.push(entry.split(";")[0] ?? "");

  const response = await fetch(`${base}/api/users/me/session`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-access-token": "null",
      referer: `${base}/pubwebapp/`,
      cookie: cookies.filter(Boolean).join("; "),
      "user-agent": config.userAgent,
    },
    body: "-1",
    signal: AbortSignal.timeout(config.timeoutMs),
  });

  if (!response.ok) {
    throw new IpError("UPSTREAM", `Patent Public Search session failed (${response.status})`, {
      provider: "ppubs",
      hint: "The undocumented session endpoint may have moved. Disable IP_ALLOW_UNOFFICIAL to stop using this surface.",
    });
  }

  const token = response.headers.get("x-access-token");
  const body = (await response.json()) as { userCase?: { caseId?: number | string } };
  const caseId = body.userCase?.caseId;
  if (!token || caseId === undefined) {
    throw new IpError("UPSTREAM", "Patent Public Search session response was missing its token or case id", {
      provider: "ppubs",
    });
  }
  session = { token, caseId: String(caseId), expiresAt: Date.now() + 20 * 60_000 };
  return session;
}

const QUERY_TEMPLATE = {
  start: 0,
  pageCount: 50,
  sort: "date_publ desc",
  docFamilyFiltering: "familyIdFiltering",
  searchType: 1,
  familyIdEnglishOnly: true,
  familyIdFirstPreferred: "US-PGPUB",
  familyIdSecondPreferred: "USPAT",
  familyIdThirdPreferred: "FPRS",
  showDocPerFamilyPref: "showEnglish",
  queryId: 0,
  tagDocSearch: false,
} as const;

export interface PpubsSearchOptions {
  query: string;
  offset?: number;
  limit?: number;
  databases?: string[];
  sort?: string;
}

export async function search(
  options: PpubsSearchOptions,
): Promise<{ hits: PatentHit[]; total?: number; provenance: Provenance; warnings: string[] }> {
  requireEnabled();
  const { token, caseId } = await establishSession();
  const databases = options.databases ?? ["USPAT", "US-PGPUB", "USOCR"];
  const query = {
    caseId: Number(caseId),
    hl_snippets: "2",
    op: "AND",
    q: options.query,
    queryName: options.query,
    highlights: "1",
    qt: "brs",
    spellCheck: "false",
    viewName: "tile",
    plurals: "true",
    britishEquivalents: "true",
    databaseFilters: databases.map((databaseName) => ({ databaseName, countryCodes: [] })),
    searchType: 1,
    ignorePersist: "true",
    userEnteredQuery: options.query,
  };

  const payload = {
    ...QUERY_TEMPLATE,
    start: options.offset ?? 0,
    pageCount: Math.min(options.limit ?? 25, 500),
    sort: options.sort ?? QUERY_TEMPLATE.sort,
    query,
  };

  const result = await requestJson<Record<string, unknown>>({
    provider: "ppubs",
    route: "/api/searches/searchWithBeFamily",
    method: "POST",
    headers: { "x-access-token": token, referer: `${config.providers.ppubs.baseUrl}/pubwebapp/` },
    body: payload,
    rateLimit: { name: "ppubs:default", perMinute: 30 },
    undocumented: true,
    cache: { ttlMs: 10 * 60_000 },
  });

  const hits = extractHits(result.data, result.provenance);
  const total = numberAt(result.data, "totalNumFound", "totalCount", "numFound", "count");
  return {
    hits,
    total,
    provenance: result.provenance,
    warnings: [
      "Patent Public Search is an undocumented USPTO surface. Verify every hit against an official record before relying on it.",
    ],
  };
}

function numberAt(node: unknown, ...keys: string[]): number | undefined {
  if (node === null || typeof node !== "object") return undefined;
  const record = node as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number") return value;
    if (typeof value === "string" && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}

function extractHits(payload: unknown, provenance: Provenance): PatentHit[] {
  const hits: PatentHit[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    const guid = record.guid ?? record.documentId;
    const number = record.patentNumber ?? record.publicationNumber ?? record.number;
    if (typeof guid === "string" && typeof number === "string") {
      const title = typeof record.title === "string" ? record.title : undefined;
      hits.push({
        kind: "patent",
        number,
        displayNumber: number,
        patentKind: /^US\d{4}\/?\d{7}/.test(number) ? "publication" : "grant",
        title,
        abstract: typeof record.abstract === "string" ? record.abstract : undefined,
        grantDate: typeof record.date === "string" ? record.date : undefined,
        url: `${config.providers.ppubs.baseUrl}/api/patents/highlight/${guid}?queryId=1&source=${String(record.sourceType ?? "USPAT")}&includeSections=true`,
        provenance,
      });
    }
    for (const value of Object.values(record)) visit(value);
  };
  visit(payload);
  const seen = new Set<string>();
  return hits.filter((hit) => {
    const key = `${hit.number}:${hit.title ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function document(guid: string, source = "USPAT"): Promise<{ data: unknown; provenance: Provenance }> {
  requireEnabled();
  const { token } = await establishSession();
  const result = await requestJson<unknown>({
    provider: "ppubs",
    route: `/api/patents/highlight/${encodeURIComponent(guid)}`,
    query: { queryId: 1, source, includeSections: "true" },
    headers: { "x-access-token": token, referer: `${config.providers.ppubs.baseUrl}/pubwebapp/` },
    rateLimit: { name: "ppubs:default", perMinute: 30 },
    undocumented: true,
  });
  return { data: result.data, provenance: result.provenance };
}
