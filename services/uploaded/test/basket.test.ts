// Basket data and a wallet's rewards, with stand-ins for the indexer and the chain: no network.
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/api.ts";
import { BasketReader, chainRewards, indexerCalls, type IndexerCalls, type RewardCalls } from "../src/basket.ts";
import { Verdicts } from "../src/verdicts.ts";

const FIXTURE = new URL("./fixtures/scan.json", import.meta.url).pathname;
const WALLET = "0x79a320a02db0c1cbe7a5f2cd47210ea6f3b9f23a";
const PACT = "0x4FAA6142168c6A1126df68CF400839126b3664db";
const FLAG = "0x8444bf31e9648C97e3736560171dEC3180D77645";
const USDC = "0x4b4fb5C5794F0c821464956374cC5872D5F0f140";
const lc = (a: string) => a.toLowerCase();
const E = 10n ** 18n;

const amt = (raw: bigint, token: string, symbol = "PACT", decimals = 18) => ({ raw: raw.toString(), value: String(Number(raw) / 10 ** decimals), symbol, token });
const claim = (token: string, raw: bigint, symbol = "PACT") => ({ tx: `0x${"1".repeat(64)}`, url: "https://x/tx", at: 1_800_000_000, amount: amt(raw, token, symbol) });
const verdicts = () => {
  const v = new Verdicts(FIXTURE);
  v.refresh();
  return v;
};
const stake = { read: async () => ({ passportBoost: 1.2 }) as never };

function indexer(over: Partial<IndexerCalls> = {}): IndexerCalls {
  return {
    basket: async () => ({
      updatedAt: 1_800_000_000,
      active: {
        id: 3,
        coins: [
          { token: PACT, symbol: "PACT", weightPct: 20, spent: amt(5_000_000n, USDC, "USDC", 6), bought: amt(7n * E, PACT), buys: 2, lastBuy: { tx: "0xa", url: "https://x/a", at: 1_800_000_000 } },
          { token: FLAG, symbol: "SNPTEST", weightPct: 10, spent: amt(0n, USDC, "USDC", 6), bought: amt(0n, FLAG), buys: 0, lastBuy: null },
        ],
      },
    }),
    buys: async () => [{ tx: "0xb", url: "https://x/b", at: 1_800_000_000, coin: amt(3n * E, PACT), usdcIn: amt(100_000_000n, USDC, "USDC", 6) }],
    claims: async () => ({ claims: [claim(PACT, 2n * E), claim(PACT, 3n * E)], whole: true }),
    stakes: async () => ({ times: [], whole: true }),
    ...over,
  };
}
function rewards(earned: Record<string, bigint | null> = { [lc(PACT)]: 4n * E }, over: Partial<RewardCalls> = {}): RewardCalls {
  return {
    tokens: async () => [lc(PACT), lc(USDC), lc(FLAG)],
    earned: async (_w, tokens) => tokens.map((t) => (t in earned ? earned[t]! : 0n)),
    meta: async (tokens) => tokens.map((t) => (t === lc(USDC) ? { symbol: "USDC", decimals: 6 } : { symbol: "PACT", decimals: 18 })),
    ...over,
  };
}
const reader = (i = indexer(), r = rewards(), extra: { now?: () => number } = {}) => new BasketReader({ verdicts: verdicts(), stake, indexer: i, rewards: r, usdc: USDC, ...extra });

describe("a wallet's rewards", () => {
  it("adds up claimable, claimed and earned, each in the coin's own decimals", async () => {
    const got = await reader().read(WALLET);
    expect(got).toMatchObject({ wallet: WALLET, network: "testnet", passportBoost: 1.2, unread: [], complete: true });
    expect(got.coins).toEqual([{ token: lc(PACT), symbol: "PACT", claimable: { raw: (4n * E).toString(), amount: "4" }, claimed: { raw: (5n * E).toString(), amount: "5" }, earned: { raw: (9n * E).toString(), amount: "9" }, verdict: "CLEAN" }]);
  });

  it("leaves out coins never earned, and sends an empty list only when everything was read", async () => {
    const got = await reader(indexer({ claims: async () => ({ claims: [], whole: true }) }), rewards({})).read(WALLET);
    expect(got).toMatchObject({ coins: [], unread: [], complete: true });
  });

  it("has no verdict for USDC, which isn't a coin DELPHI judges", async () => {
    const got = await reader(indexer({ claims: async () => ({ claims: [], whole: true }) }), rewards({ [lc(USDC)]: 2_500_000n })).read(WALLET);
    expect(got.coins[0]).toMatchObject({ symbol: "USDC", claimable: { amount: "2.5" }, verdict: null });
  });

  it("shows the verdict on a flagged reward coin", async () => {
    const got = await reader(indexer({ claims: async () => ({ claims: [], whole: true }) }), rewards({ [lc(FLAG)]: 1n })).read(WALLET);
    expect(got.coins[0]!.verdict).toBe("FLAG");
  });

  it("puts the most to claim first", async () => {
    const got = await reader(indexer({ claims: async () => ({ claims: [], whole: true }) }), rewards({ [lc(PACT)]: 1n, [lc(FLAG)]: 5n })).read(WALLET);
    expect(got.coins.map((c) => c.token)).toEqual([lc(FLAG), lc(PACT)]);
  });

  it("keeps a coin that was claimed but has left the contract's list", async () => {
    const gone = "0x" + "9".repeat(40);
    const got = await reader(indexer({ claims: async () => ({ claims: [claim(gone, 6n * E, "OLD")], whole: true }) }), rewards({})).read(WALLET);
    expect(got.coins).toHaveLength(1);
    expect(got.coins[0]).toMatchObject({ token: gone, claimable: { raw: "0" }, claimed: { amount: "6" } });
  });

  it("lists recent claims with their transactions", async () => {
    const got = await reader().read(WALLET);
    expect(got.recentClaims[0]).toMatchObject({ token: lc(PACT), symbol: "PACT", tx: `0x${"1".repeat(64)}`, url: "https://x/tx", at: new Date(1_800_000_000_000).toISOString() });
  });

  it("still gives what's claimable when the indexer is down, with claimed unknown, not 0", async () => {
    const got = await reader(indexer({ claims: () => Promise.reject(new Error("down")) })).read(WALLET);
    expect(got.coins[0]).toMatchObject({ claimable: { amount: "4" }, claimed: null, earned: null });
    expect(got.complete).toBe(false);
  });

  it("says it's incomplete if there were too many claims to read", async () => {
    expect((await reader(indexer({ claims: async () => ({ claims: [claim(PACT, 1n)], whole: false }) })).read(WALLET)).complete).toBe(false);
  });

  it("says a coin couldn't be read, instead of showing 0 to claim", async () => {
    const got = await reader(indexer(), rewards({ [lc(FLAG)]: null, [lc(PACT)]: 1n })).read(WALLET);
    expect(got.unread).toEqual([lc(FLAG)]);
    expect(got.complete).toBe(false);
  });

  it("puts a coin whose name and decimals can't be read in unread, not a made-up amount", async () => {
    const got = await reader(indexer(), rewards(undefined, { meta: async (t) => t.map(() => null) })).read(WALLET);
    expect(got.coins).toEqual([]);
    expect(got.unread).toEqual([lc(PACT)]);
  });

  it("fails out loud when the contract can't be read, and before DELPHI's coins are loaded", async () => {
    await expect(reader(indexer(), rewards(undefined, { tokens: () => Promise.reject(new Error("node down")) })).read(WALLET)).rejects.toThrow("node down");
    await expect(new BasketReader({ verdicts: new Verdicts("/nowhere"), stake, indexer: indexer(), rewards: rewards(), usdc: USDC }).read(WALLET)).rejects.toThrow("no coins loaded");
  });

  it("asks a coin's name and decimals once, ever", async () => {
    const asked: string[][] = [];
    const base = rewards();
    const r = reader(indexer(), rewards(undefined, { meta: (t) => (asked.push([...t]), base.meta(t)) }));
    await r.read(WALLET);
    await r.read("0x7a988b8fa5d66de4950ee5f94c55c7820b6e562f");
    expect(asked).toEqual([[lc(PACT)]]);
  });

  it("remembers a wallet for 30 seconds", async () => {
    let t = 0;
    let reads = 0;
    const r = reader(indexer(), rewards(undefined, { tokens: async () => (reads++, [lc(PACT)]) }), { now: () => t });
    await r.read(WALLET);
    await r.read(WALLET.toUpperCase().replace("0X", "0x"));
    expect(reads).toBe(1);
    t = 30_000;
    await r.read(WALLET);
    expect(reads).toBe(2);
  });
});

describe("the basket", () => {
  it("gives each coin its weight, what was bought, and DELPHI's verdict", async () => {
    const got = await reader().basket();
    expect(got).toMatchObject({ proposal: 3, updatedAt: new Date(1_800_000_000_000).toISOString() });
    expect(got.coins[0]).toMatchObject({ token: lc(PACT), weightPct: 20, spent: { amount: "5" }, bought: { amount: "7" }, buys: 2, verdict: "CLEAN", disputeUrl: `https://pantheonindex.com/delphi/dispute?token=${lc(PACT)}` });
    expect(got.coins[0]!.lastBuy).toMatchObject({ tx: "0xa" });
    expect(got.coins[1]).toMatchObject({ verdict: "FLAG", lastBuy: null });
  });

  it("lists recent buys with their transactions", async () => {
    expect((await reader().basket()).recentBuys).toEqual([{ token: lc(PACT), symbol: "PACT", bought: "3", usdcIn: "100", tx: "0xb", url: "https://x/b", at: new Date(1_800_000_000_000).toISOString() }]);
  });

  it("copes with no active basket", async () => {
    expect(await reader(indexer({ basket: async () => ({ updatedAt: null, active: null }) })).basket()).toMatchObject({ proposal: null, coins: [], updatedAt: null });
  });
});

describe("calling the indexer", () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  it("follows every page of a wallet's claims", async () => {
    const urls: string[] = [];
    const calls = indexerCalls("http://i", async (u) => (urls.push(u), urls.length === 1 ? json({ items: [claim(PACT, 1n)], next: "5-1" }) : json({ items: [claim(PACT, 2n)], next: null })));
    const got = await calls.claims(WALLET);
    expect(got.whole).toBe(true);
    expect(got.claims).toHaveLength(2);
    expect(urls[1]).toContain("&before=5-1");
    expect(urls[0]).toContain(`kind=claim&account=${WALLET}`);
  });

  it("reads when a wallet staked, leaving out any without a time", async () => {
    const got = await indexerCalls("http://i", async () => json({ items: [{ tx: "0x1", url: "u", at: 500 }, { tx: "0x2", url: "u", at: null }], next: null })).stakes(WALLET);
    expect(got).toEqual({ times: [500], whole: true });
  });

  it("stops after 25 pages and says it did", async () => {
    let n = 0;
    const got = await indexerCalls("http://i", async () => (n++, json({ items: [claim(PACT, 1n)], next: "5-1" }))).claims(WALLET);
    expect(n).toBe(25);
    expect(got.whole).toBe(false);
  });

  it("fails on an error, or on an answer in the wrong shape", async () => {
    await expect(indexerCalls("http://i", async () => json({}, 503)).basket()).rejects.toThrow("503");
    await expect(indexerCalls("http://i", async () => json({ nope: 1 })).buys(5)).rejects.toThrow();
  });
});

describe("the chain reads", () => {
  const client = (results: unknown[]) => ({ multicall: async (o: { batchSize: number }) => (expect(o.batchSize).toBe(0), results) });
  const ok = (result: unknown) => ({ status: "success", result });

  it("works on the deployed contract, which has no retired list", async () => {
    const got = await chainRewards(client([ok([PACT]), { status: "failure" }]) as never, PACT).tokens();
    expect(got).toEqual([lc(PACT)]);
  });

  it("adds retired coins on the newer contract, once each", async () => {
    const got = await chainRewards(client([ok([PACT]), ok([PACT, USDC])]) as never, PACT).tokens();
    expect(got).toEqual([lc(PACT), lc(USDC)]);
  });

  it("fails out loud if the reward list can't be read", async () => {
    await expect(chainRewards(client([{ status: "failure" }, { status: "failure" }]) as never, PACT).tokens()).rejects.toThrow("couldn't be read");
  });

  it("turns one coin's failure into null", async () => {
    expect(await chainRewards(client([ok(5n), { status: "failure" }]) as never, PACT).earned(WALLET, [PACT, USDC])).toEqual([5n, null]);
    expect(await chainRewards(client([ok("PACT"), ok(18), { status: "failure" }, ok(6)]) as never, PACT).meta([PACT, USDC])).toEqual([{ symbol: "PACT", decimals: 18 }, null]);
  });
});

describe("asking the server", () => {
  const app = (r = reader()) => buildApp(verdicts(), { basket: r });

  it("answers with a wallet's rewards and the basket", async () => {
    expect((await app().inject({ url: `/wallets/${WALLET}/rewards` })).json()).toMatchObject({ passportBoost: 1.2 });
    const res = await app().inject({ url: "/basket" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ proposal: 3 });
  });

  it("answers 503 when the indexer fails for the basket, and doesn't say why", async () => {
    const res = await app(reader(indexer({ basket: () => Promise.reject(new Error("indexer detail")) }))).inject({ url: "/basket" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "INDEXER_UNAVAILABLE" });
  });

  it("refuses a bad address", async () => {
    expect((await app().inject({ url: "/wallets/nope/rewards" })).statusCode).toBe(400);
  });
});
