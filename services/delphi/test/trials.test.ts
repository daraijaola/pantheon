import { readFileSync } from "node:fs";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { keccak256, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { buildRound, LEAF_TYPES, priceVsAverage, roundBytes, volumes, weights, whyNot, type Candidate, type RegistryRules } from "../src/trials.ts";
import { addr, FAUCET, hash, scenario } from "./scenario.ts";

const USDC: Address = "0x4b4fb5C5794F0c821464956374cC5872D5F0f140";
const PNTH: Address = "0x048aCeb334cb1835dc897a749C5985e169EAb1C5";
// The deployed contracts' values (registry MAX_N, MAX_WEIGHT_BPS, MIN_AGE, maxRunCap, DELAY; vault maxStale,
// BAND_BPS), read with cast on Oct 14.
const RULES: RegistryRules = {
  maxCoins: 10, maxWeightBps: 2_000, minAgeSec: 72 * 3_600, maxRunCap: 1_000_000_000n, baseQuote: USDC, pnth: PNTH,
  delaySec: 86_400, maxStaleSec: 172_800, bandBps: 500,
};
const NOW = 1_792_000_000;

const coin = (n: number, real: bigint, over: Partial<Candidate> = {}): Candidate => ({
  token: addr(0x1000 + n),
  poolId: hash(0x2000 + n),
  symbol: `C${n}`,
  verdict: "NOT_ENOUGH_DATA",
  quote: USDC,
  launchedAt: NOW - 100 * 3_600,
  usdcVolume: real,
  washUsdc: 0n,
  creatorUsdc: 0n,
  realUsdc: real,
  priceAverageAt: NOW - 3_600,
  priceVsAveragePct: 0,
  ...over,
});
const round = (candidates: Candidate[], over: Partial<Parameters<typeof buildRound>[0]> = {}) =>
  buildRound({ round: 2, chainId: 99_801, scannedAt: "2026-10-15T00:00:00.000Z", scanBlock: "9186695", rulesVersion: "delphi-v0.1", candidates, rules: RULES, nowSec: NOW, coins: 5, perRunCap: 100_000_000n, ...over });

describe("volumes: what counts as independent trading", () => {
  it("leaves out the creator's own trades and wallets linked to the creator, keeps everyone else's", () => {
    const s = scenario();
    const friend = addr(0x200);
    const stranger = addr(0x300);
    s.fund(s.coin.creator, addr(0xf0)).fund(friend, addr(0xf0)); // same private funder: one actor
    s.buy(s.coin.creator, 50, 0).buy(friend, 20, 10_000).fund(stranger, FAUCET).buy(stranger, 7, 20_000);
    const v = volumes(s.build());
    expect(v).toEqual({ usdcVolume: 77_000_000n, washUsdc: 0n, creatorUsdc: 70_000_000n, realUsdc: 7_000_000n });
    // Round 1's method counted the creator too:
    expect(volumes(s.build(), { countCreator: true }).realUsdc).toBe(77_000_000n);
  });

  it("takes wash round trips out, and ignores trades in pools outside Ascend", () => {
    const s = scenario();
    const w = addr(0x300);
    s.buy(w, 10, 1_000).sell(w, 10, 1_060); // a 1-minute round trip: all wash
    s.buy(addr(0x301), 3, 5_000);
    s.arb(addr(0x302), 50, 9_000); // its sell leg is in an outside pool
    const v = volumes(s.build());
    expect(v.washUsdc).toBe(20_000_000n);
    expect(v.usdcVolume).toBe(73_000_000n); // 10 + 10 + 3 + the arb's 50 buy in the Ascend pool
    expect(v.realUsdc).toBe(53_000_000n);
  });
});

describe("whyNot: the contract's checks and DELPHI's", () => {
  it("names each reason a coin can't go in", () => {
    expect(whyNot(coin(1, 5n, { token: PNTH }), RULES, NOW)).toBe("PNTH itself");
    expect(whyNot(coin(1, 5n, { quote: addr(0xbad) }), RULES, NOW)).toBe("not priced in USDC");
    expect(whyNot(coin(1, 5n, { verdict: "FLAG", finding: "70% wash" }), RULES, NOW)).toBe("DELPHI FLAG: 70% wash");
    expect(whyNot(coin(1, 0n, { creatorUsdc: 9n }), RULES, NOW)).toBe("no independent trading (only the creator's own trades)");
    expect(whyNot(coin(1, 0n), RULES, NOW)).toBe("no real trading volume");
    expect(whyNot(coin(1, 5n, { verdict: "WATCH" }), RULES, NOW)).toBeNull(); // only FLAG is barred
  });

  it("uses the contract's age rule exactly: from 72 hours after launch, not a second before", () => {
    const launchedAt = NOW - 72 * 3_600;
    expect(whyNot(coin(1, 5n, { launchedAt }), RULES, NOW)).toBeNull();
    expect(whyNot(coin(1, 5n, { launchedAt: launchedAt + 1 }), RULES, NOW)).toBe("younger than 72 hours");
  });
});

describe("weights", () => {
  const ok = (w: number[], cap = 2_000) => w.reduce((s, x) => s + x, 0) === 10_000 && w.every((x) => x >= 1 && x <= cap);

  it("gives 5 coins 20% each, whatever their volumes (the cap forces it)", () => {
    expect(weights([17_000_170n, 7_004n, 7_004n, 3_233n, 1_339n], 2_000)).toEqual([2_000, 2_000, 2_000, 2_000, 2_000]);
  });

  it("shares by volume under the cap, and still sums to exactly 100%", () => {
    const w = weights([17_000_170n, 7_004n, 7_004n, 3_233n, 1_339n, 1_279n, 1_002n], 2_000);
    expect(w.slice(0, 3)).toEqual([2_000, 2_000, 2_000]);
    expect(ok(w)).toBe(true);
    expect(w[3]! > w[4]! && w[4]! > w[6]!).toBe(true);
  });

  it("never gives a coin 0 (the contract refuses it), even next to a whale", () => {
    const w = weights([10n ** 15n, ...Array.from({ length: 9 }, () => 1n)], 2_000);
    expect(ok(w)).toBe(true);
    expect(Math.min(...w)).toBeGreaterThanOrEqual(1);
  });

  it("refuses too few coins to reach 100% under the cap", () => {
    expect(() => weights([1n, 1n, 1n, 1n], 2_000)).toThrow(/can't reach 100%/);
  });
});

describe("buildRound", () => {
  const candidates = [
    coin(1, 901_507_174n),
    coin(2, 500_000_000n),
    coin(3, 461_208_282n),
    coin(4, 170_000_000n),
    coin(5, 139_946_489n),
    coin(6, 120_000_000n, { verdict: "FLAG", finding: "wash" }),
    coin(7, 100_000_000n),
    coin(8, 0n, { creatorUsdc: 594_000_000_000n, usdcVolume: 594_000_000_000n }),
  ];

  it("picks the top 5 qualifying coins by independent volume, in the format Micheal's propose script reads", () => {
    const { file } = round(candidates);
    expect(file.symbols).toEqual(["C1", "C2", "C3", "C4", "C5"]);
    expect(file.weightsBps).toEqual([2_000, 2_000, 2_000, 2_000, 2_000]);
    expect(file.perRunCaps).toEqual([100_000_000, 100_000_000, 100_000_000, 100_000_000, 100_000_000]);
    expect(file.pools).toEqual(candidates.slice(0, 5).map((c) => c.poolId));
    expect(file.excluded.map((x) => [x.symbol, x.why])).toEqual([
      ["C6", "DELPHI FLAG: wash"],
      ["C8", "no independent trading (only the creator's own trades)"],
    ]);
    expect(file.ranking.map((r) => r.symbol)).toEqual(["C1", "C2", "C3", "C4", "C5", "C7"]);
  });

  it("gives the same bytes for the same data, however it was read", () => {
    const a = roundBytes(round(candidates).file);
    const b = roundBytes(round([...candidates].reverse()).file);
    expect(b).toBe(a);
    expect(a.endsWith("}\n")).toBe(true);
  });

  it("breaks volume ties by address, never by reading order", () => {
    const tied = [coin(9, 5n), coin(3, 5n), coin(5, 5n), coin(1, 5n), coin(7, 5n), coin(2, 5n)];
    expect(round(tied).file.symbols).toEqual(["C1", "C2", "C3", "C5", "C7"]);
  });

  it("commits every considered coin to a Merkle root whose proofs check out", () => {
    const { file, tree } = round(candidates);
    const loaded = StandardMerkleTree.load(tree.dump());
    expect(loaded.root).toBe(file.merkleRoot);
    let n = 0;
    for (const [i, leaf] of loaded.entries()) {
      expect(StandardMerkleTree.verify(file.merkleRoot, [...LEAF_TYPES], leaf, loaded.getProof(i))).toBe(true);
      n++;
    }
    expect(n).toBe(candidates.length);
    // Change any number and the root changes.
    expect(round([coin(1, 901_507_175n), ...candidates.slice(1)]).file.merkleRoot).not.toBe(file.merkleRoot);
  });

  it("warns about coins the basket won't buy when the round can start (after the registry's 24 h wait)", () => {
    const picks = [
      coin(1, 9n, { priceAverageAt: NOW - 25 * 3_600 }), // fresh today, but 49 h old by the time the round starts
      coin(2, 8n, { priceAverageAt: NOW - 23 * 3_600 }), // still 47 h: fine
      coin(3, 7n, { priceVsAveragePct: 12.7 }), // REE on the fork: above the 5% band
      coin(4, 6n, { priceVsAveragePct: 5 }), // right at the band: fine
      coin(5, 5n, { priceAverageAt: null }), // no average at all
    ];
    expect(round(picks).warnings).toEqual([
      "C1: its price average will be older than 48 h when the round can start, so the basket skips it until it trades",
      "C3: its price is 12.7% above its average; the basket buys only within 5%, until the average catches up",
      "C5: its price average will be older than 48 h when the round can start, so the basket skips it until it trades",
    ]);
  });

  it("lets the curator leave a coin out, and says so in the file", () => {
    const exclude = new Map([[candidates[3]!.token.toLowerCase(), "price 119x its average"]]);
    const { file } = round(candidates, { exclude });
    expect(file.symbols).toEqual(["C1", "C2", "C3", "C5", "C7"]);
    expect(file.excluded).toContainEqual({ symbol: "C4", token: candidates[3]!.token, why: "excluded by the curator: price 119x its average" });
  });

  it("refuses rounds the registry would refuse", () => {
    expect(() => round(candidates.slice(0, 4))).toThrow(/only 4 coins qualify/);
    expect(() => round(candidates, { coins: 4 })).toThrow(/needs 5 to 10 coins/);
    expect(() => round(candidates, { coins: 11 })).toThrow(/needs 5 to 10 coins/);
    expect(() => round(candidates, { perRunCap: 2_000_000_000n })).toThrow(/per-run cap/);
  });
});

describe("checking a round, the way anyone can", () => {
  it("round 1's published file hashes to the fingerprint stored in the registry for proposal 0", () => {
    const onChain: Hex = "0x8093c2fde5f43333d64b9c32a2d71d56a6f1dbe29cf6addfeb51a3851ca3ca2b"; // cast call proposal(0), Oct 14
    expect(keccak256(readFileSync(new URL("./fixtures/round-1.json", import.meta.url)))).toBe(onChain);
  });
});

describe("priceVsAverage", () => {
  it("reads the coin's price against its average whichever side of the pool the coin is on", () => {
    // sqrt prices 10% apart: the price ratio of currency1 per currency0 is 1.21.
    expect(priceVsAverage(110n, 100n, true)).toBe(21); // coin is currency0: its price is up 21%
    expect(priceVsAverage(110n, 100n, false)).toBe(-17.4); // coin is currency1: its price is down 17.4%
    expect(priceVsAverage(100n, 100n, true)).toBe(0);
    expect(priceVsAverage(0n, 100n, true)).toBeNull(); // no pool price
    expect(priceVsAverage(100n, 0n, false)).toBeNull(); // no average yet
  });
});
