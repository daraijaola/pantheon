// The bag, on DELPHI's recorded verdicts and a stand-in for the wallet's holdings: no network.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/api.ts";
import { BagReader, buildBag } from "../src/bag.ts";
import type { Footprint, TokenRow } from "../src/footprint.ts";
import { FreshChecks } from "../src/fresh.ts";
import type { Holding, Holdings } from "../src/holdings.ts";
import { Verdicts } from "../src/verdicts.ts";

const FIXTURE = new URL("./fixtures/scan.json", import.meta.url).pathname;
const SCANNED = Date.parse(JSON.parse(readFileSync(FIXTURE, "utf8")).generatedAt);
const WALLET = "0x79a320a02db0c1cbe7a5f2cd47210ea6f3b9f23a";
const FLAG = "0x8444bf31e9648c97e3736560171dec3180d77645";
const WATCH = "0x34cc866cc3a2afd5967334cb36d8e6629a6e5174";
const CLEAN = "0x4faa6142168c6a1126df68cf400839126b3664db";
const TOO_NEW = "0xf1bff5dbc3fa6b0185c3295b2cb1c8de8be654ce";
const KALOS = "0x8a2201953af29e8be7700bcb53da3ce5cad18726";
const NEVER_READ = "0x1111111111111111111111111111111111111111";

const ME = WALLET;
const row = (token: string, over: Partial<TokenRow> = {}): TokenRow => ({
  token,
  symbol: "NEW",
  name: "A new token",
  decimals: 18,
  balance: { raw: "5", amount: "0.000000000000000005" },
  holdsNow: true,
  firstSeen: { block: "1", time: null, tx: "0xa" },
  lastSeen: { block: "1", time: null, tx: "0xa" },
  received: { count: 1, raw: "5" },
  sent: { count: 0, raw: "0" },
  fromOthers: { count: 0, raw: "0" },
  sentIn: false,
  verdict: "UNKNOWN",
  ...over,
});
const footprint = (tokens: TokenRow[], over: Partial<Footprint> = {}) => ({ wallet: ME, tokens, unread: [], complete: true, ...over }) as Footprint;

const holding = (token: string): Holding => ({ token, symbol: "X", name: null, venue: "ascend", balance: "1", decimals: 18, amount: "0.000000000000000001" });
const holdings = (tokens: string[], unread: string[] = []): Holdings => ({ wallet: WALLET, network: "testnet", readAt: "2026-11-01T00:00:00.000Z", coinsChecked: 7, holdings: tokens.map(holding), unread });
function verdicts(now = SCANNED) {
  const v = new Verdicts(FIXTURE, { now: () => now });
  v.refresh();
  return v;
}
const bag = (tokens: string[], unread: string[] = []) => {
  const v = verdicts();
  return buildBag(holdings(tokens, unread), (t) => v.get(t));
};

describe("the bag", () => {
  it("gives each coin its verdict, its reason and its amount, marked testnet", () => {
    const b = bag([FLAG]);
    expect(b).toMatchObject({ wallet: WALLET, network: "testnet", complete: true, unread: [] });
    expect(b.coins[0]).toMatchObject({ token: FLAG, amount: "0.000000000000000001", verdict: "FLAG" });
    expect(b.coins[0]!.reason).toBe(b.coins[0]!.findings[0]!.text);
  });

  it("links every claim to its transactions, and every read coin to its report and dispute page", () => {
    for (const c of bag([FLAG, WATCH, CLEAN, TOO_NEW, KALOS]).coins) {
      expect(c.disputeUrl).toBe(`https://pantheonindex.com/delphi/dispute?token=${c.token}`);
      expect(c.reportUrl).toBe(`https://pantheonindex.com/delphi/${c.token}`);
      for (const f of c.findings) expect(f.evidence.length).toBeGreaterThan(0);
    }
  });

  it("puts the worst first, whatever order the wallet holds them in", () => {
    const order = bag([CLEAN, TOO_NEW, NEVER_READ, WATCH, FLAG]).coins.map((c) => c.verdict);
    expect(order).toEqual(["FLAG", "WATCH", "UNKNOWN", "NOT_ENOUGH_DATA", "CLEAN"]);
  });

  it("counts every verdict, and never counts an unread or too-new coin as clean", () => {
    const b = bag([CLEAN, KALOS, TOO_NEW, NEVER_READ, FLAG]);
    expect(b.counts).toEqual({ FLAG: 1, WATCH: 0, UNKNOWN: 1, NOT_ENOUGH_DATA: 1, CLEAN: 2 });
  });

  it("shows a coin DELPHI hasn't read as unknown, with nothing made up", () => {
    expect(bag([NEVER_READ]).coins[0]).toMatchObject({ verdict: "UNKNOWN", findings: [], notes: [], reportUrl: null, disputeUrl: null, scannedAt: null });
  });

  it("gives an empty bag only when every coin was read", () => {
    const b = bag([]);
    expect(b).toMatchObject({ coins: [], complete: true });
    expect(b.counts).toEqual({ FLAG: 0, WATCH: 0, UNKNOWN: 0, NOT_ENOUGH_DATA: 0, CLEAN: 0 });
  });

  it("says it's incomplete when a coin couldn't be read", () => {
    expect(bag([CLEAN], [FLAG])).toMatchObject({ complete: false, unread: [FLAG] });
  });

  it("carries a stale verdict's warning", () => {
    const v = verdicts(SCANNED + 15 * 3_600_000);
    expect(buildBag(holdings([CLEAN]), (t) => v.get(t)).coins[0]!.stale).toBe(true);
  });
});

describe("fresh reads", () => {
  const OLD = SCANNED + 31 * 60_000;

  it("starts one when a coin's verdict is old, and says so", async () => {
    const v = verdicts(OLD);
    let reads = 0;
    const fresh = new FreshChecks(v, () => (reads++, new Promise(() => {})), { now: () => OLD });
    const b = await new BagReader({ read: async () => holdings([CLEAN, WATCH]) }, v, fresh).read(WALLET);
    expect(b.checking).toBe(true);
    expect(reads).toBe(1);
  });

  it("says nothing is coming for Kalos coins, or when the verdicts are recent", async () => {
    const old = verdicts(OLD);
    const f1 = new FreshChecks(old, () => new Promise(() => {}), { now: () => OLD });
    expect((await new BagReader({ read: async () => holdings([KALOS]) }, old, f1).read(WALLET)).checking).toBe(false);
    const recent = verdicts();
    const f2 = new FreshChecks(recent, () => new Promise(() => {}), { now: () => SCANNED });
    expect((await new BagReader({ read: async () => holdings([CLEAN]) }, recent, f2).read(WALLET)).checking).toBe(false);
  });

  it("uses the latest verdict even while the holdings are remembered", async () => {
    const v = verdicts();
    const r = new BagReader({ read: async () => holdings([CLEAN]) }, v);
    expect((await r.read(WALLET)).coins[0]!.verdict).toBe("CLEAN");
    const scan = JSON.parse(readFileSync(FIXTURE, "utf8"));
    scan.generatedAt = new Date(SCANNED + 1000).toISOString();
    scan.reports.find((x: { coin: { token: string } }) => x.coin.token.toLowerCase() === CLEAN).verdict = "FLAG";
    v.applyFresh(JSON.stringify(scan));
    expect((await r.read(WALLET)).coins[0]!.verdict).toBe("FLAG");
  });
});

describe("asking the server", () => {
  const app = (read: (w: string) => Promise<Holdings>) => buildApp(verdicts(), { bag: new BagReader({ read }, verdicts()) });

  it("answers with the wallet's bag", async () => {
    const res = await app(async () => holdings([CLEAN, FLAG])).inject({ url: `/wallets/${WALLET}/bag` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json().coins.map((c: { verdict: string }) => c.verdict)).toEqual(["FLAG", "CLEAN"]);
  });

  it("refuses a bad address, and answers 503 when the chain fails, never an empty bag", async () => {
    const down = app(() => Promise.reject(new Error("node detail")));
    expect((await down.inject({ url: "/wallets/nope/bag" })).statusCode).toBe(400);
    const res = await down.inject({ url: `/wallets/${WALLET}/bag` });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "CHAIN_UNAVAILABLE" });
  });
});

describe("the whole wallet", () => {
  const v = verdicts();
  const get = (t: string) => v.get(t);

  it("adds tokens DELPHI never read as not read, never as clean", () => {
    const bag = buildBag(holdings([CLEAN]), get, undefined, footprint([row(CLEAN), row(NEVER_READ)]));
    expect(bag.coins.map((c) => c.token)).toEqual([NEVER_READ, CLEAN]);
    expect(bag.coins[0]).toMatchObject({ verdict: "UNKNOWN", venue: null, symbol: "NEW", amount: "0.000000000000000005", reportUrl: null });
    expect(bag.counts).toMatchObject({ UNKNOWN: 1, CLEAN: 1 });
    expect(bag.wholeWallet).toBe(true);
  });

  it("doesn't list a coin twice", () => {
    expect(buildBag(holdings([CLEAN]), get, undefined, footprint([row(CLEAN)])).coins).toHaveLength(1);
  });

  it("leaves out tokens it no longer holds", () => {
    expect(buildBag(holdings([]), get, undefined, footprint([row(NEVER_READ, { holdsNow: false })])).coins).toEqual([]);
  });

  it("moves a coin sent in out of the bag and its counts, even a flagged one", () => {
    const bag = buildBag(holdings([FLAG, CLEAN]), get, undefined, footprint([row(FLAG, { sentIn: true }), row(CLEAN)]));
    expect(bag.coins.map((c) => c.token)).toEqual([CLEAN]);
    expect(bag.counts.FLAG).toBe(0);
    expect(bag.sentIn).toEqual([expect.objectContaining({ token: FLAG, verdict: "FLAG", amount: "0.000000000000000005", arrived: expect.objectContaining({ tx: "0xa" }) })]);
  });

  it("lists a coin sent in that DELPHI never read apart too, and doesn't add it", () => {
    const bag = buildBag(holdings([]), get, undefined, footprint([row(NEVER_READ, { sentIn: true })]));
    expect(bag.coins).toEqual([]);
    expect(bag.counts.UNKNOWN).toBe(0);
    expect(bag.sentIn).toHaveLength(1);
  });

  it("doesn't list a coin sent in that's already gone", () => {
    expect(buildBag(holdings([]), get, undefined, footprint([row(NEVER_READ, { sentIn: true, holdsNow: false })])).sentIn).toEqual([]);
  });

  it("keeps a coin it can't tell about in the bag, because it might be its own", () => {
    const bag = buildBag(holdings([CLEAN]), get, undefined, footprint([row(CLEAN, { sentIn: null })], { complete: false }));
    expect(bag.coins).toHaveLength(1);
    expect(bag.complete).toBe(false);
  });

  it("calls a token it can't size unread, not missing", () => {
    const bag = buildBag(holdings([]), get, undefined, footprint([row(NEVER_READ, { decimals: null, balance: { raw: "5", amount: null } })]));
    expect(bag.coins).toEqual([]);
    expect(bag.unread).toEqual([NEVER_READ]);
    expect(bag.complete).toBe(false);
  });

  it("joins what either read couldn't read, once each", () => {
    const bag = buildBag(holdings([], [WATCH]), get, undefined, footprint([], { unread: [WATCH, TOO_NEW] }));
    expect(bag.unread.sort()).toEqual([WATCH, TOO_NEW].sort());
  });

  it("doesn't ask for a fresh read on a token DELPHI will never read, like USDC", () => {
    const asked: string[] = [];
    const ask = (c: { token: string }) => (asked.push(c.token), true);
    const bag = buildBag(holdings([]), get, ask, footprint([row(NEVER_READ)]));
    expect(asked).toEqual([]);
    expect(bag.checking).toBe(false);
  });

  it("still asks about DELPHI's own coins", () => {
    const asked: string[] = [];
    const ask = (c: { token: string }) => (asked.push(c.token), true);
    const bag = buildBag(holdings([CLEAN]), get, ask, footprint([row(CLEAN), row(NEVER_READ)]));
    expect(asked).toEqual([CLEAN]);
    expect(bag.checking).toBe(true);
  });

  it("says when it's only DELPHI's coins", () => {
    expect(buildBag(holdings([CLEAN]), get)).toMatchObject({ wholeWallet: false, sentIn: [] });
  });

  it("the reader joins them, and a footprint that fails costs only the extra, out loud", async () => {
    const reading = { read: async () => holdings([CLEAN]) };
    expect(await new BagReader(reading, v, undefined, { read: async () => footprint([row(CLEAN), row(NEVER_READ)]) }).read(WALLET)).toMatchObject({ wholeWallet: true, counts: { UNKNOWN: 1 } });
    const logs: string[] = [];
    const bag = await new BagReader(reading, v, undefined, { read: () => Promise.reject(new Error("down\nstack")) }, (m) => logs.push(m)).read(WALLET);
    expect(bag).toMatchObject({ wholeWallet: false, counts: { CLEAN: 1 } });
    expect(logs).toEqual(["can't read the wallet's footprint: down"]);
  });
});
