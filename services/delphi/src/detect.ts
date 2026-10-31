// The three detectors. Each is a pure function of one coin's data: same input, same finding.
// Thresholds live in RULES (config.ts) and are written into every report.
import type { Hex } from "viem";
import { RULES, supplyOf } from "./config.ts";
import { clusters, groupEvidence, groupsOf, isSystem, linksWithin, type Group } from "./graph.ts";
import type { CoinData, Finding, Link, Severity, Trade } from "./types.ts";

/** `notes`: what the check saw that is context, not cheating (v0.5): a crowd farming, a treasury, an outside whale. */
export type DetectorResult = { enough: boolean; finding: Finding | null; notes?: string[] };

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
 * disclosed dev-buy alone is not a bundle; the creator plus linked early buyers is. Linked means one
 * group (v0.3): one funder's star, or wallets that passed tokens or trades between them.
 */
export function detectBundle(d: CoinData): DetectorResult {
  const end = d.coin.launchTime + RULES.bundle.windowSec;
  const early = d.trades.filter((t) => t.side === "buy" && t.time <= end && !isSystem(d, t.holder));
  const buyers = new Set(early.map((t) => lc(t.holder)));
  // We always see the launch itself, so this check always has its data.
  if (buyers.size < 2) return { enough: true, finding: null };

  let worst: { members: Set<string>; tokens: bigint; trades: Trade[]; group: Group } | null = null;
  for (const group of groupsOf(d.links)) {
    const trades = early.filter((t) => group.members.has(lc(t.holder)));
    const members = new Set(trades.map((t) => lc(t.holder)));
    if (members.size < RULES.bundle.minLinkedWallets) continue;
    const tokens = trades.reduce((s, t) => s + t.tokens, 0n);
    if (!worst || tokens > worst.tokens) worst = { members, tokens, trades, group };
  }
  if (!worst) return { enough: true, finding: null };

  const share = pct(worst.tokens, supplyOf(d.coin));
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
        ...groupEvidence(worst.group, worst.members).map(linkEvidence),
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
  if (trades.length < RULES.wash.minTrades || new Set(trades.map(actor)).size < RULES.wash.minWallets) return { enough: false, finding: null };
  // Measured in tokens, not quote: a coin can trade in pools priced in different currencies.
  const total = trades.reduce((s, t) => s + t.tokens, 0n);
  const matched = roundTrips(d);
  const washTokens = [...matched.values()].reduce((s, m) => s + m, 0n);
  const share = pct(washTokens, total);
  if (!grade(share, RULES.wash)) return { enough: true, finding: null };

  // Who makes the round trips (v0.5): a crowd of separate wallets, a ring of linked ones (or the
  // creator), or one or two unlinked bots. Only a ring or the creator is cheating; the rest is context.
  const minutes = RULES.wash.pairWindowSec / 60;
  const testnet = d.network === "testnet";
  const cl = clusters(d.links, [...matched.keys()].map(actor));
  const team = new Set([lc(d.coin.creator), lc(d.coin.launcher)]);
  const actors = new Map<string, { tokens: bigint; wallets: Set<string>; trades: Trade[] }>();
  for (const [t, m] of matched) {
    const root = cl.get(actor(t)) ?? actor(t);
    const a = actors.get(root) ?? { tokens: 0n, wallets: new Set<string>(), trades: [] };
    a.tokens += m;
    a.wallets.add(actor(t));
    a.trades.push(t);
    actors.set(root, a);
  }
  const ranked = [...actors.values()].sort((x, y) => (y.tokens > x.tokens ? 1 : y.tokens < x.tokens ? -1 : 0));
  const top = ranked.slice(0, RULES.wash.crowd.topActors).reduce((s, a) => s + a.tokens, 0n);
  if (pct(top, washTokens) < RULES.wash.crowd.sharePct) {
    return {
      enough: true,
      finding: null,
      notes: [
        `${share}% of trading volume is quick round trips, spread over ${ranked.length} separate wallets or groups: ` +
          (testnet ? "people farming points with test money, not one actor faking volume." : "many traders flipping, not one actor faking volume."),
      ],
    };
  }
  const ring = ranked.filter((a) => a.wallets.size >= 2 || [...a.wallets].some((w) => team.has(w)));
  const solo = ranked.filter((a) => !ring.includes(a));
  const ringShare = pct(ring.reduce((s, a) => s + a.tokens, 0n), total);
  const ringSeverity = grade(ringShare, RULES.wash);
  if (ringSeverity) {
    const washers = new Set(ring.flatMap((a) => [...a.wallets]));
    const withCreator = [...washers].some((w) => team.has(w));
    return {
      enough: true,
      finding: {
        detector: "wash",
        severity: ringSeverity,
        summary: `${ringShare}% of trading volume is fast round trips by ${washers.size} linked wallet(s)${withCreator ? ", the creator among them," : ""} buying and selling the same tokens back within ${minutes} minutes.`,
        metrics: { washVolumePct: ringShare, roundTripWallets: washers.size, trades: trades.length, roundTripTrades: ring.reduce((s, a) => s + a.trades.length, 0) },
        evidence: [
          ...ring.flatMap((a) => a.trades).sort(chrono).slice(0, 8).map((t) => ({ what: `${short(actor(t))} ${t.side}`, tx: t.tx })),
          ...linksWithin(d.links, washers).map(linkEvidence),
        ],
      },
    };
  }
  const soloShare = pct(solo.reduce((s, a) => s + a.tokens, 0n), total);
  const soloWallets = solo.slice(0, RULES.wash.crowd.topActors).length;
  const line = `${soloShare}% of trading volume is ${soloWallets === 1 ? "one wallet" : `${soloWallets} unlinked wallets`} buying and selling the same tokens back within ${minutes} minutes: that volume is not real demand.`;
  // Not tied to the creator or to each other: a bot or a farmer. On mainnet worth watching, never a flag.
  if (testnet || !grade(soloShare, RULES.wash)) return { enough: true, finding: null, notes: [`${line}${testnet ? " On testnet, most likely a bot farming points." : ""}`] };
  return {
    enough: true,
    finding: {
      detector: "wash",
      severity: "watch",
      summary: line,
      metrics: { washVolumePct: soloShare, roundTripWallets: soloWallets, trades: trades.length, roundTripTrades: solo.reduce((s, a) => s + a.trades.length, 0) },
      evidence: solo.flatMap((a) => a.trades).sort(chrono).slice(0, 8).map((t) => ({ what: `${short(actor(t))} ${t.side}`, tx: t.tx })),
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
        // v0.5: a buy in one pool and a sell in another is arbitrage, even in two transactions (seen live:
        // bots moving stKALOS between its Kalos pools made 92% of what looked like its wash).
        if (lc(o.t.pool) !== lc(t.pool)) continue;
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

/** Every address's balance: read from the token when the coin has `holdings`, else replayed from Transfer events. */
function allBalances(d: CoinData): Map<string, bigint> {
  if (d.holdings) return new Map(d.holdings);
  const all = new Map<string, bigint>();
  for (const t of d.transfers) {
    all.set(lc(t.from), (all.get(lc(t.from)) ?? 0n) - t.value);
    all.set(lc(t.to), (all.get(lc(t.to)) ?? 0n) + t.value);
  }
  return all;
}

/** Token balances of non-system wallets. */
export function balances(d: CoinData): Map<string, bigint> {
  const bal = allBalances(d);
  for (const k of [...bal.keys()]) if (isSystem(d, k) || bal.get(k)! <= 0n) bal.delete(k);
  return bal;
}

/**
 * What contracts (not pools) hold, as a share of all tokens outside the pools, when it is big enough
 * to matter. DELPHI judges wallets, so supply parked in a contract is said out loud, not hidden.
 */
export function contractHoldings(d: CoinData): { share: number; top: Array<{ contract: string; pct: number }> } | null {
  if (!d.contracts?.size) return null;
  const all = allBalances(d);
  const held = [...d.contracts].map((c) => ({ c, v: all.get(c) ?? 0n })).filter((x) => x.v > 0n).sort((a, b) => (b.v > a.v ? 1 : b.v < a.v ? -1 : 0));
  const inContracts = held.reduce((s, x) => s + x.v, 0n);
  const outside = inContracts + [...balances(d).values()].reduce((s, v) => s + v, 0n);
  if (inContracts === 0n) return null;
  const share = pct(inContracts, outside);
  if (share < RULES.contracts.notePct) return null;
  return { share, top: held.slice(0, 3).map((x) => ({ contract: x.c, pct: pct(x.v, outside) })) };
}

/**
 * The biggest single wallet, when it alone holds a big share of the whole supply (RULES.concentration
 * singleWatchPct). Measured against the total supply, not the tokens in wallets, so a thin coin whose
 * first buyer holds most of a small float is not caught by it. Says who the wallet is when DELPHI knows
 * (the creator, a project's own wallet, an outside whale). `finding` is the mainnet WATCH; `note`, the line.
 */
function singleHolder(d: CoinData, bal: ReadonlyMap<string, bigint>): { wallet: string; note: string; finding: Finding | null } | null {
  let top: [string, bigint] | null = null;
  for (const [w, v] of bal) if (!top || v > top[1]) top = [w, v];
  if (!top) return null;
  const share = pct(top[1], supplyOf(d.coin));
  if (share < RULES.concentration.singleWatchPct) return null;
  const isCreator = top[0] === lc(d.coin.creator);
  const role = d.roles?.get(top[0]);
  const who = isCreator ? "The creator's wallet" : "One wallet";
  const what = role ? ` It ${role.says}.` : "";
  const line = `${who} holds ${share}% of the total supply.${what}`;
  const testnet = d.network === "testnet";
  const context =
    role?.kind === "project" || role?.kind === "sink"
      ? " That is the project's own supply, not a hidden whale; it can still be sold."
      : role?.kind === "whale"
        ? " An outside trader, not this coin's team."
        : testnet && isCreator
          ? " On testnet, makers often keep their test coins."
          : "";
  const tx = lastIn(d, top[0]);
  return {
    wallet: lc(top[0]),
    note: `${line}${context}`,
    finding: {
      detector: "concentration",
      severity: "watch",
      summary: `${line} It can sell at any time.`,
      metrics: { singleWalletPct: share, isCreator: isCreator ? "yes" : "no", holders: bal.size },
      evidence: tx ? [{ what: `${short(top[0])} holds ${share}% of the supply`, tx }] : [],
    },
  };
}

/** The last transaction that sent tokens to a wallet (where its balance can be checked). */
function lastIn(d: CoinData, w: string): Hex | null {
  for (let i = d.transfers.length - 1; i >= 0; i--) if (lc(d.transfers[i]!.to) === w) return d.transfers[i]!.tx;
  return null;
}

/**
 * Hidden concentration: linked wallets that together hold much of what is in circulation. The share is
 * measured per group (v0.3): one funder's star, or wallets that passed tokens or trades between them,
 * never a chain of different funders.
 */
export function detectConcentration(d: CoinData): DetectorResult {
  const bal = balances(d);
  const single = singleHolder(d, bal);
  const traded = d.trades.filter((t) => t.tokens > 0n && !isSystem(d, actor(t))).length;
  if (bal.size < RULES.concentration.minHolders || traded < RULES.concentration.minTrades) {
    return { enough: false, finding: null, ...(single ? { notes: [single.note] } : {}) };
  }
  const circulating = [...bal.values()].reduce((s, v) => s + v, 0n);
  // Hidden whales are wallets that look separate but are one actor. The creator's own wallet is out in
  // the open, so what it holds is not hidden (v0.5): it's said apart, as one wallet's share.
  const creator = lc(d.coin.creator);
  let pick: { members: string[]; held: bigint; hidden: bigint; group: Group } | null = null;
  for (const group of groupsOf(d.links)) {
    const members = [...group.members].filter((w) => bal.has(w)).sort((a, b) => (bal.get(b)! > bal.get(a)! ? 1 : bal.get(b)! < bal.get(a)! ? -1 : 0));
    if (members.length < 2) continue;
    const held = members.reduce((s, w) => s + bal.get(w)!, 0n);
    const hidden = held - (members.includes(creator) ? bal.get(creator)! : 0n);
    if (!pick || hidden > pick.hidden) pick = { members, held, hidden, group };
  }
  const share = pick ? pct(pick.hidden, circulating) : 0;
  const severity = pick ? grade(share, RULES.concentration) : null;
  const notes = single ? [single.note] : [];
  if (pick && severity) {
    const withCreator = pick.members.includes(creator);
    const n = withCreator ? pick.members.length - 1 : pick.members.length;
    return {
      enough: true,
      notes,
      finding: {
        detector: "concentration",
        severity,
        summary: withCreator
          ? `${n} wallet(s) linked to the creator hold ${share}% of the tokens held by all ${bal.size} holders, on top of what the creator holds.`
          : `${n} linked wallets hold ${share}% of the tokens held by all ${bal.size} holders.`,
        metrics: { linkedWallets: n, circulatingPct: share, holders: bal.size },
        evidence: [
          ...pick.members.slice(0, 8).map((w) => ({ what: `${short(w)} holds ${pct(bal.get(w)!, circulating)}%`, tx: lastIn(d, w) })),
          ...groupEvidence(pick.group, new Set(pick.members)).map(linkEvidence),
        ].filter((e): e is { what: string; tx: Hex } => e.tx !== null),
      },
    };
  }
  // One big wallet is a risk to know, not cheating: WATCH on mainnet, a note on testnet (v0.5).
  if (single && single.finding && d.network !== "testnet") return { enough: true, finding: single.finding };
  return { enough: true, finding: null, notes };
}
