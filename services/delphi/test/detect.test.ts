import { describe, expect, it } from "vitest";
import { contractHoldings, detectBundle, detectConcentration, detectWash, pct } from "../src/detect.ts";
import { analyze } from "../src/report.ts";
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

describe("pct", () => {
  it("is exact whole-number maths, rounded down to 2 decimals", () => {
    expect(pct(1n, 3n)).toBe(33.33);
    expect(pct(2n, 3n)).toBe(66.66);
    expect(pct(5n, 0n)).toBe(0);
    expect(pct(10n ** 30n, 10n ** 30n)).toBe(100);
  });
});
