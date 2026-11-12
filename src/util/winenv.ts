import { spawnSync } from "node:child_process";
import { release } from "node:os";

/** Variables this server may read from the Windows user environment. Nothing else is kept. */
export const WINDOWS_ENV_NAMES = [
  "USPTO_ODP_API_KEY",
  "USPTO_TSDR_API_KEY",
  "EPO_OPS_CLIENT_ID",
  "EPO_OPS_CLIENT_SECRET",
  "OPENALEX_API_KEY",
] as const;
// GITHUB_TOKEN is deliberately absent: a personal GitHub token can often write, and
// search needs none, so it is only taken from the process environment.

/**
 * Parse `reg query HKCU\Environment` output, keeping only allowlisted names.
 * Perf: P1 · O(lines) · CRAP <= 15 (CC 4).
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

let memo: Record<string, string> | undefined;

function readRegistry(): Record<string, string> {
  if (!onWindowsHost()) return {};
  const result = spawnSync(process.platform === "win32" ? "reg" : "reg.exe", ["query", "HKCU\\Environment"], {
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 && typeof result.stdout === "string" ? parseRegQuery(result.stdout) : {};
}

/**
 * The Windows user environment (WSL or native Windows), read once per process
 * so keys set with `setx` or the System dialog are visible without restarting
 * the MCP client. The slow path was a per-call key read that launched
 * PowerShell on every call; a hang under parallel calls was reported but could
 * not be reproduced in the server. This is one `reg query` (about 0.1 s) on
 * first use. Values stay in memory; they are never logged or written. Set
 * IP_WINDOWS_ENV=0 to disable. Perf: P1 · one `reg query`, then O(1) · CRAP <= 15 (CC 4).
 */
export function windowsUserEnv(): Record<string, string> {
  return (memo ??= readRegistry());
}
