import { describe, expect, it } from "vitest";
import { buildApp, PER_MINUTE } from "../src/api.ts";
import { ctx, liveRecords } from "./fixtures.ts";

const ready = () => ctx(liveRecords());

describe("the API", () => {
  it("answers 503 until the first read of the chain is done, once per request", async () => {
    const warnings: string[] = [];
    const app = buildApp(() => null);
    app.log.warn = ((o: unknown, msg?: string) => void warnings.push(String(msg ?? o))) as typeof app.log.warn;
    expect((await app.inject("/health")).statusCode).toBe(503);
    for (const path of ["/stats", "/basket", "/receipts"]) {
      const res = await app.inject(path);
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: "NOT_READY", detail: "first read of the chain still running" });
    }
    expect(warnings).toEqual([]); // no "Reply was already sent"
  });

  it("serves stats, basket and receipts, cacheable for 15 s", async () => {
    const app = buildApp(ready);
    const s = await app.inject("/stats");
    expect(s.statusCode).toBe(200);
    expect(s.headers["cache-control"]).toBe("public, max-age=15");
    expect(s.json().pnth.burns).toBe(1);
    expect((await app.inject("/basket")).json()).toMatchObject({ active: null, proposals: [] });
    const r = (await app.inject("/receipts?kind=burn,to-basket&limit=5")).json();
    expect(r.items.map((x: { kind: string }) => x.kind)).toEqual(["to-basket", "burn"]);
    expect((await app.inject("/health")).json()).toEqual({ ok: true, block: "9176314", events: 7 });
  });

  it("refuses bad queries with a reason, and unknown paths", async () => {
    const app = buildApp(ready);
    for (const q of ["kind=hack", "limit=0", "limit=201", "account=0x12", "before=abc", "token=not-an-address"]) {
      const res = await app.inject(`/receipts?${q}`);
      expect(res.statusCode, q).toBe(400);
      expect(res.json().error).toBe("BAD_REQUEST");
    }
    expect((await app.inject("/admin")).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/stats" })).statusCode).toBe(404);
  });

  it("limits each visitor per minute, then lets them back in", async () => {
    let t = 0;
    const app = buildApp(ready, { now: () => t });
    for (let i = 0; i < PER_MINUTE; i++) expect((await app.inject({ url: "/health", remoteAddress: "9.9.9.9" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/health", remoteAddress: "9.9.9.9" })).json()).toEqual({ error: "RATE_LIMITED" });
    expect((await app.inject({ url: "/health", remoteAddress: "8.8.8.8" })).statusCode).toBe(200); // someone else
    t = 60_000;
    expect((await app.inject({ url: "/health", remoteAddress: "9.9.9.9" })).statusCode).toBe(200);
  });

  it("counts a visitor by the address the site forwards, but only from the site itself", async () => {
    const app = buildApp(ready);
    for (let i = 0; i < PER_MINUTE; i++) await app.inject({ url: "/health", remoteAddress: "127.0.0.1", headers: { "x-forwarded-for": "1.2.3.4" } });
    expect((await app.inject({ url: "/health", remoteAddress: "127.0.0.1", headers: { "x-forwarded-for": "1.2.3.4" } })).statusCode).toBe(429);
    expect((await app.inject({ url: "/health", remoteAddress: "127.0.0.1", headers: { "x-forwarded-for": "5.6.7.8" } })).statusCode).toBe(200);
    // From anywhere else the header is ignored, so it can't be used to dodge the limit.
    for (let i = 0; i < PER_MINUTE; i++) await app.inject({ url: "/health", remoteAddress: "7.7.7.7", headers: { "x-forwarded-for": `10.0.0.${i}` } });
    expect((await app.inject({ url: "/health", remoteAddress: "7.7.7.7", headers: { "x-forwarded-for": "10.9.9.9" } })).statusCode).toBe(429);
  });
});

describe("load", () => {
  // 20,000 events (years of testnet activity), 200 requests: answers come from memory, not rebuilt each time.
  it("serves a large history quickly", async () => {
    const { ctx: makeCtx } = await import("./fixtures.ts");
    const records = Array.from({ length: 20_000 }, (_, i) => ({
      tx: `0x${i.toString(16).padStart(64, "0")}`, block: 9_200_000 + i, logIndex: 0, at: 1_792_100_000 + i,
      ...(i % 3 === 0 ? { kind: "burn", runId: "1", amount: "1000" } : i % 3 === 1 ? { kind: "to-basket", runId: "1", amount: "7" } : { kind: "stake", account: "0x00000000000000000000000000000000000000a1", amount: "1" }),
    })) as never;
    const c = makeCtx(records);
    const app = buildApp(() => c);
    const t0 = performance.now();
    for (let i = 0; i < 100; i++) {
      expect((await app.inject({ url: "/stats", remoteAddress: `10.0.${i}.1` })).statusCode).toBe(200);
      expect((await app.inject({ url: "/receipts?kind=burn&limit=200", remoteAddress: `10.1.${i}.1` })).statusCode).toBe(200);
    }
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(3_000);
    expect((await app.inject("/stats")).json().pnth.burns).toBe(6_667);
  });
});
