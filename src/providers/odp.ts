import { config } from "../config.js";
import { IpError } from "../errors.js";
import { requestJson, requestText } from "../http.js";
import type { PatentHit } from "../types.js";
import type { Provenance } from "../http.js";

export interface OdpFilter {
  name: string;
  value: string[];
}

export interface OdpRange {
  field: string;
  valueFrom?: string;
  valueTo?: string;
}

export interface OdpSearchParams {
  q?: string;
  filters?: OdpFilter[];
  rangeFilters?: OdpRange[];
  fields?: string[];
  offset?: number;
  limit?: number;
  sort?: Array<{ field: string; order: "asc" | "desc" }>;
  facets?: string[];
}

interface OdpApplicationMeta {
  patentNumber?: string;
  applicationTypeCode?: string;
  applicationTypeLabelName?: string;
  inventionTitle?: string;
  patentTitle?: string;
  filingDate?: string;
  effectiveFilingDate?: string;
  grantDate?: string;
  earliestPublicationDate?: string;
  firstInventorName?: string;
  applicantBag?: Array<{ applicantNameText?: string; preferredName?: string }>;
  cpcClassificationBag?: string[];
  applicationStatusDescriptionText?: string;
  docketNumber?: string;
}

export interface OdpDocumentMeta {
  productIdentifier?: string;
  fileLocationURI?: string;
}

export interface OdpWrapper {
  applicationNumberText?: string;
  applicationMetaData?: OdpApplicationMeta;
  eventDataBag?: Array<{ eventDate?: string; eventDescriptionText?: string }>;
  grantDocumentMetaData?: OdpDocumentMeta;
  pgpubDocumentMetaData?: OdpDocumentMeta;
  patentTermAdjustmentData?: { adjustmentTotalQuantity?: number };
  assignmentBag?: Array<{ assignmentRecordedDate?: string; conveyanceText?: string; assigneeBag?: Array<{ assigneeNameText?: string }> }>;
}

interface OdpSearchResponse {
  count?: number;
  patentFileWrapperDataBag?: OdpWrapper[];
  facets?: Array<Record<string, Array<{ count?: number; value?: string }>>>;
}

function requireKey(): string {
  const key = config.providers.odp.key;
  if (!key) {
    throw new IpError("CREDENTIAL_MISSING", "USPTO Open Data Portal key is not configured", {
      provider: "odp",
      hint:
        "Create a USPTO.gov account with MFA, sign in at https://data.uspto.gov, open Manage API Key, and set USPTO_ODP_API_KEY. ODP keys do not work at TSDR.",
    });
  }
  return key;
}

function headers(): Record<string, string> {
  return { [config.providers.odp.keyHeader ?? "X-API-KEY"]: requireKey() };
}

export async function searchApplications(
  params: OdpSearchParams,
): Promise<{ count: number; hits: PatentHit[]; wrappers?: OdpWrapper[]; provenance: Provenance; facets?: Record<string, Array<{ value: string; count: number }>> }> {
  const body: Record<string, unknown> = {
    q: params.q,
    filters: params.filters,
    rangeFilters: params.rangeFilters,
    fields: params.fields,
    pagination: { offset: params.offset ?? 0, limit: params.limit ?? 25 },
    sort: params.sort,
    facets: params.facets,
  };
  for (const key of Object.keys(body)) if (body[key] === undefined) delete body[key];

  let result;
  try {
    result = await requestJson<OdpSearchResponse>({
      provider: "odp",
      route: "/api/v1/patent/applications/search",
      method: "POST",
      headers: headers(),
      body,
      rateLimit: { name: "odp:default", perMinute: 60 },
      cache: { ttlMs: 5 * 60_000 },
    });
  } catch (error) {
    // ODP answers a zero-hit search with 404 "No matching records found".
    if (error instanceof IpError && error.code === "NOT_FOUND") {
      return {
        count: 0,
        hits: [],
        provenance: {
          provider: "odp",
          route: "POST /api/v1/patent/applications/search",
          retrievedAt: new Date().toISOString(),
          note: "no matching records",
        },
      };
    }
    throw error;
  }

  const wrappers = result.data.patentFileWrapperDataBag ?? [];
  const hits = wrappers.map((wrapper) => toHit(wrapper, result.provenance));
  const facets: Record<string, Array<{ value: string; count: number }>> = {};
  for (const group of result.data.facets ?? []) {
    for (const [name, values] of Object.entries(group)) {
      facets[name] = (values ?? []).map((entry) => ({
        value: entry.value ?? "",
        count: entry.count ?? 0,
      }));
    }
  }

  return {
    count: result.data.count ?? hits.length,
    hits,
    wrappers,
    provenance: result.provenance,
    facets: Object.keys(facets).length > 0 ? facets : undefined,
  };
}

export function toHit(wrapper: OdpWrapper, provenance: Provenance): PatentHit {
  const meta = wrapper.applicationMetaData ?? {};
  const applicationNumber = wrapper.applicationNumberText;
  const inventors = meta.firstInventorName ? [meta.firstInventorName] : undefined;
  const assignees = (meta.applicantBag ?? [])
    .map((applicant) => applicant.applicantNameText ?? applicant.preferredName)
    .filter((value): value is string => Boolean(value));

  return {
    kind: "patent",
    number: applicationNumber ?? "",
    displayNumber: applicationNumber ?? "",
    patentKind: "application",
    title: meta.inventionTitle ?? meta.patentTitle,
    filingDate: meta.filingDate,
    effectiveFilingDate: meta.effectiveFilingDate,
    grantDate: meta.grantDate,
    publicationDate: meta.earliestPublicationDate,
    inventors,
    assignees: assignees.length > 0 ? assignees : undefined,
    cpc: meta.cpcClassificationBag,
    status: meta.applicationStatusDescriptionText,
    patentNumber: meta.patentNumber || undefined,
    applicationNumber,
    url: applicationNumber
      ? `https://patents.google.com/?q=${encodeURIComponent(applicationNumber)}`
      : undefined,
    provenance,
  };
}

export async function getMetadata(application: string): Promise<{ wrapper: OdpWrapper; provenance: Provenance }> {
  const result = await requestJson<{ patentFileWrapperDataBag?: OdpWrapper[] }>({
    provider: "odp",
    route: `/api/v1/patent/applications/${encodeURIComponent(application)}/meta-data`,
    headers: headers(),
    rateLimit: { name: "odp:default", perMinute: 60 },
    cache: { ttlMs: 30 * 60_000 },
  });
  const wrapper = result.data.patentFileWrapperDataBag?.[0];
  if (!wrapper) {
    throw new IpError("NOT_FOUND", `ODP has no application ${application}`, { provider: "odp" });
  }
  return { wrapper, provenance: result.provenance };
}

export async function getDocuments(
  application: string,
): Promise<{ documents: Array<Record<string, unknown>>; provenance: Provenance }> {
  const result = await requestJson<Record<string, unknown>>({
    provider: "odp",
    route: `/api/v1/patent/applications/${encodeURIComponent(application)}/documents`,
    headers: headers(),
    rateLimit: { name: "odp:default", perMinute: 60 },
    cache: { ttlMs: 30 * 60_000 },
  });
  return { documents: collectDocuments(result.data), provenance: result.provenance };
}

export async function getContinuity(
  application: string,
): Promise<{ data: Record<string, unknown>; provenance: Provenance }> {
  const result = await requestJson<Record<string, unknown>>({
    provider: "odp",
    route: `/api/v1/patent/applications/${encodeURIComponent(application)}/continuity`,
    headers: headers(),
    rateLimit: { name: "odp:default", perMinute: 60 },
    cache: { ttlMs: 30 * 60_000 },
  });
  return { data: result.data, provenance: result.provenance };
}

/**
 * ODP returns document metadata in several bag shapes. Walk the payload and
 * collect anything that carries a document code and a downloadable URL.
 */
interface OdpDocumentRecord {
  applicationNumberText?: string;
  documentIdentifier?: string;
  documentCode?: string;
  documentCodeDescriptionText?: string;
  officialDate?: string;
  directionCategory?: string;
  downloadOptionBag?: Array<{ mimeTypeIdentifier?: string; downloadUrl?: string; pageTotalQuantity?: number }>;
}

function collectDocuments(payload: unknown): Array<Record<string, unknown>> {
  if (payload === null || typeof payload !== "object") return [];
  const bag = (payload as { documentBag?: OdpDocumentRecord[] }).documentBag;
  if (Array.isArray(bag)) {
    return bag.map((record) => {
      const options = record.downloadOptionBag ?? [];
      const pdf = options.find((option) => option.mimeTypeIdentifier === "PDF") ?? options[0];
      return {
        documentIdentifier: record.documentIdentifier,
        documentCode: record.documentCode,
        description: record.documentCodeDescriptionText,
        officialDate: record.officialDate?.slice(0, 10),
        direction: record.directionCategory,
        pages: pdf?.pageTotalQuantity,
        downloadUrl: pdf?.downloadUrl,
      };
    });
  }
  const found: Array<Record<string, unknown>> = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (typeof record.documentCode === "string" && typeof record.documentIdentifier === "string") {
      found.push(record);
    }
    for (const value of Object.values(record)) visit(value);
  };
  visit(payload);
  return found;
}

/** Search cache: ODP updates daily, so a 12-hour cache keeps repeat vets fast without going stale. */
const SEARCH_TTL_MS = 12 * 60 * 60_000;
/** Issued full text does not change. */
const FULLTEXT_TTL_MS = 30 * 24 * 60 * 60_000;

/**
 * Title-and-metadata search with ODP's boolean syntax (AND, OR, quoted
 * phrases, trailing `*`). Thin wrapper that applies the longer search cache.
 * Perf: P1 · one request · CRAP <= 10 (CC 2).
 */
export async function searchTitles(q: string, limit = 100, offset = 0): Promise<{ count: number; wrappers: OdpWrapper[]; provenance: Provenance }> {
  try {
    const result = await requestJson<OdpSearchResponse>({
      provider: "odp",
      route: "/api/v1/patent/applications/search",
      method: "POST",
      headers: headers(),
      // ODP rejects page sizes above 100.
      body: { q, pagination: { offset, limit: Math.min(limit, 100) } },
      rateLimit: { name: "odp:default", perMinute: 60 },
      cache: { ttlMs: SEARCH_TTL_MS },
    });
    const wrappers = result.data.patentFileWrapperDataBag ?? [];
    return { count: result.data.count ?? wrappers.length, wrappers, provenance: result.provenance };
  } catch (error) {
    if (error instanceof IpError && error.code === "NOT_FOUND") {
      return { count: 0, wrappers: [], provenance: { provider: "odp", route: "POST /api/v1/patent/applications/search", retrievedAt: new Date().toISOString(), note: "no matching records" } };
    }
    throw error;
  }
}

/** ODP stores CPC symbols with padded spaces (`G06F  12/0891`); queries must quote that exact form. */
export function cpcQuery(symbol: string): string {
  return `applicationMetaData.cpcClassificationBag:"${symbol.replace(/"/g, "")}"`;
}

/** Look up granted patents by number in one request. Perf: P1 · one request per 50 numbers · CRAP <= 10 (CC 2). */
export async function byPatentNumbers(numbers: string[]): Promise<OdpWrapper[]> {
  const digits = [...new Set(numbers.map((number) => number.replace(/\D/g, "")).filter((number) => number.length >= 6))].slice(0, 50);
  if (digits.length === 0) return [];
  const result = await searchTitles(`applicationMetaData.patentNumber:(${digits.join(" OR ")})`, digits.length);
  return result.wrappers;
}

export interface ParsedClaim {
  number: number;
  text: string;
  independent: boolean;
  dependsOn: number[];
}

export interface FullText {
  documentNumber?: string;
  kind?: string;
  title?: string;
  abstract?: string;
  claims: ParsedClaim[];
  description?: string;
  /** Backward citations to US patents and publications, as bare document numbers. */
  citedUs: string[];
  citedOtherCount: number;
}

function stripTags(xml: string): string {
  return xml
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parse a USPTO grant (us-patent-grant) or publication (us-patent-application)
 * full-text XML document: title, abstract, numbered claims with their
 * dependencies, description text, and cited references.
 * Perf: P1 · O(document length) · CRAP <= 15 (CC 6, branch coverage >= 80%).
 */
export function parseFullTextXml(xml: string): FullText {
  const first = (pattern: RegExp): string | undefined => {
    const match = pattern.exec(xml);
    return match?.[1] !== undefined ? stripTags(match[1]) : undefined;
  };
  const claims: ParsedClaim[] = [];
  for (const match of xml.matchAll(/<claim\b[^>]*\bnum="(\d+)"[^>]*>([\s\S]*?)<\/claim>/g)) {
    const body = match[2] ?? "";
    const dependsOn = [...body.matchAll(/<claim-ref\b[^>]*idref="CLM-0*(\d+)"/g)].map((ref) => Number(ref[1]));
    claims.push({ number: Number(match[1]), text: stripTags(body), independent: dependsOn.length === 0, dependsOn });
  }
  const citedUs: string[] = [];
  let citedOtherCount = 0;
  for (const match of xml.matchAll(/<(?:us-citation|citation)>([\s\S]*?)<\/(?:us-citation|citation)>/g)) {
    const body = match[1] ?? "";
    const patcit = /<patcit\b[\s\S]*?<country>([A-Z]{2})<\/country>\s*<doc-number>([^<]+)<\/doc-number>/.exec(body);
    if (patcit && patcit[1] === "US" && patcit[2]) citedUs.push(patcit[2].trim());
    else citedOtherCount += 1;
  }
  const publication = /<publication-reference>[\s\S]*?<doc-number>([^<]+)<\/doc-number>\s*<kind>([^<]+)<\/kind>/.exec(xml);
  return {
    documentNumber: publication?.[1]?.trim(),
    kind: publication?.[2]?.trim(),
    title: first(/<invention-title\b[^>]*>([\s\S]*?)<\/invention-title>/),
    abstract: first(/<abstract\b[^>]*>([\s\S]*?)<\/abstract>/),
    claims,
    description: first(/<description\b[^>]*>([\s\S]*?)<\/description>/),
    citedUs,
    citedOtherCount,
  };
}

/**
 * Fetch and parse the issued (or else published) full text that ODP links
 * from the file wrapper. The link must stay on the ODP host, so the key
 * never leaves it. Perf: P1 · one request, cached 30 days · CRAP <= 10 (CC 4).
 */
export async function fullTextFor(wrapper: OdpWrapper): Promise<{ text: FullText; source: "grant" | "publication"; provenance: Provenance } | undefined> {
  const grant = wrapper.grantDocumentMetaData?.fileLocationURI;
  const pgpub = wrapper.pgpubDocumentMetaData?.fileLocationURI;
  const link = grant ?? pgpub;
  if (!link) return undefined;
  const url = new URL(link);
  const expected = new URL(config.providers.odp.baseUrl);
  if (url.host !== expected.host || !url.pathname.startsWith("/api/v1/datasets/")) {
    throw new IpError("UPSTREAM", `ODP full-text link points outside ${expected.host}`, { provider: "odp" });
  }
  const result = await requestText({
    provider: "odp",
    route: url.pathname,
    headers: headers(),
    rateLimit: { name: "odp:default", perMinute: 60 },
    cache: { ttlMs: FULLTEXT_TTL_MS },
    sourceId: wrapper.applicationNumberText,
  });
  return { text: parseFullTextXml(result.text), source: grant ? "grant" : "publication", provenance: result.provenance };
}

/** Earliest US non-provisional filing this application claims (continuation, divisional, CIP). Perf: P1 · one request · CRAP <= 10 (CC 3). */
export async function earliestNonProvisional(application: string): Promise<string | undefined> {
  const { data } = await getContinuity(application);
  const bag = (data.patentFileWrapperDataBag as Array<{ parentContinuityBag?: Array<{ claimParentageTypeCode?: string; parentApplicationFilingDate?: string }> }> | undefined)?.[0]?.parentContinuityBag ?? [];
  const dates = bag
    .filter((entry) => entry.claimParentageTypeCode && entry.claimParentageTypeCode !== "PRO" && entry.parentApplicationFilingDate)
    .map((entry) => entry.parentApplicationFilingDate!.slice(0, 10))
    .sort();
  return dates[0];
}

/**
 * Later US applications whose examiners cited this patent in an office action
 * (ODP Office Action Enriched Citation API). Examiner citations only; this is
 * not a complete forward-citation list. Perf: P1 · one request · CRAP <= 10 (CC 2).
 */
export async function examinerForwardCitations(patentNumber: string, rows = 25): Promise<string[]> {
  const digits = patentNumber.replace(/\D/g, "");
  if (digits.length < 6) return [];
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const ids = ["B1", "B2"].flatMap((kind) => [`"US ${digits} ${kind}"`, `"US ${grouped} ${kind}"`]);
  const result = await requestJson<{ response?: { docs?: Array<{ patentApplicationNumber?: string }> } }>({
    provider: "odp",
    route: "/api/v1/patent/oa/enriched_cited_reference_metadata/v3/records",
    method: "POST",
    headers: headers(),
    form: { criteria: `citedDocumentIdentifier:(${ids.join(" OR ")})`, rows: String(rows) },
    rateLimit: { name: "odp:default", perMinute: 60 },
    cache: { ttlMs: SEARCH_TTL_MS },
  });
  return [...new Set((result.data.response?.docs ?? []).map((doc) => doc.patentApplicationNumber).filter((value): value is string => Boolean(value)))];
}

/** Conveyances that record a lien or a licence, not a change of ownership. */
const NOT_OWNERSHIP = /security|licen[cs]e|\blien\b|collateral|pledge|mortgage|release/i;

/**
 * The most recent recorded assignee of an ownership conveyance (security
 * interests, licences, and releases are skipped), else the first applicant.
 * Perf: P0 · O(assignments) · CRAP <= 10 (CC 4).
 */
export function currentOwner(wrapper: OdpWrapper): string | undefined {
  const latest = [...(wrapper.assignmentBag ?? [])]
    .filter((entry) => !NOT_OWNERSHIP.test(entry.conveyanceText ?? ""))
    .sort((a, b) => (b.assignmentRecordedDate ?? "").localeCompare(a.assignmentRecordedDate ?? ""))
    .find((entry) => entry.assigneeBag?.[0]?.assigneeNameText);
  return latest?.assigneeBag?.[0]?.assigneeNameText ?? wrapper.applicationMetaData?.applicantBag?.[0]?.applicantNameText;
}
