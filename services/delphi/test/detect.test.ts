import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { contractHoldings, detectBundle, detectConcentration, detectWash, pct } from "../src/detect.ts";
import { clusters } from "../src/graph.ts";
import { analyze } from "../src/report.ts";
import type { Link } from "../src/types.ts";
import { addr, FAUCET, scenario } from "./scenario.ts";

const WEB = "https://explorer.test";
const F = addr(0xf0); // a private funder (a farmer's wallet)
const wallets = (from: number, n: number) => Array.from({ length: n }, (_, i) => addr(from + i));

/** Eight independent faucet-funded traders, spread over a day: the "normal coin" baseline. */
function honest(s: ReturnType<typeof scenario>, startSec = 3_600) {
  wallets(0x100, 8).forEach((w, i) => s.fund(w, FAUCET).buy(w, 5, startSec + i * 3_600));
  return s;
}

describe("faucet trap", () => {
  it("never links wallets just because the testnet faucet funded them all", () => {
    const s = scenario();
    wallets(0x100, 6).forEach((w, i) => s.fund(w, FAUCET).buy(w, 30, 1 + i));
    const d = s.build();
    expect(d.links).toEqual([]);
    expect(detectBundle(d).finding).toBeNull();
    expect(detectConcentration(d).finding).toBeNull();
  });

  it("treats any funder with a huge transaction count as public, but a small one as a link", () => {
    const s = scenario();
    wallets(0x100, 3).forEach((w, i) => s.fund(w, F).buy(w, 60, 1 + i));
    expect(s.build(new Map([[F.toLowerCase(), 6_000]])).links).toEqual([]);
    expect(s.build(new Map([[F.toLowerCase(), 40]])).links.map((l) => l.reason)).toEqual(["shared-funder", "shared-funder"]);
  });
});

describe("contracts are not wallets", () => {
  // Eight independent buyers stake most of their tokens in one staking contract (PANTHEON, Oct 2026).
  const STAKING = addr(0x5a);
  const staked = () => {
    const s = honest(scenario());
    s.sell(addr(0x100), 1, 4 * 86_400).sell(addr(0x101), 1, 5 * 86_400);
    wallets(0x100, 8).forEach((w, i) => s.pass(w, STAKING, 3, 6 * 86_400 + i));
    return s;
  };

  it("doesn't link wallets that deposit into the same contract, or count the contract as a holder", () => {
    const d = staked().build(new Map(), [STAKING]);
    expect(d.links).toEqual([]);
    expect(detectConcentration(d).finding).toBeNull();
    const r = analyze(d, { explorerWeb: WEB });
    expect(r.verdict).toBe("CLEAN");
    // 24M of the 38M tokens outside the pool sit in the contract, and the report says so.
    expect(contractHoldings(d)).toEqual({ share: 63.15, top: [{ contract: STAKING.toLowerCase(), pct: 63.15 }] });
    expect(r.notes.join(" ")).toContain("Contracts hold 63.15% of the tokens outside the pool (0x0000…005a 63.15%)");
  });

  it("would call them one actor if the contract were taken for a wallet (the v0.1 mistake)", () => {
    const d = staked().build();
    expect(new Set(d.links.map((l) => l.reason))).toEqual(new Set(["token-pass"]));
    expect(detectConcentration(d).finding?.severity).toBe("flag");
  });

  it("says nothing about contracts that hold little", () => {
    const s = honest(scenario());
    s.pass(addr(0x100), addr(0x5a), 1, 86_400);
    expect(contractHoldings(s.build(new Map(), [addr(0x5a)]))).toBeNull();
  });
});

describe("clean coin", () => {
  it("is CLEAN when every check has data and finds nothing", () => {
    const s = honest(scenario());
    s.sell(addr(0x100), 5, 4 * 86_400).sell(addr(0x101), 2, 5 * 86_400);
    const r = analyze(s.build(), { explorerWeb: WEB });
    expect(r.checks).toEqual({ bundle: "clear", wash: "clear", concentration: "clear" });
    expect(r.verdict).toBe("CLEAN");
  });

  it("is NOT_ENOUGH_DATA, not CLEAN, for a coin almost nobody traded", () => {
    const s = scenario().buy(addr(0x100), 5, 60).buy(addr(0x101), 5, 900);
    const r = analyze(s.build(), { explorerWeb: WEB });
    expect(r.checks).toEqual({ bundle: "clear", wash: "not-enough-data", concentration: "not-enough-data" });
    expect(r.verdict).toBe("NOT_ENOUGH_DATA");
  });
});

describe("launch bundle", () => {
  it("flags linked wallets (and the creator) buying a big share in the first seconds", () => {
    const s = scenario();
    s.fund(s.coin.creator, F).buy(s.coin.creator, 40, 0); // the dev-buy, in the launch transaction
    wallets(0x200, 3).forEach((w, i) => s.fund(w, F).buy(w, 50, 2 + i));
    honest(s);
    const f = detectBundle(s.build()).finding!;
    expect(f.severity).toBe("flag");
    expect(f.metrics).toMatchObject({ linkedWallets: 4, supplyPct: 19 });
    expect(f.summary).toContain("including the creator");
    expect(f.evidence.some((e) => e.what.startsWith("link: shared funder"))).toBe(true);
  });

  it("only watches a smaller linked buy", () => {
    const s = scenario();
    wallets(0x200, 2).forEach((w, i) => s.fund(w, F).buy(w, 30, 5 + i));
    expect(detectBundle(s.build()).finding).toMatchObject({ severity: "watch", metrics: { supplyPct: 6 } });
  });

  it("does not call the creator's disclosed dev-buy alone a bundle", () => {
    const s = scenario();
    s.buy(s.coin.creator, 200, 0).buy(addr(0x100), 5, 3);
    expect(detectBundle(s.build()).finding).toBeNull();
  });

  it("ignores linked buys after the launch window", () => {
    const s = scenario();
    wallets(0x200, 3).forEach((w, i) => s.fund(w, F).buy(w, 100, 120 + i));
    expect(detectBundle(s.build()).finding).toBeNull();
  });

  it("follows bought-for links: one payer sending launch buys to fresh wallets", () => {
    const payer = addr(0x300);
    const s = scenario();
    wallets(0x200, 3).forEach((w, i) => s.buy(w, 60, 1 + i, payer));
    const f = detectBundle(s.build()).finding!;
    expect(f).toMatchObject({ severity: "flag", metrics: { linkedWallets: 3, supplyPct: 18 } });
  });
});

describe("wash trading", () => {
  it("flags a linked pair churning the same tokens within minutes", () => {
    const [a, b] = wallets(0x200, 2) as [`0x${string}`, `0x${string}`];
    const s = scenario();
    for (let k = 0; k < 4; k++) {
      const t = 3_600 * (k + 1);
      s.buy(a, 10, t).pass(a, b, 10, t + 30).sell(b, 10, t + 60);
    }
    wallets(0x100, 3).forEach((w, i) => s.buy(w, 10, 50_000 + i * 600));
    const f = detectWash(s.build()).finding!;
    // 80M of the 110M tokens traded are matched round trips.
    expect(f).toMatchObject({ severity: "flag", metrics: { washVolumePct: 72.72, roundTripWallets: 2 } });
    expect(f.summary).toContain("(some linked)");
  });

  it("catches one wallet churning on its own", () => {
    const w = addr(0x200);
    const s = scenario();
    for (let k = 0; k < 3; k++) s.buy(w, 10, 3_600 * (k + 1)).sell(w, 10, 3_600 * (k + 1) + 90);
    wallets(0x100, 2).forEach((x, i) => s.buy(x, 20, 90_000 + i));
    expect(detectWash(s.build()).finding).toMatchObject({ severity: "flag", metrics: { washVolumePct: 60, roundTripWallets: 1 } });
  });

  it("does not call arbitrage between two pools in one transaction wash trading", () => {
    const bot = addr(0x400);
    const s = honest(scenario());
    for (let k = 0; k < 5; k++) s.arb(bot, 20, 50_000 + k * 60);
    expect(detectWash(s.build())).toEqual({ enough: true, finding: null });
  });

  it("still catches a buy and sell of the same tokens in the same pool and transaction", () => {
    const bot = addr(0x400);
    const s = honest(scenario());
    for (let k = 0; k < 5; k++) s.arb(bot, 20, 50_000 + k * 60, true);
    // 200M of the 240M tokens traded are matched round trips.
    expect(detectWash(s.build()).finding).toMatchObject({ severity: "flag", metrics: { washVolumePct: 83.33, roundTripWallets: 1 } });
  });

  it("does not call a flip days later wash trading", () => {
    const s = honest(scenario());
    s.sell(addr(0x100), 5, 3 * 86_400).sell(addr(0x101), 5, 3 * 86_400 + 60);
    expect(detectWash(s.build())).toEqual({ enough: true, finding: null });
  });

  it("only counts the matched part of a partial round trip", () => {
    const w = addr(0x200);
    const s = scenario().buy(w, 100, 100).sell(w, 10, 160);
    wallets(0x100, 4).forEach((x, i) => s.buy(x, 1, 90_000 + i));
    // Matched: 10M of the buy + the 10M sell = 20M of 114M tokens traded.
    expect(detectWash(s.build()).finding).toBeNull();
  });

  it("needs a minimum number of trades before it says anything", () => {
    const w = addr(0x200);
    const s = scenario().buy(w, 10, 100).sell(w, 10, 130);
    expect(detectWash(s.build())).toEqual({ enough: false, finding: null });
  });
});

describe("hidden concentration", () => {
  it("flags linked wallets holding most of the circulating tokens", () => {
    const s = honest(scenario(), 7_200);
    wallets(0x200, 4).forEach((w, i) => s.fund(w, F).buy(w, 15, 600 + i * 60));
    const f = detectConcentration(s.build()).finding!;
    // 60M of 100M held by wallets.
    expect(f).toMatchObject({ severity: "flag", metrics: { linkedWallets: 4, circulatingPct: 60, holders: 12 } });
    expect(f.evidence.filter((e) => e.what.includes("holds"))).toHaveLength(4);
  });

  it("sees through tokens passed out to fresh wallets", () => {
    const boss = addr(0x200);
    const s = honest(scenario(), 7_200).buy(boss, 40, 600);
    wallets(0x300, 4).forEach((w, i) => s.pass(boss, w, 10, 700 + i));
    const f = detectConcentration(s.build()).finding!;
    // The boss passed everything out; the four fresh wallets hold 40M of 80M.
    expect(f).toMatchObject({ severity: "flag", metrics: { linkedWallets: 4, circulatingPct: 50 } });
  });

  it("does not count system contracts as holders", () => {
    const s = honest(scenario());
    const d = s.build();
    expect(detectConcentration(d).finding).toBeNull();
    expect(detectConcentration(d).enough).toBe(true);
  });
});

/** Whether v0.2's transitive closure (every link chained) would put all of `ws` in one cluster. */
function chained(links: Link[], ws: Address[]): boolean {
  const next = new Map<string, string[]>();
  for (const l of links) {
    for (const [x, y] of [[l.a, l.b], [l.b, l.a]] as const) next.set(x.toLowerCase(), [...(next.get(x.toLowerCase()) ?? []), y.toLowerCase()]);
  }
  const seen = new Set([ws[0]!.toLowerCase()]);
  const todo = [ws[0]!.toLowerCase()];
  while (todo.length) {
    for (const y of next.get(todo.pop()!) ?? []) {
      if (seen.has(y)) continue;
      seen.add(y);
      todo.push(y);
    }
  }
  return ws.every((w) => seen.has(w.toLowerCase()));
}

describe("farmed testnet (rules v0.3)", () => {
  const [A, B, C] = [addr(0xfa), addr(0xfb), addr(0xfc)];

  it("never chains separate farmers into one group through wallets that several of them paid", () => {
    // Three farmers with two wallets each (7M tokens per wallet), plus two wallets that got HYPE from two
    // farmers each. Seen live on every basket coin: 25 funders chained into "36 linked wallets hold 51%".
    const s = honest(scenario(), 7_200);
    ([[A, 0x200], [B, 0x210], [C, 0x220]] as const).forEach(([f, n], k) => wallets(n, 2).forEach((w, i) => s.fund(w, f).buy(w, 7, 600 + k * 60 + i)));
    const [x, y] = [addr(0x300), addr(0x301)];
    s.fund(x, A).fund(x, B).buy(x, 0.1, 900).fund(y, B).fund(y, C).buy(y, 0.1, 901);
    const d = s.build(new Map(), [], { network: "testnet" });
    const farmers = [...wallets(0x200, 2), ...wallets(0x210, 2), ...wallets(0x220, 2), x, y];
    // v0.2 joined all eight (42.2M of 82.2M, 51%: FLAG). Each farmer's own star holds 17% at most.
    expect(chained(d.links, farmers)).toBe(true);
    expect(detectConcentration(d).finding).toBeNull();
    expect(analyze(d, { explorerWeb: WEB }).verdict).toBe("CLEAN");
    const cl = clusters(d.links);
    expect(cl.get(addr(0x200))).not.toBe(cl.get(addr(0x210)));
    expect(cl.get(addr(0x210))).not.toBe(cl.get(addr(0x220)));
  });

  it("does not let a single weak link (one contract payout between two farmers) join their groups", () => {
    const s = honest(scenario(), 7_200);
    wallets(0x200, 2).forEach((w, i) => s.fund(w, A).buy(w, 15, 600 + i));
    wallets(0x210, 2).forEach((w, i) => s.fund(w, B).buy(w, 15, 700 + i));
    // 0x…200 bought an NFT from 0x…210: the marketplace paid the seller inside the buyer's transaction.
    s.fund(addr(0x210), addr(0x200), 800, "contract");
    const d = s.build(new Map(), [], { network: "testnet" });
    expect(d.links.some((l) => l.reason === "funded-by")).toBe(false);
    // Each farmer's star holds 30M of 100M: a WATCH on direct evidence, not 60% and a FLAG.
    expect(detectConcentration(d).finding).toMatchObject({ severity: "watch", metrics: { linkedWallets: 2, circulatingPct: 30, evidence: "direct" } });
  });

  it("calls a contract's batch payout second-hand: a WATCH at most, and says so", () => {
    const s = honest(scenario(), 7_200);
    const paid = wallets(0x200, 4);
    s.payout(paid, addr(0x5e));
    paid.forEach((w, i) => s.buy(w, 15, 600 + i));
    const d = s.build();
    expect(d.links.every((l) => l.secondHand)).toBe(true);
    const f = detectConcentration(d).finding!;
    // 60M of 100M would be a FLAG on direct evidence.
    expect(f).toMatchObject({ severity: "watch", metrics: { linkedWallets: 4, circulatingPct: 60, evidence: "second-hand" } });
    expect(f.summary).toContain("tied only by second-hand evidence");
    expect(f.summary).toContain("WATCH at most");
    expect(analyze(d, { explorerWeb: WEB }).verdict).toBe("WATCH");
    // Second-hand links never make a launch bundle either.
    const early = scenario();
    early.payout(wallets(0x200, 3), addr(0x5e));
    wallets(0x200, 3).forEach((w, i) => early.buy(w, 60, 1 + i));
    expect(detectBundle(early.build()).finding).toBeNull();
  });

  it("counts a batch payout sent by the coin's own creator in full", () => {
    const s = honest(scenario(), 7_200);
    const paid = wallets(0x200, 4);
    s.payout(paid, s.coin.creator);
    paid.forEach((w, i) => s.buy(w, 15, 600 + i));
    expect(detectConcentration(s.build()).finding).toMatchObject({ severity: "flag", metrics: { linkedWallets: 4, circulatingPct: 60, evidence: "direct" } });
  });

  it("treats a distribution bot as public on testnet, but not on mainnet", () => {
    const bot = addr(0xb0);
    const s = honest(scenario(), 7_200);
    // The bot paid gas to 20 tracked wallets; four of them hold 60% of this coin.
    const paid = wallets(0x400, 20);
    paid.forEach((w) => s.fund(w, bot));
    paid.slice(0, 4).forEach((w, i) => s.buy(w, 15, 600 + i));
    expect(s.build(new Map(), [], { network: "testnet" }).links).toEqual([]);
    expect(detectConcentration(s.build(new Map(), [], { network: "mainnet" })).finding?.severity).toBe("flag");
  });

  it("treats a funder whose wallets trade many different coins as a farm on testnet, but still catches a one-coin ring", () => {
    const s = honest(scenario(), 7_200);
    wallets(0x200, 4).forEach((w, i) => s.fund(w, F).buy(w, 15, 600 + i));
    const farm = new Map([[F.toLowerCase(), { wallets: 6, coins: 7 }]]);
    expect(detectConcentration(s.build(new Map(), [], { network: "testnet", payees: farm })).finding).toBeNull();
    // The same four wallets, when their funder seeded them for this coin only: a real ring, FLAG on testnet too.
    expect(detectConcentration(s.build(new Map(), [], { network: "testnet" })).finding).toMatchObject({
      severity: "flag",
      metrics: { linkedWallets: 4, circulatingPct: 60, evidence: "direct" },
    });
  });

  it("never treats a coin's creator as public on its own coin (a creator funding its snipers)", () => {
    // Seen live: one creator launched 21 test coins and funded the same 16 wallets that sniped each one.
    const s = scenario();
    wallets(0x200, 4).forEach((w, i) => s.fund(w, s.coin.creator).buy(w, 50, 2 + i));
    const busy = new Map([[s.coin.creator.toLowerCase(), { wallets: 30, coins: 12 }]]);
    const f = detectBundle(s.build(new Map([[s.coin.creator.toLowerCase(), 9_000]]), [], { network: "testnet", payees: busy })).finding!;
    expect(f).toMatchObject({ severity: "flag", metrics: { linkedWallets: 4, supplyPct: 20 } });
  });

  it("still sees tokens passed out to fresh wallets as one actor on testnet", () => {
    const boss = addr(0x200);
    const s = honest(scenario(), 7_200).buy(boss, 40, 600);
    wallets(0x300, 4).forEach((w, i) => s.pass(boss, w, 10, 700 + i));
    expect(detectConcentration(s.build(new Map(), [], { network: "testnet" })).finding).toMatchObject({
      severity: "flag",
      metrics: { linkedWallets: 4, circulatingPct: 50, evidence: "direct" },
    });
  });
});

describe("pct", () => {
  it("is exact whole-number maths, rounded down to 2 decimals", () => {
    expect(pct(1n, 3n)).toBe(33.33);
    expect(pct(2n, 3n)).toBe(66.66);
    expect(pct(5n, 0n)).toBe(0);
    expect(pct(10n ** 30n, 10n ** 30n)).toBe(100);
  });
});
