// Tests run without credentials wherever they run: clear provider keys, never
// read keys from the Windows user environment, and keep the response cache and
// the local index in a scratch directory so no run depends on an earlier one.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.IP_WINDOWS_ENV = "0";
for (const name of ["USPTO_ODP_API_KEY", "USPTO_TSDR_API_KEY", "EPO_OPS_CLIENT_ID", "EPO_OPS_CLIENT_SECRET", "OPENALEX_API_KEY", "GITHUB_TOKEN"]) {
  delete process.env[name];
}
const scratch = mkdtempSync(join(tmpdir(), "ip-search-mcp-test-"));
process.env.IP_CACHE_DIR = join(scratch, "cache");
process.env.IP_INDEX_DB = join(scratch, "ip-index.sqlite");
