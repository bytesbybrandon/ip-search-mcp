import { config, ProviderName } from "./config.js";
import { IpError } from "./errors.js";
import { cacheKey, readCache, writeCache } from "./util/cache.js";
import { delay } from "./util/delay.js";
import { getLimiter } from "./util/rate.js";

export interface Provenance {
  provider: ProviderName | "derived";
  route: string;
  retrievedAt: string;
  sourceId?: string;
  undocumented?: boolean;
  cached?: boolean;
  note?: string;
}

export interface HttpJsonResult<T> {
  data: T;
  provenance: Provenance;
  raw: string;
}

export interface HttpTextResult {
  text: string;
  contentType: string;
  provenance: Provenance;
}

export interface RequestOptions {
  provider: ProviderName;
  route: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
  /** Sent as application/x-www-form-urlencoded instead of a JSON body. */
  form?: Record<string, string>;
  query?: Record<string, string | number | undefined>;
  accept?: "json" | "text";
  cache?: { ttlMs: number };
  rateLimit?: { name: string; perMinute: number; minIntervalMs?: number };
  timeoutMs?: number;
  retries?: number;
  sourceId?: string;
  undocumented?: boolean;
}

const SECRET_HEADERS: Record<string, true> = {
  "x-api-key": true,
  "uspto-api-key": true,
  authorization: true,
  "x-access-token": true,
};

/**
 * A credential belongs to one host. Sending an ODP key to TSDR (or a TSDR key
 * to ODP) is a hard failure, not a fallback.
 */
function assertHostSafe(provider: ProviderName, host: string): void {
  const expected = new URL(providerBase(provider)).host;
  if (host !== expected) {
    throw new IpError(
      "INVALID_INPUT",
      `refusing to send ${provider} credentials to ${host}; expected ${expected}`,
      { provider, hint: "Provider hosts are fixed in config; do not override them per request." },
    );
  }
}

function providerBase(provider: ProviderName): string {
  switch (provider) {
    case "odp":
      return config.providers.odp.baseUrl;
    case "tsdr":
      return config.providers.tsdr.baseUrl;
    case "ops":
      return config.providers.ops.baseUrl;
    case "ppubs":
      return config.providers.ppubs.baseUrl;
    case "tmsearch":
      return config.providers.tmsearch.baseUrl;
    case "openalex":
      return config.providers.openalex.baseUrl;
    case "arxiv":
      return config.providers.arxiv.baseUrl;
    case "github":
      return config.providers.github.baseUrl;
    case "wayback":
      return config.providers.wayback.baseUrl;
    case "urlscan":
      return config.providers.urlscan.baseUrl;
    case "archivetoday":
      return config.providers.archivetoday.baseUrl;
    case "index":
      return "file://";
    default:
      throw new IpError("INVALID_INPUT", `unknown provider: ${String(provider)}`);
  }
}

function buildUrl(provider: ProviderName, route: string, query?: RequestOptions["query"]): URL {
  assertHostSafe(provider, new URL(providerBase(provider)).host);
  const url = new URL(route, providerBase(provider));
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }
  return url;
}

function headerMap(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = { "user-agent": config.userAgent };
  for (const [name, value] of Object.entries(headers ?? {})) {
    out[name.toLowerCase()] = value;
  }
  return out;
}

function sanitizedHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = SECRET_HEADERS[name] === true ? "[redacted]" : value;
  }
  return out;
}

/** A provider that asks for a longer wait than this is skipped, not waited for, so one source cannot stall a search. */
const MAX_RETRY_WAIT_MS = 30_000;

function retryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

async function perform(
  url: URL,
  options: RequestOptions,
  headers: Record<string, string>,
): Promise<Response> {
  const limiter = options.rateLimit
    ? getLimiter(options.rateLimit.name, options.rateLimit.perMinute, options.rateLimit.minIntervalMs)
    : undefined;
  const retries = options.retries ?? config.maxRetries;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (limiter) await limiter.acquire();
    try {
      const response = await fetch(url, {
        method: options.method ?? "GET",
        headers,
        body: options.form
          ? new URLSearchParams(options.form).toString()
          : options.body === undefined
            ? undefined
            : JSON.stringify(options.body),
        signal: AbortSignal.timeout(options.timeoutMs ?? config.timeoutMs),
        redirect: "follow",
      });

      if (response.status === 429 || response.status >= 500) {
        const waitMs = retryAfterMs(response) ?? Math.min(8000, 250 * 2 ** attempt);
        if (attempt < retries && waitMs <= MAX_RETRY_WAIT_MS) {
          await delay(waitMs);
          continue;
        }
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await delay(Math.min(8000, 250 * 2 ** attempt));
        continue;
      }
    }
  }

  throw new IpError("UPSTREAM", `request to ${url.host} failed: ${String(lastError)}`, {
    provider: options.provider,
    hint: "Check network access and the provider status page.",
    details: sanitizedHeaders(headers),
  });
}

async function interpret(
  response: Response,
  options: RequestOptions,
  url: URL,
): Promise<{ body: string; contentType: string }> {
  if (response.ok) {
    return { body: await response.text(), contentType: response.headers.get("content-type") ?? "" };
  }

  const body = await response.text().catch(() => "");
  const snippet = body.slice(0, 400);

  if (response.status === 401 || response.status === 403) {
    throw new IpError("CREDENTIAL_MISSING", `${options.provider} rejected the request (${response.status})`, {
      provider: options.provider,
      status: response.status,
      hint:
        options.provider === "odp" || options.provider === "tsdr"
          ? "Set USPTO_ODP_API_KEY or USPTO_TSDR_API_KEY. USPTO keys are not interchangeable between systems."
          : "Check provider credentials and that the account is active.",
      details: snippet,
    });
  }
  if (response.status === 404) {
    throw new IpError("NOT_FOUND", `${options.provider} returned no record for ${url.pathname}`, {
      provider: options.provider,
      status: 404,
      details: snippet,
    });
  }
  if (response.status === 429) {
    const wait = retryAfterMs(response);
    throw new IpError("RATE_LIMITED", `${options.provider} rate limit exceeded${wait === undefined ? "" : ` (asked to wait ${Math.ceil(wait / 1000)} s)`}`, {
      provider: options.provider,
      status: 429,
      hint: "Wait for the provider window to reset. TSDR allows 60/min, 4/min for PDF and ZIP.",
      details: snippet,
    });
  }
  throw new IpError("UPSTREAM", `${options.provider} failed with ${response.status}`, {
    provider: options.provider,
    status: response.status,
    details: snippet,
  });
}

export async function requestJson<T>(options: RequestOptions): Promise<HttpJsonResult<T>> {
  const url = buildUrl(options.provider, options.route, options.query);
  const headers = headerMap(options.headers);
  if ((options.accept ?? "json") === "json") {
    headers.accept = headers.accept ?? "application/json";
  }
  if (options.form) headers["content-type"] = "application/x-www-form-urlencoded";
  else if (options.body !== undefined) headers["content-type"] = headers["content-type"] ?? "application/json";

  const key = options.cache
    ? cacheKey({ provider: options.provider, url: url.href, body: options.form ?? options.body ?? null })
    : undefined;
  const provenanceBase = {
    provider: options.provider,
    route: `${options.method ?? "GET"} ${url.pathname}${url.search}`,
    retrievedAt: new Date().toISOString(),
    sourceId: options.sourceId,
    undocumented: options.undocumented,
  };

  if (key) {
    const cached = await readCache(key);
    if (cached) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(cached.body);
      } catch {
        parsed = undefined;
      }
      if (parsed !== undefined) {
        return {
          data: parsed as T,
          raw: cached.body,
          provenance: { ...provenanceBase, cached: true },
        };
      }
    }
  }

  const response = await perform(url, options, headers);
  const { body, contentType } = await interpret(response, options, url);
  if (key) await writeCache(key, body, contentType, options.cache!.ttlMs);

  let parsed: T;
  try {
    parsed = JSON.parse(body) as T;
  } catch {
    throw new IpError("UPSTREAM", `${options.provider} returned a non-JSON body`, {
      provider: options.provider,
      hint: "The provider may be serving an HTML error page or requiring a different Accept header.",
      details: body.slice(0, 400),
    });
  }
  return { data: parsed, raw: body, provenance: provenanceBase };
}

export async function requestText(options: RequestOptions): Promise<HttpTextResult> {
  const url = buildUrl(options.provider, options.route, options.query);
  const headers = headerMap(options.headers);
  headers.accept = headers.accept ?? "application/xml, text/html, text/plain, */*";
  const provenance: Provenance = {
    provider: options.provider,
    route: `${options.method ?? "GET"} ${url.pathname}${url.search}`,
    retrievedAt: new Date().toISOString(),
    sourceId: options.sourceId,
    undocumented: options.undocumented,
  };

  const key = options.cache ? cacheKey({ provider: options.provider, url: url.href, body: options.body ?? null }) : undefined;
  if (key) {
    const cached = await readCache(key);
    if (cached) return { text: cached.body, contentType: cached.contentType, provenance: { ...provenance, cached: true } };
  }

  const response = await perform(url, options, headers);
  const { body, contentType } = await interpret(response, options, url);
  if (key) await writeCache(key, body, contentType, options.cache!.ttlMs);
  return { text: body, contentType, provenance };
}
