import { once } from "node:events";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { publishScan, reportRecord, REPORT_TTL_MS } from "../src/live/publish.ts";
import { createFeedServer } from "../src/live/server.ts";
import { FeedStore } from "../src/live/store.ts";
import { FeedRecord } from "../src/live/types.ts";

const meta = { network: "testnet" as const, head: "22738575", generatedAt: "2026-11-04T00:23:23.405Z" };
const tokens = ["0x8a2201953AF29e8BE7700bcB53dA3ce5caD18726", "0x97951493E8839D2aFa7730Ef3ba73437615c7705", "0x4DDd716f0627693D12F237E0C42692FE23da0999", "0x0b56C35d8Ca0d323F1F871a7e6Ea1b607C1F0e4C"];
const reports = tokens.map((t) => JSON.parse(readFileSync(new URL(`./fixtures/feed-reports/${t}.json`, import.meta.url), "utf8")));
const stores: FeedStore[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); });
const store = () => { const s = new FeedStore(":memory:"); stores.push(s); return s; };

describe("scanner report publisher", () => {
  it("maps recorded reports, metadata, reasons and unknown data without inventing holder rows", () => {
    const records = reports.map((r) => reportRecord(r, meta));
    expect(records.map((r) => [r.venue, r.verdict])).toEqual([["kalos", "CLEAN"], ["kalos", "WATCH"], ["perpme", "CLEAN"], ["perpme", "NOT_ENOUGH_DATA"]]);
    for (const [i, r] of records.entries()) {
      expect(FeedRecord.parse(r)).toEqual(r);
      expect(r.token).toBe(tokens[i]!.toLowerCase());
      expect(r.checkedAtMs).toBe(Date.parse(meta.generatedAt));
      expect(r.expiresAtMs).toBe(r.checkedAtMs + REPORT_TTL_MS);
      expect(r.block).toBe(meta.head);
      expect(r.chainId).toBe(99801);
      expect(r.holders).toBeNull();
      expect(r.dev).toBeNull();
      expect(r.people).toBeNull();
      expect(r.reportUrl).toBe(`https://pantheonindex.com/delphi/${r.token}`);
      expect(r.checks.find((c) => c.code === "creator-buy")?.result).toBe("not-enough-data");
    }
    expect(records[1]!.checks[0]).toMatchObject({ result: "watch", evidence: reports[1].findings[0].evidence.slice(0, 8).map((e: { tx: string }) => e.tx.toLowerCase()) });
    expect(records[3]!.state).toBe("thin");
  });

  it("maps Ascend on the selected chain, caps hostile text and rejects other networks", () => {
    const r = structuredClone(reports[0]);
    delete r.coin.market;
    r.coin.name = "\u001b" + "N".repeat(100);
    expect(() => reportRecord(r, { ...meta, network: "mainnet" }, "https://example.com")).toThrow(/network does not match/);
    const record = reportRecord(r, meta, "https://example.com");
    expect(record).toMatchObject({ venue: "ascend", chainId: 99801, name: " " + "N".repeat(39) });
    expect(record.disputeUrl).toBe(`https://example.com/delphi/dispute?token=${record.token}`);
  });

  it("publishes once, preserves scan freshness on retries, and only logs actual verdict changes", () => {
    const s = store();
    const scan = { ...meta, reports };
    expect(publishScan(scan, s)).toMatchObject({ published: 4, unchanged: 0, skipped: 0 });
    const before = s.many(tokens);
    expect(publishScan(scan, s)).toMatchObject({ published: 0, unchanged: 4, skipped: 0 });
    expect(s.many(tokens)).toEqual(before);
    const later = structuredClone(reports[0]);
    later.generatedAt = "2026-11-04T12:00:00.000Z";
    expect(publishScan({ ...meta, generatedAt: later.generatedAt, reports: [later] }, s).published).toBe(1);
    expect(s.history(tokens[0]!)).toHaveLength(1);
    later.verdict = "NOT_ENOUGH_DATA";
    later.checks.wash = "not-enough-data";
    publishScan({ ...meta, generatedAt: later.generatedAt, reports: [later] }, s);
    expect(s.history(tokens[0]!).map((h) => h.verdict)).toEqual(["CLEAN", "NOT_ENOUGH_DATA"]);
    expect(s.history(tokens[0]!)[1]!.why).toContain("wash");
    publishScan(scan, s);
    expect(s.get(tokens[0]!)?.verdict).toBe("NOT_ENOUGH_DATA");
    expect(s.history(tokens[0]!)).toHaveLength(2);
  });

  it("handles empty input, skips malformed reports, and fails closed on missing metadata", () => {
    const s = store();
    expect(publishScan({ ...meta, reports: [] }, s)).toEqual({ published: 0, unchanged: 0, skipped: 0, errors: [] });
    const missing = structuredClone(reports[0]);
    delete missing.checks;
    const invalid = structuredClone(reports[0]);
    invalid.coin.market = "unknown";
    const missingStats = structuredClone(reports[0]);
    delete missingStats.stats.trades;
    expect(publishScan({ ...meta, reports: [null, missing, invalid, missingStats, reports[2]] }, s)).toMatchObject({ published: 1, skipped: 4 });
    expect(s.get(tokens[0]!)).toBeNull();
    expect(() => publishScan({ reports }, s)).toThrow();
    expect(() => publishScan({ ...meta, network: "unknown", reports }, s)).toThrow();
    expect(() => publishScan({ ...meta, network: "mainnet", reports }, s)).toThrow(/network does not match/);
    expect(() => reportRecord(reports[0], { ...meta, head: "1" })).toThrow();
    expect(() => reportRecord(reports[0], { ...meta, generatedAt: "2026-11-01T00:00:00.000Z" })).toThrow();
  });

  it("never publishes CLEAN with missing funding or incomplete checks, or contradictory findings", () => {
    const r = structuredClone(reports[0]);
    r.stats.fundingMissing = 1;
    expect(reportRecord(r, meta).verdict).toBe("NOT_ENOUGH_DATA");
    r.stats.fundingMissing = 0;
    r.checks.bundle = "not-enough-data";
    expect(reportRecord(r, meta).verdict).toBe("NOT_ENOUGH_DATA");
    r.checks.bundle = "found";
    expect(() => reportRecord(r, meta)).toThrow();
    const watch = structuredClone(reports[1]);
    watch.verdict = "CLEAN";
    expect(() => reportRecord(watch, meta)).toThrow();
    const flag = structuredClone(reports[1]);
    flag.verdict = "FLAG";
    flag.findings[0].severity = "flag";
    expect(reportRecord(flag, meta).checks[0]?.result).toBe("flag");
  });

  it("serves recorded report fixtures through tokens and both venue feeds", async () => {
    const s = store();
    publishScan({ ...meta, reports }, s);
    const server = createFeedServer({ store: s, now: () => Date.parse(meta.generatedAt) + 1000 });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const all = await fetch(`${base}/v1/tokens?ids=${tokens.join(",")}`);
      expect(all.status).toBe(200);
      const body = z.object({ missing: z.array(z.string()), items: z.array(z.object({ record: FeedRecord })) }).parse(await all.json());
      expect(body.missing).toEqual([]);
      expect(body.items.map((i: { record: FeedRecord }) => i.record)).toEqual(tokens.map((t) => s.get(t)));
      for (const venue of ["kalos", "perpme"] as const) {
        const response = await fetch(`${base}/v1/new?venue=${venue}`);
        expect(response.status).toBe(200);
        const page = z.object({ items: z.array(z.object({ record: FeedRecord, stale: z.boolean() })) }).parse(await response.json());
        expect(page.items.map((i: { record: FeedRecord }) => i.record)).toEqual(s.recent({ venue }));
        expect(page.items).toHaveLength(2);
        expect(page.items.every((i: { stale: boolean }) => !i.stale)).toBe(true);
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
  });
});
