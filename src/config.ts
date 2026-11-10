import { homedir } from "node:os";
import { join } from "node:path";

export type ProviderName = "odp" | "tsdr" | "ops" | "ppubs" | "tmsearch" | "index";

export interface ProviderEndpoint {
  readonly baseUrl: string;
  readonly key?: string;
  readonly keyHeader?: string;
}

const env = process.env;

function readKey(name: string): string | undefined {
  const value = env[name];
  return value && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * Undocumented USPTO surfaces (Patent Public Search, Trademark Search backend)
 * are disabled unless explicitly enabled. They carry no published contract and
 * sit behind USPTO terms of use that permit access to be withdrawn.
 */
export const allowUnofficial = env.IP_ALLOW_UNOFFICIAL === "1";

export const config = {
  userAgent: env.IP_USER_AGENT ?? "ip-search-mcp/0.1.0 (stdio MCP server)",
  timeoutMs: Number(env.IP_TIMEOUT_MS ?? 30_000),
  maxRetries: Number(env.IP_MAX_RETRIES ?? 2),
  cacheDir: env.IP_CACHE_DIR ?? join(homedir(), ".cache", "ip-search-mcp"),
  indexDbPath: env.IP_INDEX_DB ?? join(homedir(), ".cache", "ip-search-mcp", "ip-index.sqlite"),
  allowUnofficial,
  providers: {
    odp: {
      baseUrl: env.USPTO_ODP_BASE_URL ?? "https://api.uspto.gov",
      key: readKey("USPTO_ODP_API_KEY"),
      keyHeader: "X-API-KEY",
    },
    tsdr: {
      baseUrl: env.USPTO_TSDR_BASE_URL ?? "https://tsdrapi.uspto.gov",
      key: readKey("USPTO_TSDR_API_KEY"),
      keyHeader: "USPTO-API-KEY",
    },
    ops: {
      baseUrl: env.EPO_OPS_BASE_URL ?? "https://ops.epo.org",
      key: readKey("EPO_OPS_CLIENT_ID"),
      keyHeader: "Authorization",
      clientSecret: readKey("EPO_OPS_CLIENT_SECRET"),
    },
    ppubs: {
      baseUrl: env.PPUBS_BASE_URL ?? "https://ppubs.uspto.gov",
    },
    tmsearch: {
      baseUrl: env.TMSEARCH_BASE_URL ?? "https://tmsearch.uspto.gov",
      wafToken: readKey("TMSEARCH_WAF_TOKEN"),
    },
  },
} as const;

export interface CredentialState {
  provider: ProviderName;
  configured: boolean;
  required: string[];
  detail: string;
  host: string;
}

export function credentialStates(): CredentialState[] {
  const states: CredentialState[] = [
    {
      provider: "odp",
      configured: Boolean(config.providers.odp.key),
      required: ["USPTO_ODP_API_KEY"],
      detail:
        "USPTO Open Data Portal key. Create a USPTO.gov account with MFA, sign in at https://data.uspto.gov, then create the key on the Manage API Key page. Sent only to api.uspto.gov.",
      host: new URL(config.providers.odp.baseUrl).host,
    },
    {
      provider: "tsdr",
      configured: Boolean(config.providers.tsdr.key),
      required: ["USPTO_TSDR_API_KEY"],
      detail:
        "TSDR key from https://account.uspto.gov/api-manager/. Separate credential from the ODP key; never sent to api.uspto.gov.",
      host: new URL(config.providers.tsdr.baseUrl).host,
    },
    {
      provider: "ops",
      configured: Boolean(
        config.providers.ops.key && config.providers.ops.clientSecret,
      ),
      required: ["EPO_OPS_CLIENT_ID", "EPO_OPS_CLIENT_SECRET"],
      detail:
        "EPO Open Patent Services OAuth2 client credentials from https://developers.epo.org. Free tier is governed by the EPO fair use charter.",
      host: new URL(config.providers.ops.baseUrl).host,
    },
    {
      provider: "ppubs",
      configured: allowUnofficial,
      required: ["IP_ALLOW_UNOFFICIAL=1"],
      detail: allowUnofficial
        ? "Undocumented Patent Public Search session API enabled. No published contract; USPTO terms allow access to be withdrawn. Not a legal record."
        : "Disabled. Enable with IP_ALLOW_UNOFFICIAL=1 only if you accept the undocumented-contract and terms-of-use risk.",
      host: new URL(config.providers.ppubs.baseUrl).host,
    },
    {
      provider: "tmsearch",
      configured: allowUnofficial,
      required: ["IP_ALLOW_UNOFFICIAL=1", "TMSEARCH_WAF_TOKEN (optional)"],
      detail: allowUnofficial
        ? "Undocumented Trademark Search backend enabled. Search results are candidates only; hydrate with TSDR before relying on them."
        : "Disabled. Enable with IP_ALLOW_UNOFFICIAL=1 only if you accept the undocumented-contract and terms-of-use risk.",
      host: new URL(config.providers.tmsearch.baseUrl).host,
    },
    {
      provider: "index",
      configured: true,
      required: [],
      detail:
        "Local SQLite FTS5 index built from USPTO bulk files. Requires an explicit build step; until then searches return zero hits with a warning.",
      host: "local file",
    },
  ];
  return states;
}
