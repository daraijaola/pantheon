import { describe, expect, it } from "vitest";
import { WeightLimiter } from "../src/ratelimit.ts";

/** A clock that only moves when the limiter sleeps (or a test moves it). */
function fakeTime() {
  const t = { now: 0, slept: [] as number[] };
  return {
    t,
    opts: {
      now: () => t.now,
      sleep: async (ms: number) => {
        t.slept.push(ms);
        t.now += ms;
      },
    },
  };
}

describe("WeightLimiter", () => {
  it("spends without waiting while the budget lasts", async () => {
    const { t, opts } = fakeTime();
    const l = new WeightLimiter(800, opts);
    await l.take(202); // a first link (§2.11)
    await l.take(598);
    expect(t.slept).toEqual([]);
    expect(l.available()).toBe(0);
  });

  it("never lets more than the budget through in any 60 s window", async () => {
    const { t, opts } = fakeTime();
    const l = new WeightLimiter(800, opts);
    const spends: Array<[number, number]> = [];
    for (let i = 0; i < 400; i++) {
      const w = [60, 20, 2][i % 3]!;
      await l.take(w);
      spends.push([t.now, w]);
    }
    let worst = 0;
    for (const [start] of spends) {
      const inWindow = spends.filter(([at]) => at >= start && at < start + 60_000).reduce((s, [, w]) => s + w, 0);
      worst = Math.max(worst, inWindow);
    }
    expect(worst).toBeLessThanOrEqual(800);
    expect(worst).toBeGreaterThan(700); // and it still uses the budget
  });

  it("waits for the oldest spend to leave the window", async () => {
    const { t, opts } = fakeTime();
    const l = new WeightLimiter(60, opts);
    await l.take(40);
    t.now += 10_000;
    await l.take(20);
    await l.take(30); // needs the 40 from t=0 gone: wake at t=60 s
    expect(t.now).toBe(60_000);
    expect(l.available()).toBe(10);
  });

  it("frees weight exactly 60 s after it was spent", async () => {
    const { t, opts } = fakeTime();
    const l = new WeightLimiter(800, opts);
    await l.take(800);
    t.now += 59_999;
    expect(l.available()).toBe(0);
    t.now += 1;
    expect(l.available()).toBe(800);
  });

  it("serves waiters first-in, first-out", async () => {
    const { opts } = fakeTime();
    const l = new WeightLimiter(60, opts);
    await l.take(60);
    const order: number[] = [];
    await Promise.all([1, 2, 3].map((i) => l.take(30).then(() => order.push(i))));
    expect(order).toEqual([1, 2, 3]);
  });

  it("rejects weights it could never serve", async () => {
    const l = new WeightLimiter(800);
    await expect(l.take(801)).rejects.toThrow(RangeError);
    await expect(l.take(0)).rejects.toThrow(RangeError);
    expect(() => new WeightLimiter(0)).toThrow(RangeError);
  });
});
