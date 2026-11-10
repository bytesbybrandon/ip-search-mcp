import { config } from "../config.js";
import { IpError } from "../errors.js";
import { requestJson } from "../http.js";
import type { Provenance } from "../http.js";
import type { TrademarkHit } from "../types.js";

let serviceBase: { value: string; expiresAt: number } | undefined;

function requireEnabled(): void {
  if (!config.allowUnofficial) {
    throw new IpError("PROVIDER_DISABLED", "Trademark Search backend is disabled", {
      provider: "tmsearch",
      hint:
        "Set IP_ALLOW_UNOFFICIAL=1 to enable the undocumented Trademark Search backend. Results are candidates only; hydrate with TSDR. USPTO publishes no contract for this endpoint and its terms allow automated access to be cut off.",
    });
  }
}

/**
 * The Trademark Search web app publishes its backend base in configuration.json.
 * Read it each hour instead of hard-coding a version segment.
 */
async function discoverBase(): Promise<string> {
  if (serviceBase && Date.now() < serviceBase.expiresAt) return serviceBase.value;
  const response = await fetch(`${config.providers.tmsearch.baseUrl}/configuration.json`, {
    headers: { "user-agent": config.userAgent, accept: "application/json" },
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  if (!response.ok) {
    throw new IpError("UPSTREAM", `Trademark Search configuration.json failed (${response.status})`, {
      provider: "tmsearch",
    });
  }
  const body = (await response.json()) as { serviceUrlSearchElastic?: string };
  const base = body.serviceUrlSearchElastic;
  if (!base) {
    throw new IpError("UPSTREAM", "Trademark Search configuration.json had no serviceUrlSearchElastic", {
      provider: "tmsearch",
    });
  }
  serviceBase = { value: base, expiresAt: Date.now() + 60 * 60_000 };
  return base;
}

export interface TmSearchParams {
  query?: string;
  markText?: string;
  ownerName?: string;
  serialNumber?: string;
  registrationNumber?: string;
  goodsServices?: string;
  internationalClass?: number;
  status?: "live" | "dead";
  offset?: number;
  limit?: number;
}

interface EsBody {
  query: { bool: Record<string, unknown> };
  from: number;
  size: number;
  track_total_hits: boolean;
}

export function buildSearchBody(params: TmSearchParams): EsBody {
  const must: Array<Record<string, unknown>> = [];
  const filter: Array<Record<string, unknown>> = [];

  if (params.query) {
    must.push({ query_string: { query: params.query, default_field: "wordmark" } });
  }
  if (params.markText) must.push({ match: { wordmark: params.markText } });
  if (params.ownerName) must.push({ match: { ownerFullText: params.ownerName } });
  if (params.serialNumber) must.push({ term: { id: params.serialNumber } });
  if (params.registrationNumber) must.push({ term: { registrationId: params.registrationNumber } });
  if (params.goodsServices) must.push({ match: { goodsAndServices: params.goodsServices } });
  if (params.internationalClass !== undefined) {
    filter.push({ term: { internationalClass: String(params.internationalClass).padStart(3, "0") } });
  }
  if (params.status) filter.push({ term: { alive: params.status === "live" } });

  const bool: Record<string, unknown> = {};
  if (must.length > 0) bool.must = must;
  if (filter.length > 0) bool.filter = filter;
  if (Object.keys(bool).length === 0) bool.must = [{ match_all: {} }];

  return {
    query: { bool },
    from: params.offset ?? 0,
    size: Math.min(params.limit ?? 20, 100),
    track_total_hits: true,
  };
}

interface TmRecord {
  id?: string;
  wordmark?: string;
  ownerName?: string;
  ownerFullText?: string;
  filedDate?: string;
  registrationDate?: string;
  registrationId?: string;
  goodsAndServices?: string;
  internationalClass?: string[] | string;
  alive?: boolean;
  markCurrentStatusExternalDescriptionText?: string;
}

function parseHits(payload: unknown): { records: TmRecord[]; total?: number } {
  if (payload === null || typeof payload !== "object") return { records: [] };
  const hitsWrapper = (payload as Record<string, unknown>).hits;
  if (hitsWrapper === null || typeof hitsWrapper !== "object") return { records: [] };
  const hitsRecord = hitsWrapper as Record<string, unknown>;
  const rawHits = Array.isArray(hitsRecord.hits) ? hitsRecord.hits : [];
  const records: TmRecord[] = [];
  for (const hit of rawHits) {
    if (hit === null || typeof hit !== "object") continue;
    const hitRecord = hit as Record<string, unknown>;
    const source = hitRecord.source ?? hitRecord._source ?? hitRecord;
    if (source === null || typeof source !== "object") continue;
    const record = { ...(source as TmRecord) };
    if (!record.id && typeof hitRecord.id === "string") record.id = hitRecord.id;
    records.push(record);
  }
  const totalValue = hitsRecord.totalValue ?? hitsRecord.total;
  const total =
    typeof totalValue === "number"
      ? totalValue
      : totalValue && typeof totalValue === "object" && "value" in totalValue
        ? Number((totalValue as { value?: unknown }).value)
        : undefined;
  return { records, total: Number.isFinite(total) ? total : undefined };
}

function classNumbers(value: TmRecord["internationalClass"]): number[] | undefined {
  const raw = value === undefined ? [] : Array.isArray(value) ? value : [value];
  const numbers = raw
    .flatMap((entry) => String(entry).match(/\d{1,2}/g) ?? [])
    .map((entry) => Number(entry))
    .filter((entry) => entry >= 1 && entry <= 45);
  return numbers.length > 0 ? [...new Set(numbers)] : undefined;
}

export async function search(
  params: TmSearchParams,
): Promise<{ hits: TrademarkHit[]; total?: number; provenance: Provenance; warnings: string[] }> {
  requireEnabled();
  const base = await discoverBase();
  const headers: Record<string, string> = {
    accept: "application/json, text/plain, */*",
    origin: config.providers.tmsearch.baseUrl,
    referer: `${config.providers.tmsearch.baseUrl}/`,
  };
  const wafToken = config.providers.tmsearch.wafToken;
  if (wafToken) headers.cookie = `aws-waf-token=${wafToken}`;

  const result = await requestJson<unknown>({
    provider: "tmsearch",
    route: new URL("tmsearch", base).pathname,
    method: "POST",
    headers,
    body: buildSearchBody(params),
    rateLimit: { name: "tmsearch:default", perMinute: 30 },
    undocumented: true,
    cache: { ttlMs: 10 * 60_000 },
  });

  const { records, total } = parseHits(result.data);
  const hits: TrademarkHit[] = records.map((record) => ({
    kind: "trademark",
    markText: record.wordmark ?? "(mark text unavailable)",
    serialNumber: record.id,
    registrationNumber: record.registrationId,
    owner: record.ownerName ?? record.ownerFullText,
    filingDate: record.filedDate,
    registrationDate: record.registrationDate,
    internationalClasses: classNumbers(record.internationalClass),
    goodsAndServices: record.goodsAndServices,
    status: record.markCurrentStatusExternalDescriptionText,
    alive: record.alive,
    provenance: result.provenance,
  }));

  return {
    hits,
    total,
    provenance: result.provenance,
    warnings: [
      "Trademark Search is an undocumented USPTO backend. These are candidates, not an official record.",
      "Hydrate every candidate serial with the trademark_get tool (TSDR) before relying on status or owner data.",
      "Ranking is textual similarity only, not a likelihood-of-confusion conclusion.",
    ],
  };
}
