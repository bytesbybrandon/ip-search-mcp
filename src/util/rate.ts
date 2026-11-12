import { delay } from "./delay.js";
/**
 * Sliding-window rate limiter shared by provider clients.
 *
 * USPTO publishes per-key limits for TSDR (60/min general, 4/min for PDF and
 * ZIP downloads, doubled off-peak). ODP publishes limits on its API rate-limit
 * page. Limits are expressed per minute here because that is how both sources
 * document them.
 */
export class RateLimiter {
  private readonly windowMs = 60_000;
  private readonly perWindow: number;
  private readonly minIntervalMs: number;
  private stamps: number[] = [];
  private chain: Promise<void> = Promise.resolve();

  /** `minIntervalMs` spaces consecutive requests (arXiv asks for three seconds between calls). */
  constructor(perMinute: number, minIntervalMs = 0) {
    if (!Number.isFinite(perMinute) || perMinute <= 0) {
      throw new Error(`invalid rate limit: ${perMinute}`);
    }
    this.perWindow = perMinute;
    this.minIntervalMs = minIntervalMs;
  }

  acquire(): Promise<void> {
    const run = this.chain.then(() => this.waitForSlot());
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async waitForSlot(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.stamps = this.stamps.filter((stamp) => now - stamp < this.windowMs);
      const last = this.stamps[this.stamps.length - 1];
      if (last !== undefined && now - last < this.minIntervalMs) {
        await delay(last + this.minIntervalMs - now);
        continue;
      }
      if (this.stamps.length < this.perWindow) {
        this.stamps.push(now);
        return;
      }
      const oldest = this.stamps[0] ?? now;
      const waitMs = Math.max(20, oldest + this.windowMs - now + 10);
      await delay(waitMs);
    }
  }
}

const limiters = new Map<string, RateLimiter>();

export function getLimiter(name: string, perMinute: number, minIntervalMs = 0): RateLimiter {
  const existing = limiters.get(name);
  if (existing) return existing;
  const limiter = new RateLimiter(perMinute, minIntervalMs);
  limiters.set(name, limiter);
  return limiter;
}
