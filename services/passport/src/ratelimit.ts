// Weight-per-minute limiter shared by the HL info client (§2.11) and the HyperEVM reader (§3).

export type Sleep = (ms: number) => Promise<void>;
export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export type LimiterOptions = {
  now?: () => number;
  sleep?: Sleep;
};

const WINDOW_MS = 60_000;

/**
 * At most `perMinute` weight in ANY 60 s window. A sliding window, not a token bucket: a full
 * 800 bucket refilling at 800/min let 1,580 weight through in one minute, over HL's 1,200 IP cap
 * (measured 2026-10-11). Waiters are served first-in, first-out.
 */
export class WeightLimiter {
  readonly perMinute: number;
  #log: Array<{ at: number; weight: number }> = [];
  #used = 0;
  #now: () => number;
  #sleep: Sleep;
  #queue: Promise<void> = Promise.resolve();

  constructor(perMinute: number, opts: LimiterOptions = {}) {
    if (!(perMinute > 0)) throw new RangeError("perMinute must be positive");
    this.perMinute = perMinute;
    this.#now = opts.now ?? Date.now;
    this.#sleep = opts.sleep ?? realSleep;
  }

  /** Weight that could be spent right now (for /health). */
  available(): number {
    this.#expire(this.#now());
    return this.perMinute - this.#used;
  }

  /** Wait until `weight` fits in the window, then record it. */
  take(weight: number): Promise<void> {
    if (!(weight > 0) || weight > this.perMinute) {
      return Promise.reject(new RangeError(`weight ${weight} must be in (0, ${this.perMinute}]`));
    }
    const turn = this.#queue.then(async () => {
      for (;;) {
        const t = this.#now();
        this.#expire(t);
        if (this.#used + weight <= this.perMinute) {
          this.#log.push({ at: t, weight });
          this.#used += weight;
          return;
        }
        // Sleep until enough of the oldest spends have left the window.
        let excess = this.#used + weight - this.perMinute;
        let wakeAt = t;
        for (const e of this.#log) {
          excess -= e.weight;
          wakeAt = e.at + WINDOW_MS;
          if (excess <= 0) break;
        }
        await this.#sleep(Math.max(1, wakeAt - t));
      }
    });
    this.#queue = turn.catch(() => {});
    return turn;
  }

  /** A spend at time `at` counts for [at, at + 60 s). */
  #expire(t: number): void {
    while (this.#log.length > 0 && this.#log[0]!.at <= t - WINDOW_MS) {
      this.#used -= this.#log.shift()!.weight;
    }
  }
}

/**
 * Non-blocking per-key request counter for the HTTP API (§8 rate limits): a sliding window per key.
 * Single process, in memory: limits reset when the service restarts.
 */
export class HitCounter {
  #hits = new Map<string, number[]>();
  #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** Record a hit for `key` if it is under `limit` per `windowMs`. Returns 0, or ms until a slot frees. */
  hit(key: string, limit: number, windowMs: number): number {
    const t = this.#now();
    const recent = (this.#hits.get(key) ?? []).filter((at) => at > t - windowMs);
    if (recent.length >= limit) {
      this.#hits.set(key, recent);
      return recent[0]! + windowMs - t;
    }
    recent.push(t);
    this.#hits.set(key, recent);
    if (this.#hits.size > 50_000) this.#sweep(t, windowMs);
    return 0;
  }

  #sweep(t: number, windowMs: number): void {
    for (const [k, v] of this.#hits) if (v.every((at) => at <= t - windowMs)) this.#hits.delete(k);
  }
}
