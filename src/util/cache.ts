import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { config } from "../config.js";

interface CacheEnvelope {
  storedAt: number;
  expiresAt: number;
  body: string;
  contentType: string;
}

export function cacheKey(parts: unknown): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function cachePath(key: string): string {
  return join(config.cacheDir, key.slice(0, 2), `${key}.json`);
}

/** An expired entry is deleted when it is read. Perf: P1 · one file read · CRAP <= 10 (CC 5). */
export async function readCache(key: string): Promise<CacheEnvelope | undefined> {
  const path = cachePath(key);
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as CacheEnvelope;
    if (typeof parsed.expiresAt === "number" && Date.now() <= parsed.expiresAt) return parsed;
  } catch {
    return undefined;
  }
  await rm(path, { force: true }).catch(() => undefined);
  return undefined;
}

/**
 * Delete the oldest entries until the cache fits `maxBytes`. Only the cache's
 * own two-hex-digit directories and `.json` files are touched, so the local
 * index that may share the directory is never evicted. Best effort: a file
 * that vanishes mid-sweep is ignored. Perf: P3 · one stat per entry · CRAP <= 15 (CC 8).
 */
export async function evictCache(maxBytes = config.cacheMaxBytes): Promise<void> {
  const entries: Array<{ path: string; size: number; mtimeMs: number }> = [];
  try {
    for (const dir of await readdir(config.cacheDir)) {
      if (!/^[0-9a-f]{2}$/.test(dir)) continue;
      for (const name of await readdir(join(config.cacheDir, dir)).catch(() => [] as string[])) {
        if (!name.endsWith(".json")) continue;
        const path = join(config.cacheDir, dir, name);
        const info = await stat(path).catch(() => undefined);
        if (info) entries.push({ path, size: info.size, mtimeMs: info.mtimeMs });
      }
    }
  } catch {
    return;
  }
  let total = entries.reduce((sum, entry) => sum + entry.size, 0);
  for (const entry of entries.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    if (total <= maxBytes) return;
    await rm(entry.path, { force: true }).catch(() => undefined);
    total -= entry.size;
  }
}

/** The size cap is checked on the first write of a process and then every this many writes. */
const SWEEP_EVERY = 50;
let writes = 0;
let sweeping: Promise<void> | undefined;

export async function writeCache(
  key: string,
  body: string,
  contentType: string,
  ttlMs: number,
): Promise<void> {
  const target = cachePath(key);
  await mkdir(dirname(target), { recursive: true });
  const envelope: CacheEnvelope = {
    storedAt: Date.now(),
    expiresAt: Date.now() + ttlMs,
    body,
    contentType,
  };
  const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temp, JSON.stringify(envelope), "utf8");
  await rename(temp, target);
  if (writes++ % SWEEP_EVERY === 0 && !sweeping) {
    sweeping = evictCache().finally(() => {
      sweeping = undefined;
    });
    await sweeping;
  }
}
