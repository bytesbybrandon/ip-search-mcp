import { indexStatus, buildIndex } from "./providers/index.js";
import { config, credentialStates } from "./config.js";

const HELP = `ip-search-mcp

Usage:
  ip-search-mcp                     Start the MCP server on stdio
  ip-search-mcp index build --from <dir> [--db <path>]
  ip-search-mcp index status [--db <path>]
  ip-search-mcp status              Report which provider keys are visible to this process
  ip-search-mcp rules               Print the encoded 37 CFR 1.84 rule set
  ip-search-mcp --help

Environment:
  USPTO_ODP_API_KEY       USPTO Open Data Portal key (api.uspto.gov only)
  USPTO_TSDR_API_KEY      TSDR key (tsdrapi.uspto.gov only)
  EPO_OPS_CLIENT_ID       EPO OPS OAuth2 client id
  EPO_OPS_CLIENT_SECRET   EPO OPS OAuth2 client secret
  OPENALEX_API_KEY        Optional OpenAlex key (own daily budget)
  GITHUB_TOKEN            Optional GitHub token (higher repository-search limit)
  IP_WINDOWS_ENV=0        Do not read missing keys from the Windows user environment
  IP_ALLOW_UNOFFICIAL=1   Enable undocumented Patent Public Search and Trademark Search adapters
  TMSEARCH_WAF_TOKEN      Optional aws-waf-token cookie for Trademark Search
  IP_INDEX_DB             Local index path (default ${config.indexDbPath})
  IP_CACHE_DIR            Cache directory (default ${config.cacheDir})

Nothing in this tool files, signs, or submits an application.
`;

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export async function runCli(args: string[]): Promise<number> {
  const [group, action] = args;

  if (args.includes("--help") || args.includes("-h") || group === "help") {
    process.stdout.write(HELP);
    return 0;
  }

  if (group === "status") {
    const report = {
      allowUnofficial: config.allowUnofficial,
      providers: credentialStates().map((state) => ({
        provider: state.provider,
        configured: state.configured,
        required: state.required,
        host: state.host,
      })),
      index: indexStatus(),
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }

  if (group === "rules") {
    const { DRAWING_RULES, SHEET_PRESETS, CFR_184_URL, CFR_184_RETRIEVED } = await import("./domain/drawings/rules.js");
    process.stdout.write(
      `${JSON.stringify({ source: CFR_184_URL, retrieved: CFR_184_RETRIEVED, presets: SHEET_PRESETS, rules: DRAWING_RULES }, null, 2)}\n`,
    );
    return 0;
  }

  if (group === "index") {
    const dbPath = flag(args, "--db") ?? config.indexDbPath;
    if (action === "status" || action === undefined) {
      process.stdout.write(`${JSON.stringify(indexStatus(dbPath), null, 2)}\n`);
      return 0;
    }
    if (action === "build") {
      const sourceDir = flag(args, "--from");
      if (!sourceDir) {
        process.stderr.write("index build requires --from <dir>\n");
        return 2;
      }
      const result = await buildIndex(sourceDir, dbPath);
      process.stdout.write(`${JSON.stringify({ ...result, status: indexStatus(dbPath) }, null, 2)}\n`);
      return 0;
    }
    process.stderr.write(`unknown index action: ${action}\n`);
    return 2;
  }

  process.stderr.write(HELP);
  return 2;
}
