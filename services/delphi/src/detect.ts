// The three detectors. Each is a pure function of one coin's data: same input, same finding.
// Thresholds live in RULES (config.ts) and are written into every report.
import type { Hex } from "viem";
import { RULES, TOTAL_SUPPLY } from "./config.ts";
import { clusters, isSystem, linksWithin } from "./graph.ts";
import type { CoinData, Finding, Link, Severity, Trade } from "./types.ts";

export type DetectorResult = { enough: boolean; finding: Finding | null };

const lc = (a: string) => a.toLowerCase();
/** a / b as a percentage with 2 decimals, exact until the last step. */
export const pct = (a: bigint, b: bigint) => (b === 0n ? 0 : Number((a * 10_000n) / b) / 100);
const grade = (v: number, t: { watchPct: number; flagPct: number }): Severity | null =>
  v >= t.flagPct ? "flag" : v >= t.watchPct ? "watch" : null;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const linkEvidence = (l: Link) => ({ what: `link: ${l.reason.replace("-", " ")} ${short(l.a)} ↔ ${short(l.b)}`, tx: l.evidence[0]! });

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(it);
  }
  return m;
}

/**
 * Launch bundle: linked wallets buying in the first seconds after launch. The creator's own
 * disclosed dev-buy alone is not a bundle; the creator plus linked early buyers is.
 */
export function detectBundle(d: CoinData): DetectorResult {
  const end = d.coin.launchTime + RULES.bundle.windowSec;
  const early = d.trades.filter((t) => t.side === "buy" && t.time <= end && !isSystem(d, t.holder));
  const buyers = new Set(early.map((t) => lc(t.holder)));
  // We always see the launch itself, so this check always has its data.
  if (buyers.size < 2) return { enough: true, finding: null };

  const cl = clusters(d.links, buyers);
  let worst: { members: Set<string>; tokens: bigint; trades: Trade[] } | null = null;
  for (const [, trades] of groupBy(early, (t) => cl.get(lc(t.holder))!)) {
    const members = new Set(trades.map((t) => lc(t.holder)));
    if (members.size < RULES.bundle.minLinkedWallets) continue;
    const tokens = trades.reduce((s, t) => s + t.tokens, 0n);
    if (!worst || tokens > worst.tokens) worst = { members, tokens, trades };
  }
  if (!worst) return { enough: true, finding: null };

  const share = pct(worst.tokens, TOTAL_SUPPLY);
  const severity = grade(share, RULES.bundle);
  if (!severity) return { enough: true, finding: null };
  const withCreator = worst.members.has(lc(d.coin.creator));
  return {
    enough: true,
    finding: {
      detector: "bundle",
      severity,
      summary: `${worst.members.size} linked wallets${withCreator ? ", including the creator," : ""} bought ${share}% of the supply within ${RULES.bundle.windowSec} s of launch.`,
      metrics: { linkedWallets: worst.members.size, supplyPct: share, earlyBuyers: buyers.size },
      evidence: [
        ...worst.trades.slice(0, 8).map((t) => ({ what: `${short(t.holder)} bought at launch`, tx: t.tx })),
        ...linksWithin(d.links, worst.members).map(linkEvidence),
      ],
    },
  };
}

/** Who a trade belongs to: the wallet whose tokens it moved. */
const actor = (t: Trade) => lc(t.holder);
const chrono = (a: Trade, b: Trade) => a.time - b.time || Number(a.block - b.block) || a.logIndex - b.logIndex;

/**
 * Wash trading: fast round trips. Each actor's trades (one wallet, or a linked cluster, so a ring
 * passing tokens around is one actor) are walked in time order, and every sell is matched against
 * that actor's buys from the last few minutes, by token amount (and the other way round). The matched
 * part is volume that changed nobody's position. Result: its share of all trading volume (in tokens).
 * A buy and a sell in one transaction but in two different pools is arbitrage (it moves prices
 * between pools back in line), not wash: those legs cancel out first and are never matched. Seen
 * live: bought in the Ascend pool for 14.7 USDC, sold the same tokens in an outside pool for 119.7.
 */
export function detectWash(d: CoinData): DetectorResult {
  const trades = d.trades.filter((t) => t.tokens > 0n && !isSystem(d, actor(t)));
  if (trades.length < RULES.wash.minTrades) return { enough: false, finding: null };
  // Measured in tokens, not quote: a coin can trade in pools priced in different currencies.
  const total = trades.reduce((s, t) => s + t.tokens, 0n);
  const matched = roundTrips(d);
  const washTokens = [...matched.values()].reduce((s, m) => s + m, 0n);
  const share = pct(washTokens, total);
  const severity = grade(share, RULES.wash);
  if (!severity) return { enough: true, finding: null };

  const washers = new Set([...matched.keys()].map(actor));
  const linked = linksWithin(d.links, washers);
  const minutes = RULES.wash.pairWindowSec / 60;
  return {
    enough: true,
    finding: {
      detector: "wash",
      severity,
      summary: `${share}% of trading volume is fast round trips: ${washers.size} wallet(s)${linked.length ? " (some linked)" : ""} bought and sold the same tokens back within ${minutes} minutes.`,
      metrics: { washVolumePct: share, roundTripWallets: washers.size, trades: trades.length, roundTripTrades: matched.size },
      evidence: [
        ...[...matched.keys()].sort(chrono).slice(0, 8).map((t) => ({ what: `${short(actor(t))} ${t.side}`, tx: t.tx })),
        ...linked.map(linkEvidence),
      ],
    },
  };
}

/**
 * The round-trip matching behind the wash check: for each trade, how many of its tokens were matched
 * by an opposite trade of the same actor within the window (arbitrage legs excluded). Also used by the
 * Trials to take wash volume out of a coin's real volume, exactly as the verdicts count it.
 */
export function roundTrips(d: CoinData): Map<Trade, bigint> {
  const trades = d.trades.filter((t) => t.tokens > 0n && !isSystem(d, actor(t)));
  const min = (a: bigint, b: bigint) => (a < b ? a : b);
  const cl = clusters(d.links, trades.map(actor));
  const matched = new Map<Trade, bigint>();
  for (const [, group] of groupBy(trades, (t) => cl.get(actor(t))!)) {
    const unmatched = new Map(group.map((t) => [t, t.tokens]));
    for (const legs of groupBy(group, (t) => lc(t.tx)).values()) {
      for (const b of legs.filter((t) => t.side === "buy")) {
        for (const s of legs.filter((t) => t.side === "sell" && lc(t.pool) !== lc(b.pool))) {
          const m = min(unmatched.get(b)!, unmatched.get(s)!);
          unmatched.set(b, unmatched.get(b)! - m);
          unmatched.set(s, unmatched.get(s)! - m);
        }
      }
    }
    const open: Array<{ t: Trade; left: bigint }> = [];
    for (const t of [...group].sort(chrono)) {
      let left = unmatched.get(t)!;
      for (const o of open) {
        if (left === 0n) break;
        if (o.left === 0n || o.t.side === t.side || t.time - o.t.time > RULES.wash.pairWindowSec) continue;
        if (o.t.tx === t.tx && lc(o.t.pool) !== lc(t.pool)) continue; // arbitrage, not wash
        const m = min(o.left, left);
        o.left -= m;
        left -= m;
        matched.set(o.t, (matched.get(o.t) ?? 0n) + m);
        matched.set(t, (matched.get(t) ?? 0n) + m);
      }
      open.push({ t, left });
    }
  }
  return matched;
}

/** Token balances of non-system wallets, replayed from Transfer events. */
export function balances(d: CoinData): Map<string, bigint> {
  const bal = new Map<string, bigint>();
  for (const t of d.transfers) {
    bal.set(lc(t.from), (bal.get(lc(t.from)) ?? 0n) - t.value);
    bal.set(lc(t.to), (bal.get(lc(t.to)) ?? 0n) + t.value);
  }
  for (const k of [...bal.keys()]) if (isSystem(d, k) || bal.get(k)! <= 0n) bal.delete(k);
  return bal;
}

/**
 * What contracts (not pools) hold, as a share of all tokens outside the pools, when it is big enough
 * to matter. DELPHI judges wallets, so supply parked in a contract is said out loud, not hidden.
 */
export function contractHoldings(d: CoinData): { share: number; top: Array<{ contract: string; pct: number }> } | null {
  if (!d.contracts?.size) return null;
  const all = new Map<string, bigint>();
  for (const t of d.transfers) {
    all.set(lc(t.from), (all.get(lc(t.from)) ?? 0n) - t.value);
    all.set(lc(t.to), (all.get(lc(t.to)) ?? 0n) + t.value);
  }
  const held = [...d.contracts].map((c) => ({ c, v: all.get(c) ?? 0n })).filter((x) => x.v > 0n).sort((a, b) => (b.v > a.v ? 1 : b.v < a.v ? -1 : 0));
  const inContracts = held.reduce((s, x) => s + x.v, 0n);
  const outside = inContracts + [...balances(d).values()].reduce((s, v) => s + v, 0n);
  if (inContracts === 0n) return null;
  const share = pct(inContracts, outside);
  if (share < RULES.contracts.notePct) return null;
  return { share, top: held.slice(0, 3).map((x) => ({ contract: x.c, pct: pct(x.v, outside) })) };
}

/** The last transaction that sent tokens to a wallet (where its balance can be checked). */
function lastIn(d: CoinData, w: string): Hex | null {
  for (let i = d.transfers.length - 1; i >= 0; i--) if (lc(d.transfers[i]!.to) === w) return d.transfers[i]!.tx;
  return null;
}

/** Hidden concentration: linked wallets that together hold much of what is in circulation. */
export function detectConcentration(d: CoinData): DetectorResult {
  const bal = balances(d);
  if (bal.size < RULES.concentration.minHolders) return { enough: false, finding: null };
  const circulating = [...bal.values()].reduce((s, v) => s + v, 0n);
  const cl = clusters(d.links, bal.keys());
  let worst: { members: string[]; held: bigint } | null = null;
  for (const [, members] of groupBy([...bal.keys()], (w) => cl.get(w)!)) {
    if (members.length < 2) continue;
    const held = members.reduce((s, w) => s + bal.get(w)!, 0n);
    if (!worst || held > worst.held) worst = { members, held };
  }
  if (!worst) return { enough: true, finding: null };
  const share = pct(worst.held, circulating);
  const severity = grade(share, RULES.concentration);
  if (!severity) return { enough: true, finding: null };
  return {
    enough: true,
    finding: {
      detector: "concentration",
      severity,
      summary: `${worst.members.length} linked wallets hold ${share}% of the tokens held by all ${bal.size} holders.`,
      metrics: { linkedWallets: worst.members.length, circulatingPct: share, holders: bal.size },
      evidence: [
        ...worst.members.slice(0, 8).map((w) => ({ what: `${short(w)} holds ${pct(bal.get(w)!, circulating)}%`, tx: lastIn(d, w) })),
        ...linksWithin(d.links, new Set(worst.members)).map(linkEvidence),
      ].filter((e): e is { what: string; tx: Hex } => e.tx !== null),
    },
  };
}
