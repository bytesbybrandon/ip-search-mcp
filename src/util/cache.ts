import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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

export async function readCache(key: string): Promise<CacheEnvelope | undefined> {
  try {
    const raw = await readFile(cachePath(key), "utf8");
    const parsed = JSON.parse(raw) as CacheEnvelope;
    if (typeof parsed.expiresAt !== "number" || Date.now() > parsed.expiresAt) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

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
}
