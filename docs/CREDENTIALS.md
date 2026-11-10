# Credentials

This server never asks a tool caller for a key. Keys come from the process environment, and each key is bound to one host.

## Where to put a key

Pick one location per use.

**Agents and MCP clients.** Fill the `env` block of the `ip-search-mcp` entry in your client configuration, then restart the client so the server is respawned:

```json
"ip-search-mcp": {
  "command": "node",
  "args": ["/absolute/path/to/ip-search-mcp/dist/src/index.js"],
  "env": {
    "USPTO_ODP_API_KEY": "your-odp-key",
    "USPTO_TSDR_API_KEY": "your-tsdr-key"
  }
}
```

Empty strings are treated as unset, so leaving a slot blank is safe.

**Your shell, for CLI runs and tests.** Set the variables for the session, or persist them to the user profile:

```powershell
$env:USPTO_ODP_API_KEY = "your-odp-key"
$env:USPTO_TSDR_API_KEY = "your-tsdr-key"
[Environment]::SetEnvironmentVariable("USPTO_ODP_API_KEY", "your-odp-key", "User")
```

**A local `.env` file.** The server does not load `.env` by itself. Pass it explicitly:

```bash
node --env-file=.env dist/src/index.js
```

`.env` is gitignored. Never put a key in a tool argument, a prompt, a commit, or a skill file.

**Verify.** This prints booleans only, never key values:

```bash
node dist/src/index.js status
```

A provider shows `configured: true` only when its full set of variables is non-empty.

## USPTO Open Data Portal (ODP)

Used for: patent file wrapper search, metadata, continuity, documents, bulk products.

1. Create a USPTO.gov account and enable multi-factor authentication.
2. Sign in at https://data.uspto.gov.
3. Open Manage API Key and create a key.
4. Keep the four profile fields the portal requires current; keys for incomplete profiles can be deactivated.
5. Set `USPTO_ODP_API_KEY`.

Sent only to `api.uspto.gov` as `X-API-KEY`. ODP documentation and swagger sit behind the same sign-in.

## TSDR (trademark status and documents)

Used for: authoritative case status, documents, mark images.

1. Create or sign in to a USPTO.gov account.
2. Open https://account.uspto.gov/api-manager/ and create a TSDR key.
3. Set `USPTO_TSDR_API_KEY`.

Sent only to `tsdrapi.uspto.gov` as `USPTO-API-KEY`. This is a different credential from the ODP key. TSDR is an identifier lookup, not a search engine: you need a serial, registration, IR, or reference number.

## EPO Open Patent Services (OPS)

Used for: worldwide bibliographic data, full text, families, images.

1. Register at https://developers.epo.org.
2. Create an application to get a consumer key and secret.
3. Set `EPO_OPS_CLIENT_ID` and `EPO_OPS_CLIENT_SECRET`.

OAuth2 client-credentials token against `ops.epo.org`; the token is cached until shortly before expiry. Usage is governed by the EPO fair use charter.

## Undocumented surfaces (off by default)

| Variable | Effect |
|----------|--------|
| `IP_ALLOW_UNOFFICIAL=1` | Enables Patent Public Search and the Trademark Search backend adapters |
| `TMSEARCH_WAF_TOKEN` | Optional `aws-waf-token` cookie copied from a browser session |

Both surfaces have no published contract, can change shape without notice, and sit behind terms of use that permit the USPTO to cut off automated access. Results from them are labeled `undocumented: true` in provenance.

## Operational settings

| Variable | Default | Purpose |
|----------|---------|---------|
| `IP_CACHE_DIR` | `~/.cache/ip-search-mcp` | File cache |
| `IP_INDEX_DB` | `~/.cache/ip-search-mcp/ip-index.sqlite` | Local FTS index |
| `IP_TIMEOUT_MS` | `30000` | Per-request timeout |
| `IP_MAX_RETRIES` | `2` | Retry count for 429, 5xx, and network errors |
| `IP_USER_AGENT` | `ip-search-mcp/0.1.0 (stdio MCP server)` | User-Agent header |
| `PPUBS_BASE_URL`, `TMSEARCH_BASE_URL`, `USPTO_ODP_BASE_URL`, `USPTO_TSDR_BASE_URL`, `EPO_OPS_BASE_URL` | provider defaults | Host overrides for testing only |

Overriding a base URL does not let a key travel to the new host: the host check compares against the configured base, and keys are attached after that check.

## Handling rules

- Do not pass keys through tool arguments, prompts, or committed files.
- Do not copy a key from one provider's console to another provider's variable.
- Rotate a key if it appears in a transcript, log, or error message.
- Error details redact `authorization`, `x-api-key`, `uspto-api-key`, and `x-access-token`.
