import { homedir } from "node:os";
import { join } from "node:path";
import { windowsUserEnv } from "./util/winenv.js";

export type ProviderName = "odp" | "tsdr" | "ops" | "ppubs" | "tmsearch" | "index" | "openalex" | "arxiv" | "github";

export interface ProviderEndpoint {
  readonly baseUrl: string;
  readonly key?: string;
  readonly keyHeader?: string;
}

const env = process.env;

/**
 * Process environment first; on Windows or WSL, fall back to the Windows user
 * environment, read once per process (see util/winenv.ts).
 */
function readKey(name: string): string | undefined {
  const value = env[name];
  if (value && value.trim() !== "") return value.trim();
  return windowsUserEnv()[name];
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
    openalex: {
      baseUrl: env.OPENALEX_BASE_URL ?? "https://api.openalex.org",
      key: readKey("OPENALEX_API_KEY"),
    },
    arxiv: {
      baseUrl: env.ARXIV_BASE_URL ?? "https://export.arxiv.org",
    },
    github: {
      baseUrl: env.GITHUB_API_BASE_URL ?? "https://api.github.com",
      key: readKey("GITHUB_TOKEN"),
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
      provider: "openalex",
      configured: true,
      required: ["OPENALEX_API_KEY (optional)"],
      detail: config.providers.openalex.key
        ? "OpenAlex scholarly works search with your own free key (its own daily budget)."
        : "OpenAlex works without a key on a small shared daily budget. For a key of your own, sign in at https://openalex.org/settings/api and set OPENALEX_API_KEY.",
      host: new URL(config.providers.openalex.baseUrl).host,
    },
    {
      provider: "arxiv",
      configured: true,
      required: [],
      detail: "arXiv API, no key. Requests are spaced at least 3 seconds apart per the arXiv API terms.",
      host: new URL(config.providers.arxiv.baseUrl).host,
    },
    {
      provider: "github",
      configured: true,
      required: ["GITHUB_TOKEN (optional)"],
      detail: config.providers.github.key
        ? "GitHub repository search with a token (30 searches per minute). The token is sent only to api.github.com and only for read-only search."
        : "GitHub repository search without a token (10 searches per minute). Set GITHUB_TOKEN to raise the limit; a token with no scopes is enough.",
      host: new URL(config.providers.github.baseUrl).host,
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
