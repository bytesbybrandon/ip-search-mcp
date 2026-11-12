import { spawnSync } from "node:child_process";
import { release } from "node:os";

/** Variables this server may read from the Windows user environment. Nothing else is kept. */
export const WINDOWS_ENV_NAMES = [
  "USPTO_ODP_API_KEY",
  "USPTO_TSDR_API_KEY",
  "EPO_OPS_CLIENT_ID",
  "EPO_OPS_CLIENT_SECRET",
  "OPENALEX_API_KEY",
  "GITHUB_TOKEN",
] as const;

let memo: Record<string, string> | undefined;

/**
 * Parse `reg query HKCU\Environment` output, keeping only allowlisted names.
 * Perf: P1 · O(lines) · CRAP <= 15 (CC 4, branch coverage >= 80%).
 */
export function parseRegQuery(output: string, allowed: readonly string[] = WINDOWS_ENV_NAMES): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s+(\S+)\s+REG_(?:EXPAND_)?SZ\s+(.*)$/.exec(line);
    if (!match) continue;
    const [, name, value] = match;
    if (name && allowed.includes(name) && value && value.trim() !== "") out[name] = value.trim();
  }
  return out;
}

function onWindowsHost(): boolean {
  if (process.env.IP_WINDOWS_ENV === "0") return false;
  if (process.platform === "win32") return true;
  return process.platform === "linux" && (Boolean(process.env.WSL_DISTRO_NAME) || /microsoft/i.test(release()));
}

/**
 * Read the Windows user environment once per process (WSL or native Windows),
 * so keys set with `setx` or the System dialog are visible without restarting
 * the MCP client and without one PowerShell launch per call. Values stay in
 * memory; they are never logged or written. Set IP_WINDOWS_ENV=0 to disable.
 * Perf: P1 · one `reg query` (about 0.1 s), then O(1) · CRAP <= 15 (CC 4).
 */
export function windowsUserEnv(): Record<string, string> {
  if (memo) return memo;
  memo = {};
  if (!onWindowsHost()) return memo;
  const result = spawnSync(process.platform === "win32" ? "reg" : "reg.exe", ["query", "HKCU\\Environment"], {
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status === 0 && typeof result.stdout === "string") memo = parseRegQuery(result.stdout);
  return memo;
}
