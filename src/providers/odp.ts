import { config } from "../config.js";
import { IpError } from "../errors.js";
import { requestJson } from "../http.js";
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

interface OdpWrapper {
  applicationNumberText?: string;
  applicationMetaData?: OdpApplicationMeta;
  eventDataBag?: Array<{ eventDate?: string; eventDescriptionText?: string }>;
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
): Promise<{ count: number; hits: PatentHit[]; provenance: Provenance; facets?: Record<string, Array<{ value: string; count: number }>> }> {
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

  const result = await requestJson<OdpSearchResponse>({
    provider: "odp",
    route: "/api/v1/patent/applications/search",
    method: "POST",
    headers: headers(),
    body,
    rateLimit: { name: "odp:default", perMinute: 60 },
    cache: { ttlMs: 5 * 60_000 },
  });

  const hits = (result.data.patentFileWrapperDataBag ?? []).map((wrapper) =>
    toHit(wrapper, result.provenance),
  );
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
function collectDocuments(payload: unknown): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    const hasCode = typeof record.documentCode === "string" || typeof record.documentIdentifier === "string";
    const hasUrl = Object.entries(record).some(
      ([key, value]) => /url|uri/i.test(key) && typeof value === "string" && /^https?:/.test(value),
    );
    if (hasCode && hasUrl) found.push(record);
    for (const value of Object.values(record)) visit(value);
  };
  visit(payload);
  return found;
}
