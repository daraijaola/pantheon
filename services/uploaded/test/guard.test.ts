// Guard, with made-up verdicts and sales: no network.
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/api.ts";
import { FreshChecks } from "../src/fresh.ts";
import { Guard, GuardReader, type Sale, type Seen } from "../src/guard.ts";
import type { Holdings } from "../src/holdings.ts";
import { Verdicts } from "../src/verdicts.ts";

const FIXTURE = new URL("./fixtures/scan.json", import.meta.url).pathname;
const WALLET = "0x79a320a02db0c1cbe7a5f2cd47210ea6f3b9f23a";
const COIN = "0x" + "a".repeat(40);
const OTHER = "0x" + "b".repeat(40);
const T0 = Date.parse("2026-11-01T12:00:00.000Z");
const T0S = T0 / 1000;
const DAY = 86_400;

const seen = (verdict: string, over: Partial<Seen> = {}): Seen => ({
  token: COIN,
  symbol: "AAA",
  venue: "ascend",
  verdict,
  rules: "delphi-v0.5",
  reason: `now ${verdict}`,
  evidence: [{ what: "a trade", tx: "0x1", url: "https://x/tx/0x1" }],
  reportUrl: "https://r",
  disputeUrl: "https://d",
  ...over,
});
const sale = (ppm: number, over: Partial<Sale> = {}): Sale => ({ token: COIN, wallet: WALLET, ppm, tx: "0x2", url: "https://x/tx/0x2", time: T0S - 3_600, ...over });

let dir: string;
let file: string;
let t: number;
const guard = () => new Guard(file, { now: () => t });
const all = (g: Guard) => g.for(new Set([COIN, OTHER]), 0);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "guard-"));
  file = join(dir, "sub", "guard.json");
  t = T0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("verdict drops", () => {
  it("alerts when a coin goes from CLEAN to WATCH or FLAG, with the reason and the transactions", () => {
    for (const to of ["WATCH", "FLAG"]) {
      const g = new Guard(join(dir, to), { now: () => t });
      g.observe([seen("CLEAN")]);
      expect(g.observe([seen(to)])).toBe(1);
      expect(all(g)[0]).toMatchObject({ kind: "verdict-drop", token: COIN, from: "CLEAN", to, reason: `now ${to}`, evidence: [{ tx: "0x1" }], reportUrl: "https://r", disputeUrl: "https://d" });
    }
  });

  it("stays silent on every other change", () => {
    const steps = [
      ["NOT_ENOUGH_DATA", "CLEAN"],
      ["NOT_ENOUGH_DATA", "FLAG"],
      ["WATCH", "FLAG"],
      ["FLAG", "CLEAN"],
      ["WATCH", "CLEAN"],
      ["CLEAN", "NOT_ENOUGH_DATA"],
      ["CLEAN", "CLEAN"],
    ];
    for (const [a, b] of steps) {
      const g = new Guard(join(dir, `${a}-${b}`), { now: () => t });
      g.observe([seen(a!)]);
      expect(g.observe([seen(b!)]), `${a} to ${b}`).toBe(0);
    }
  });

  it("alerts no one the first time it sees a coin", () => {
    const g = guard();
    expect(g.observe([seen("FLAG")])).toBe(0);
    expect(all(g)).toEqual([]);
  });

  it("doesn't treat a rules change as news about the coin", () => {
    const logs: string[] = [];
    const g = new Guard(file, { now: () => t, log: (m) => logs.push(m) });
    g.observe([seen("CLEAN", { rules: "delphi-v0.5" })]);
    expect(g.observe([seen("FLAG", { rules: "delphi-v0.6" })])).toBe(0);
    expect(logs[0]).toContain("rules change");
    // but the new rules are the new starting point
    g.observe([seen("CLEAN", { rules: "delphi-v0.6" })]);
    expect(g.observe([seen("WATCH", { rules: "delphi-v0.6" })])).toBe(1);
  });

  it("alerts once per drop, not on every read", () => {
    const g = guard();
    g.observe([seen("CLEAN")]);
    g.observe([seen("FLAG")]);
    expect(g.observe([seen("FLAG")])).toBe(0);
    expect(all(g)).toHaveLength(1);
  });

  it("alerts again if a coin recovers and drops again", () => {
    const g = guard();
    g.observe([seen("CLEAN")]);
    g.observe([seen("FLAG")]);
    t += 1000;
    g.observe([seen("CLEAN")]);
    t += 1000;
    expect(g.observe([seen("WATCH")])).toBe(1);
    expect(all(g)).toHaveLength(2);
  });

  it("keeps at most 5 transactions on an alert", () => {
    const g = guard();
    g.observe([seen("CLEAN")]);
    g.observe([seen("FLAG", { evidence: Array.from({ length: 9 }, (_, i) => ({ what: "x", tx: `0x${i}`, url: "u" })) })]);
    expect(all(g)[0]!.evidence).toHaveLength(5);
  });
});

describe("creator sales", () => {
  const coinOf = (token: string) => (token === COIN ? seen("CLEAN") : null);

  it("alerts on 1% of the supply in a day, added up across wallets", () => {
    const g = guard();
    expect(g.observeSales([sale(6_000, { wallet: "0x1111111111aa" }), sale(4_000, { wallet: "0x2222222222bb", tx: "0x3" })], coinOf)).toBe(1);
    const a = all(g)[0]!;
    expect(a).toMatchObject({ kind: "creator-sold", token: COIN, soldPct: 1, reason: "The creator's group sold 1% of the supply across 2 wallets." });
    expect(a.evidence.map((e) => e.tx)).toEqual(["0x2", "0x3"]);
  });

  it("stays silent on less", () => {
    const g = guard();
    expect(g.observeSales([sale(9_999)], coinOf)).toBe(0);
    expect(all(g)).toEqual([]);
  });

  it("doesn't add up different days or different coins", () => {
    const g = guard();
    const yesterday = T0S - DAY;
    expect(g.observeSales([sale(6_000), sale(6_000, { time: yesterday }), sale(6_000, { token: OTHER })], (x) => (x === COIN || x === OTHER ? seen("CLEAN", { token: x }) : null))).toBe(0);
  });

  it("stays silent about old sales, so its first read doesn't report last month", () => {
    const g = guard();
    expect(g.observeSales([sale(500_000, { time: T0S - 2 * DAY - 1 })], coinOf)).toBe(0);
    expect(g.observeSales([sale(500_000, { time: T0S - 2 * DAY + 1 })], coinOf)).toBe(1);
  });

  it("keeps one alert for a day, and grows it if more is sold", () => {
    const g = guard();
    expect(g.observeSales([sale(20_000)], coinOf)).toBe(1);
    expect(g.observeSales([sale(20_000)], coinOf)).toBe(0); // the same sale, read again
    expect(g.observeSales([sale(20_000), sale(30_000, { tx: "0x9" })], coinOf)).toBe(0);
    expect(all(g)).toHaveLength(1);
    expect(all(g)[0]).toMatchObject({ soldPct: 5, evidence: [{ tx: "0x9" }, { tx: "0x2" }] });
  });

  it("ignores a coin it doesn't know", () => {
    expect(guard().observeSales([sale(50_000, { token: OTHER })], coinOf)).toBe(0);
  });
});

describe("remembering", () => {
  it("survives a restart: a drop across it still alerts, and old alerts stay", () => {
    const g = guard();
    g.observe([seen("CLEAN")]);
    const again = guard();
    expect(again.since).toBe(g.since);
    expect(again.observe([seen("FLAG")])).toBe(1);
    expect(all(guard())).toHaveLength(1);
  });

  it("starts over on a broken file, keeps it aside, and says so", () => {
    guard().observe([seen("CLEAN")]);
    writeFileSync(file, "{half a fi");
    const logs: string[] = [];
    const g = new Guard(file, { now: () => t, log: (m) => logs.push(m) });
    expect(logs[0]).toContain("starting over");
    expect(existsSync(`${file}.bad`)).toBe(true);
    expect(g.observe([seen("FLAG")])).toBe(0); // no history, so no alert
  });

  it("forgets alerts after 30 days", () => {
    const g = guard();
    g.observe([seen("CLEAN")]);
    g.observe([seen("FLAG")]);
    t += 31 * DAY * 1000;
    g.observe([seen("CLEAN", { token: OTHER })]);
    expect(all(g)).toEqual([]);
  });

  it("leaves its file alone when nothing changed", () => {
    const g = guard();
    const coinOf = () => seen("CLEAN");
    g.observe([seen("CLEAN")]);
    g.observeSales([sale(20_000)], coinOf);
    const old = new Date(1_000_000_000_000);
    utimesSync(file, old, old);
    g.observe([seen("CLEAN")]);
    g.observeSales([sale(20_000)], coinOf);
    expect(statSync(file).mtimeMs).toBe(old.getTime());
  });

  it("writes the file whole, never leaving a half-written one behind", () => {
    guard().observe([seen("CLEAN")]);
    expect(() => JSON.parse(readFileSync(file, "utf8"))).not.toThrow();
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });
});

describe("a wallet's list", () => {
  const holdings = (tokens: string[], unread: string[] = []): Holdings => ({
    wallet: WALLET,
    network: "testnet",
    readAt: "2026-11-01T12:00:00.000Z",
    coinsChecked: 7,
    holdings: tokens.map((token) => ({ token, symbol: "AAA", name: null, venue: "ascend", balance: "1", decimals: 18, amount: "1" })),
    unread,
  });
  const reader = (g: Guard, h: Holdings) => new GuardReader(g, { read: async () => h }, { now: () => t });
  const dropped = () => {
    const g = guard();
    g.observe([seen("CLEAN"), seen("CLEAN", { token: OTHER })]);
    g.observe([seen("FLAG"), seen("FLAG", { token: OTHER })]);
    return g;
  };

  it("shows only coins the wallet holds", async () => {
    const got = await reader(dropped(), holdings([COIN])).read(WALLET);
    expect(got.alerts.map((a) => a.token)).toEqual([COIN]);
    expect(got).toMatchObject({ wallet: WALLET, network: "testnet", coinsWatched: 1, salesSeenOn: ["ascend"], complete: true });
  });

  it("is empty when nothing happened: that's the normal answer", async () => {
    const g = guard();
    g.observe([seen("CLEAN")]);
    expect((await reader(g, holdings([COIN])).read(WALLET)).alerts).toEqual([]);
  });

  it("says when it started watching, since it can't speak for anything earlier", async () => {
    expect((await reader(guard(), holdings([])).read(WALLET)).watchingSince).toBe(new Date(T0).toISOString());
  });

  it("goes back a week unless asked otherwise", async () => {
    const g = dropped();
    t += 8 * DAY * 1000;
    const r = reader(g, holdings([COIN]));
    expect((await r.read(WALLET)).alerts).toEqual([]);
    expect((await r.read(WALLET, 0)).alerts).toHaveLength(1);
  });

  it("puts the newest first", async () => {
    const g = dropped();
    t += 5_000;
    g.observeSales([sale(20_000, { time: T0S })], () => seen("FLAG"));
    expect((await reader(g, holdings([COIN])).read(WALLET)).alerts.map((a) => a.kind)).toEqual(["creator-sold", "verdict-drop"]);
  });

  it("says it's incomplete when a coin couldn't be read", async () => {
    expect(await reader(guard(), holdings([], [COIN])).read(WALLET)).toMatchObject({ complete: false, unread: [COIN] });
  });
});

describe("following DELPHI", () => {
  const PACT = "0x4faa6142168c6a1126df68cf400839126b3664db";
  const scan = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const SCANNED = Date.parse(scan.generatedAt);

  it("sees every coin with its rules, and a fresh read's verdicts and sales", () => {
    const v = new Verdicts(FIXTURE);
    v.refresh();
    expect(v.seen()).toHaveLength(7);
    expect(v.seenOne(PACT)).toMatchObject({ verdict: "CLEAN", rules: "delphi-v0.5", venue: "ascend" });
    expect(v.seenOne(COIN)).toBeNull();
    expect(v.sales()).toEqual([]);
    const later = structuredClone(scan);
    later.generatedAt = new Date(SCANNED + 1000).toISOString();
    later.reports.find((r: { coin: { token: string } }) => r.coin.token.toLowerCase() === PACT).verdict = "FLAG";
    later.creatorSells = [sale(20_000, { token: PACT })];
    v.applyFresh(JSON.stringify(later));
    expect(v.seenOne(PACT)!.verdict).toBe("FLAG");
    expect(v.sales()).toHaveLength(1);
  });

  it("tells Guard when a fresh read lands, and reads on its own on a schedule", async () => {
    let now = SCANNED;
    const v = new Verdicts(FIXTURE, { now: () => now });
    v.refresh();
    let told = 0;
    let reads = 0;
    const later = JSON.stringify({ ...scan, generatedAt: new Date(SCANNED + 1000).toISOString() });
    const f = new FreshChecks(v, async () => (reads++, later), { now: () => now, gapMs: 300_000, onLoaded: () => told++ });
    f.tick();
    await new Promise((r) => setImmediate(r));
    expect(reads).toBe(1);
    expect(told).toBe(1);
    f.tick(); // inside the gap
    expect(reads).toBe(1);
    now += 300_000;
    f.tick();
    expect(reads).toBe(2);
    await new Promise((r) => setImmediate(r));
    f.stop();
    now += 300_000;
    f.tick();
    expect(reads).toBe(2);
  });
});

describe("asking the server", () => {
  const verdicts = new Verdicts(FIXTURE);
  const h: Holdings = { wallet: WALLET, network: "testnet", readAt: "x", coinsChecked: 1, holdings: [], unread: [] };

  it("answers with the list, and takes a date", async () => {
    const seenSince: unknown[] = [];
    const app = buildApp(verdicts, { guard: { read: async (_w: string, s?: number) => (seenSince.push(s), { alerts: [] }) as never } });
    expect((await app.inject({ url: `/wallets/${WALLET}/guard` })).statusCode).toBe(200);
    expect((await app.inject({ url: `/wallets/${WALLET}/guard?since=2026-11-01T00:00:00.000Z` })).statusCode).toBe(200);
    expect(seenSince).toEqual([undefined, Date.parse("2026-11-01T00:00:00.000Z")]);
  });

  it("refuses a bad address or date", async () => {
    const app = buildApp(verdicts, { guard: new GuardReader(guard(), { read: async () => h }) });
    expect((await app.inject({ url: "/wallets/nope/guard" })).json()).toEqual({ error: "INVALID_ADDRESS" });
    expect((await app.inject({ url: `/wallets/${WALLET}/guard?since=yesterday` })).json()).toEqual({ error: "INVALID_SINCE" });
  });

  it("answers 503 when the holdings can't be read, never an empty list", async () => {
    const app = buildApp(verdicts, { guard: new GuardReader(guard(), { read: () => Promise.reject(new Error("rpc detail")) }) });
    const res = await app.inject({ url: `/wallets/${WALLET}/guard` });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "CHAIN_UNAVAILABLE" });
  });
});
