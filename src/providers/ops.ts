import { config } from "../config.js";
import { IpError } from "../errors.js";
import { requestJson } from "../http.js";
import type { Provenance } from "../http.js";
import { parsePatentNumber } from "../numbers.js";
import type { PatentHit } from "../types.js";

let cachedToken: { value: string; expiresAt: number } | undefined;

function requireCredentials(): { id: string; secret: string } {
  const id = config.providers.ops.key;
  const secret = config.providers.ops.clientSecret;
  if (!id || !secret) {
    throw new IpError("CREDENTIAL_MISSING", "EPO OPS credentials are not configured", {
      provider: "ops",
      hint:
        "Register an app at https://developers.epo.org, then set EPO_OPS_CLIENT_ID and EPO_OPS_CLIENT_SECRET. OPS is free within the EPO fair use charter.",
    });
  }
  return { id, secret };
}

async function accessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.value;
  const { id, secret } = requireCredentials();
  const response = await fetch(`${config.providers.ops.baseUrl}/3.2/auth/accesstoken`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
      "user-agent": config.userAgent,
    },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(config.timeoutMs),
  }).catch((error: unknown) => {
    throw new IpError("UPSTREAM", `EPO OPS token request failed: ${String(error)}`, { provider: "ops" });
  });

  if (!response.ok) {
    throw new IpError("CREDENTIAL_MISSING", `EPO OPS rejected the token request (${response.status})`, {
      provider: "ops",
      status: response.status,
      hint: "Verify EPO_OPS_CLIENT_ID and EPO_OPS_CLIENT_SECRET, and that the app is active.",
    });
  }

  const payload = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!payload.access_token) {
    throw new IpError("UPSTREAM", "EPO OPS token response had no access_token", { provider: "ops" });
  }
  const lifetimeMs = Math.max(60_000, (payload.expires_in ?? 1200) * 1000 - 60_000);
  cachedToken = { value: payload.access_token, expiresAt: Date.now() + lifetimeMs };
  return cachedToken.value;
}

function normalizeReference(input: string): string {
  const parsed = parsePatentNumber(input);
  if (parsed.kind === "ambiguous") {
    throw new IpError("INVALID_INPUT", "ambiguous number; pass a publication number such as US.2020.0123456.A1", {
      provider: "ops",
    });
  }
  return parsed.digits;
}

async function ops<T>(
  route: string,
  query?: Record<string, string | number | undefined>,
  sourceId?: string,
): Promise<{ data: T; provenance: Provenance }> {
  const token = await accessToken();
  const result = await requestJson<T>({
    provider: "ops",
    route,
    query,
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    rateLimit: { name: "ops:default", perMinute: 60 },
    cache: { ttlMs: 60 * 60_000 },
    sourceId,
  });
  return { data: result.data, provenance: result.provenance };
}

interface ExchangeDocument {
  "@country"?: string;
  "@doc-number"?: string;
  "@kind"?: string;
  "bibliographic-data"?: Record<string, unknown>;
}

/** OPS wraps everything in namespaced objects and arrays; walk until documents appear. */
function findDocuments(node: unknown, out: ExchangeDocument[] = []): ExchangeDocument[] {
  if (Array.isArray(node)) {
    for (const item of node) findDocuments(item, out);
    return out;
  }
  if (node === null || typeof node !== "object") return out;
  const record = node as Record<string, unknown>;
  if (typeof record["@doc-number"] === "string" && typeof record["@country"] === "string") {
    out.push(record as ExchangeDocument);
  }
  for (const value of Object.values(record)) findDocuments(value, out);
  return out;
}

function textAt(node: unknown, ...path: string[]): string | undefined {
  let current: unknown = node;
  for (const segment of path) {
    if (Array.isArray(current)) current = current[0];
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  if (Array.isArray(current)) current = current[0];
  if (current === null || typeof current !== "object") {
    return typeof current === "string" ? current : undefined;
  }
  const record = current as Record<string, unknown>;
  const value = record["$"] ?? record["@value"] ?? record["p"];
  return typeof value === "string" ? value : undefined;
}

function titleOf(document: ExchangeDocument): string | undefined {
  const titles = document["bibliographic-data"]?.["invention-title"];
  const list = Array.isArray(titles) ? titles : titles ? [titles] : [];
  const ranked = list
    .map((entry) => entry as Record<string, unknown>)
    .sort((a, b) => (a["@lang"] === "en" ? -1 : 0) - (b["@lang"] === "en" ? -1 : 0));
  for (const entry of ranked) {
    const value = entry["$"] ?? entry["p"];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function dateOf(document: ExchangeDocument): string | undefined {
  const raw = textAt(document, "bibliographic-data", "publication-reference", "document-id", "date");
  if (!raw) return undefined;
  return raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6)}` : raw;
}

export function toOpsHit(document: ExchangeDocument, provenance: Provenance): PatentHit {
  const country = document["@country"] ?? "";
  const docNumber = document["@doc-number"] ?? "";
  const kindCode = document["@kind"] ?? "";
  const display = `${country}${docNumber}${kindCode}`;
  return {
    kind: "patent",
    number: display,
    displayNumber: display,
    patentKind: kindCode.startsWith("A") ? "publication" : "grant",
    title: titleOf(document),
    publicationDate: dateOf(document),
    provenance,
  };
}

export async function search(
  q: string,
  options: { offset?: number; limit?: number } = {},
): Promise<{ hits: PatentHit[]; provenance: Provenance; total?: number }> {
  const offset = options.offset ?? 1;
  const limit = Math.min(options.limit ?? 25, 100);
  const range = `${offset}-${offset + limit - 1}`;
  const result = await ops<unknown>("/3.2/rest-services/published-data/search", { q, Range: range });
  const documents = findDocuments(result.data);
  const total = Number(textAt(result.data, "ops:world-patent-data", "ops:biblio-search", "@total-result-count"));
  return {
    hits: documents.map((document) => toOpsHit(document, result.provenance)),
    provenance: result.provenance,
    total: Number.isFinite(total) ? total : undefined,
  };
}

export async function bibliographic(
  reference: string,
): Promise<{ hits: PatentHit[]; provenance: Provenance }> {
  const normalized = normalizeReference(reference);
  const result = await ops<unknown>(
    `/3.2/rest-services/published-data/publication/epodoc/${encodeURIComponent(normalized)}/biblio`,
    undefined,
    normalized,
  );
  const documents = findDocuments(result.data);
  return { hits: documents.map((document) => toOpsHit(document, result.provenance)), provenance: result.provenance };
}

export async function fullText(reference: string): Promise<{ data: unknown; provenance: Provenance }> {
  const normalized = normalizeReference(reference);
  const result = await ops<unknown>(
    `/3.2/rest-services/published-data/publication/epodoc/${encodeURIComponent(normalized)}/fulltext`,
    undefined,
    normalized,
  );
  return { data: result.data, provenance: result.provenance };
}

export async function family(reference: string): Promise<{ data: unknown; provenance: Provenance }> {
  const normalized = normalizeReference(reference);
  const result = await ops<unknown>(
    `/3.2/rest-services/family/publication/epodoc/${encodeURIComponent(normalized)}`,
    undefined,
    normalized,
  );
  return { data: result.data, provenance: result.provenance };
}

/** Drawing images are served as PDF pages; request a byte range for one page. */
export function imageUrl(reference: string, page = 1): string {
  const normalized = normalizeReference(reference);
  const base = config.providers.ops.baseUrl;
  return `${base}/3.2/rest-services/published-data/images/epodoc/${encodeURIComponent(normalized)}/fullimage.pdf?Range=${page}-${page}`;
}
