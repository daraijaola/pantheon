// The Trials: DELPHI's data turned into a basket proposal for ConstituentRegistry.propose. Pure
// functions, so the same scan always gives the same round file, byte for byte. The registry's
// fingerprint of a round (Micheal's propose script stores keccak256 of the file) can then be recomputed
// by anyone, and the Merkle root inside the file lets each coin's row be proven on its own.
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import type { Address, Hex } from "viem";
import { roundTrips } from "./detect.ts";
import { clusters } from "./graph.ts";
import type { CoinData, Verdict } from "./types.ts";

/** The registry's own rules, read from the contract (never copied by hand), plus the basket vault's price rules. */
export type RegistryRules = {
  maxCoins: number;
  maxWeightBps: number;
  minAgeSec: number;
  maxRunCap: bigint;
  baseQuote: Address;
  pnth: Address;
  /** ConstituentRegistry.DELAY: a round can start this long after it is proposed. */
  delaySec: number;
  /** IndexVault.maxStale: the basket skips a coin whose price average is older than this. */
  maxStaleSec: number;
  /** IndexVault.BAND_BPS: the basket buys only within this far above the average (in price). */
  bandBps: number;
};

/** The coin's price over its price average, in percent, from the pool's square-root prices. */
export function priceVsAverage(spotSqrt: bigint, emaSqrt: bigint, coinIs0: boolean): number | null {
  if (spotSqrt === 0n || emaSqrt === 0n) return null;
  const r = Number(spotSqrt) / Number(emaSqrt); // in currency1 per currency0, square-rooted
  const coin = coinIs0 ? r * r : 1 / (r * r); // the coin's price in USDC, relative to its average
  return Math.round((coin - 1) * 1_000) / 10;
}

export type Candidate = {
  token: Address;
  poolId: Hex;
  symbol: string | null;
  verdict: Verdict;
  /** Short reason for a verdict worth naming (FLAG), from DELPHI's own finding. */
  finding?: string;
  quote: Address;
  launchedAt: number;
  /**
   * USDC traded in the coin's Ascend pool (6 decimals): all of it, the part that was wash (round trips),
   * the part traded by the creator or wallets DELPHI links to the creator, and what's left: independent.
   */
  usdcVolume: bigint;
  washUsdc: bigint;
  creatorUsdc: bigint;
  realUsdc: bigint;
  /** When Ascend last updated this pool's price average (the basket skips averages older than 48 h). */
  priceAverageAt: number | null;
  /**
   * How far the coin's price is above (+) or below its Ascend price average, in percent. The basket
   * only buys within 5% above it. After a long quiet spell the average lags far behind (seen on a fork:
   * REE +12.7%, back to +3% after 6 h of small trades; FGK, pumped by its creator, +11,904%).
   */
  priceVsAveragePct: number | null;
  headline?: string;
};

/**
 * USDC volume in the coin's own Ascend pool, split up. A trade's wash part is its quote amount times the
 * share of its tokens the wash check matched (the same matching the verdicts use). Trades by the creator
 * (or the launcher, or any wallet DELPHI links to them) are not independent demand: on testnet, USDC can
 * be minted for free, and creators bought their own coins with millions of it (seen live: FGK's
 * "17,000,170 USDC" was 17M of the creator's own buys and about 170 USDC from anyone else).
 * `countCreator` keeps their trades in (round 1's method), for comparison only.
 */
export function volumes(d: CoinData, opts: { countCreator?: boolean } = {}) {
  const matched = roundTrips(d);
  const cl = clusters(d.links, [d.coin.creator, d.coin.launcher]);
  const team = new Set([d.coin.creator, d.coin.launcher].map((a) => cl.get(a.toLowerCase())!));
  const isTeam = (a: string) => team.has(cl.get(a.toLowerCase()) ?? a.toLowerCase());
  let usdcVolume = 0n;
  let washUsdc = 0n;
  let creatorUsdc = 0n;
  let realUsdc = 0n;
  for (const t of d.trades) {
    if (t.pool.toLowerCase() !== d.coin.poolId.toLowerCase() || t.tokens === 0n) continue;
    const wash = (t.quote * (matched.get(t) ?? 0n)) / t.tokens;
    usdcVolume += t.quote;
    washUsdc += wash;
    if (isTeam(t.trader) || isTeam(t.holder)) {
      creatorUsdc += t.quote;
      if (opts.countCreator) realUsdc += t.quote - wash;
    } else {
      realUsdc += t.quote - wash;
    }
  }
  return { usdcVolume, washUsdc, creatorUsdc, realUsdc };
}

export const realVolume = (c: Pick<Candidate, "realUsdc">) => c.realUsdc;

/** Why a coin can't be in the basket, or null if it can. The contract's checks plus DELPHI's. */
export function whyNot(c: Candidate, r: RegistryRules, nowSec: number, excluded: ReadonlyMap<string, string> = new Map()): string | null {
  const byCurator = excluded.get(c.token.toLowerCase());
  if (byCurator !== undefined) return `excluded by the curator${byCurator ? `: ${byCurator}` : ""}`;
  if (c.token.toLowerCase() === r.pnth.toLowerCase()) return "PNTH itself";
  if (c.quote.toLowerCase() !== r.baseQuote.toLowerCase()) return "not priced in USDC";
  if (c.verdict === "FLAG") return `DELPHI FLAG${c.finding ? `: ${c.finding}` : ""}`;
  if (nowSec < c.launchedAt + r.minAgeSec) return `younger than ${r.minAgeSec / 3600} hours`;
  if (realVolume(c) <= 0n) return c.creatorUsdc > 0n ? "no independent trading (only the creator's own trades)" : "no real trading volume";
  return null;
}

/**
 * Basket weights in basis points, proportional to real volume, none above the cap, summing to exactly
 * 10,000. Coins over the cap are fixed at the cap and the rest is shared again (with 5 coins and a 20%
 * cap that is 20% each). Rounding leftovers go to the largest remainders, never above the cap.
 */
export function weights(volumes: readonly bigint[], capBps: number): number[] {
  const n = volumes.length;
  if (n * capBps < 10_000) throw new Error(`${n} coins can't reach 100% with a ${capBps / 100}% cap`);
  const exact = new Array<number>(n).fill(0);
  const free = new Set(volumes.map((_, i) => i));
  let left = 10_000;
  for (;;) {
    const total = [...free].reduce((s, i) => s + Number(volumes[i]!), 0);
    const share = (i: number) => (total > 0 ? (left * Number(volumes[i]!)) / total : left / free.size);
    const over = [...free].filter((i) => share(i) > capBps);
    if (over.length === 0) {
      for (const i of free) exact[i] = share(i);
      break;
    }
    for (const i of over) {
      exact[i] = capBps;
      free.delete(i);
      left -= capBps;
    }
  }
  // Whole basis points: at least 1 each (the contract refuses 0), then fix the total to exactly 10,000,
  // adding to the largest remainders (never past the cap) or taking from the largest weights (never below 1).
  const out = exact.map((w) => Math.max(1, Math.floor(w)));
  let rest = 10_000 - out.reduce((s, w) => s + w, 0);
  const byRemainder = exact.map((w, i) => ({ i, frac: w - Math.floor(w) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; rest > 0; k = (k + 1) % n) {
    const i = byRemainder[k]!.i;
    if (out[i]! < capBps) {
      out[i]! += 1;
      rest--;
    }
  }
  const byWeight = out.map((w, i) => ({ i, w })).sort((a, b) => b.w - a.w || a.i - b.i);
  for (let k = 0; rest < 0; k = (k + 1) % n) {
    const i = byWeight[k]!.i;
    if (out[i]! > 1) {
      out[i]! -= 1;
      rest++;
    }
  }
  return out;
}

const VERDICT_CODE: Record<Verdict, number> = { CLEAN: 1, WATCH: 2, NOT_ENOUGH_DATA: 3, FLAG: 4 };
/** One Merkle leaf per coin considered: what went in (volumes, verdict) and what came out (rank, weight, cap). */
export const LEAF_TYPES = ["address", "bytes32", "uint8", "uint256", "uint256", "uint256", "uint256", "uint16", "uint16", "uint128"] as const;

export type Round = ReturnType<typeof buildRound>;

export function buildRound(input: {
  round: number;
  chainId: number;
  scannedAt: string;
  scanBlock: string;
  rulesVersion: string;
  candidates: readonly Candidate[];
  rules: RegistryRules;
  nowSec: number;
  coins: number;
  perRunCap: bigint;
  countCreator?: boolean;
  /** Coins the curator leaves out by hand (lowercase address → reason); recorded in the file. */
  exclude?: ReadonlyMap<string, string>;
}) {
  const { rules: r } = input;
  if (input.coins < Math.ceil(10_000 / r.maxWeightBps) || input.coins > r.maxCoins) {
    throw new Error(`a basket needs ${Math.ceil(10_000 / r.maxWeightBps)} to ${r.maxCoins} coins, not ${input.coins}`);
  }
  if (input.perRunCap <= 0n || input.perRunCap > r.maxRunCap) throw new Error(`per-run cap must be 1..${r.maxRunCap} (USDC, 6 decimals)`);

  const traded = input.candidates.filter((c) => c.usdcVolume > 0n);
  const verdicts = traded.map((c) => ({ c, why: whyNot(c, r, input.nowSec, input.exclude) }));
  // Real volume first; ties broken by address so the order never depends on how the data was read.
  const ranked = verdicts
    .filter((v) => v.why === null)
    .map((v) => v.c)
    .sort((a, b) => (realVolume(b) > realVolume(a) ? 1 : realVolume(b) < realVolume(a) ? -1 : a.token.toLowerCase() < b.token.toLowerCase() ? -1 : 1));
  if (ranked.length < input.coins) throw new Error(`only ${ranked.length} coins qualify; the basket needs ${input.coins}`);
  const picked = ranked.slice(0, input.coins);
  const w = weights(picked.map(realVolume), r.maxWeightBps);

  const rankOf = new Map(ranked.map((c, i) => [c.token.toLowerCase(), i + 1]));
  const weightOf = new Map(picked.map((c, i) => [c.token.toLowerCase(), w[i]!]));
  const leaves = [...traded]
    .sort((a, b) => (a.token.toLowerCase() < b.token.toLowerCase() ? -1 : 1))
    .map((c) => [
      c.token,
      c.poolId,
      VERDICT_CODE[c.verdict],
      c.usdcVolume.toString(),
      c.washUsdc.toString(),
      c.creatorUsdc.toString(),
      c.realUsdc.toString(),
      rankOf.get(c.token.toLowerCase()) ?? 0,
      weightOf.get(c.token.toLowerCase()) ?? 0,
      (weightOf.has(c.token.toLowerCase()) ? input.perRunCap : 0n).toString(),
    ]);
  const tree = StandardMerkleTree.of(leaves, [...LEAF_TYPES]);
  const hours = (at: number | null) => (at === null ? null : Math.floor((input.nowSec - at) / 3600));

  const file = {
    round: input.round,
    chainId: input.chainId,
    scannedAt: input.scannedAt,
    scanBlock: input.scanBlock,
    rules: input.rulesVersion,
    method:
      `Ascend coins priced in USDC, at least ${r.minAgeSec / 3600} hours old, never a DELPHI FLAG, ranked by independent trading volume in USDC: ` +
      (input.countCreator
        ? `volume in the coin's Ascend pool minus DELPHI's wash trading (the creator's own trades counted, as in round 1). `
        : `volume in the coin's Ascend pool, minus trades by the creator or wallets DELPHI links to the creator, minus DELPHI's wash trading. `) +
      `The top ${input.coins} share the basket in proportion to that volume, none above ${r.maxWeightBps / 100}%.`,
    excluded: verdicts
      .filter((v) => v.why !== null)
      .sort((a, b) => (realVolume(b.c) > realVolume(a.c) ? 1 : -1))
      .slice(0, 20)
      .map((v) => ({ symbol: v.c.symbol, token: v.c.token, why: v.why })),
    ranking: ranked.slice(0, Math.max(input.coins + 5, 10)).map((c) => ({
      symbol: c.symbol,
      token: c.token,
      verdict: c.verdict,
      usdcVolume: Number(c.usdcVolume),
      washVolume: Number(c.washUsdc),
      creatorVolume: Number(c.creatorUsdc),
      realVolume: Number(realVolume(c)),
      priceAverageAgeHours: hours(c.priceAverageAt),
      priceVsAveragePct: c.priceVsAveragePct,
      ...(c.headline ? { headline: c.headline } : {}),
    })),
    symbols: picked.map((c) => c.symbol),
    tokens: picked.map((c) => c.token),
    pools: picked.map((c) => c.poolId),
    weightsBps: w,
    perRunCaps: picked.map(() => Number(input.perRunCap)),
    /** Merkle root of one leaf per coin considered (see the tree file); proves each coin's row on its own. */
    merkleRoot: tree.root,
  };
  // What the basket's price check will do when the round can start (after the registry's wait).
  const startsAt = input.nowSec + r.delaySec;
  const warnings = picked.flatMap((c) => {
    const name = c.symbol ?? c.token;
    const out: string[] = [];
    if (c.priceAverageAt === null || startsAt - c.priceAverageAt > r.maxStaleSec) {
      out.push(`${name}: its price average will be older than ${r.maxStaleSec / 3600} h when the round can start, so the basket skips it until it trades`);
    }
    if (c.priceVsAveragePct !== null && c.priceVsAveragePct > r.bandBps / 100) {
      out.push(`${name}: its price is ${c.priceVsAveragePct}% above its average; the basket buys only within ${r.bandBps / 100}%, until the average catches up`);
    }
    return out;
  });
  return { file, tree, picked, warnings };
}

/** The exact bytes to publish: 2-space JSON and a final newline, like round 1. */
export const roundBytes = (file: Round["file"]) => `${JSON.stringify(file, null, 2)}\n`;
