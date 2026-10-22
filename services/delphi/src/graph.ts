// Linking wallets into groups: addresses that behave as one actor. Every link carries the
// transactions that show it. Public hubs (faucets, bridges, exchanges) never link anyone.
//
// Rules v0.3: a group is ONE funder's own star of wallets, or wallets that moved tokens or trades
// straight between each other. Two groups are never chained together through a wallet they share:
// on a farmed testnet, chaining joined dozens of separate farmers into one "group" through wallets
// that had each been paid by several of them.
import type { Address, Hex } from "viem";
import type { TxCall } from "./chain.ts";
import { KNOWN_HUBS, MULTISEND_SELECTORS, RULES, type Network } from "./config.ts";
import type { CoinData, Funding, FundingKind, Link, LinkReason, TokenTransfer, Trade } from "./types.ts";

const lc = (a: string) => a.toLowerCase();

/** For one funder: how many tracked wallets it paid HYPE to, and how many different coins they traded. */
export type Payees = { wallets: number; coins: number };

/**
 * Funders that are public infrastructure: listed faucets, or anything with a huge transaction count.
 * Linking through them would make every faucet user "one sybil ring" (on testnet that is everyone).
 * On testnet (v0.3), also any wallet that paid tracked wallets which went on to trade many different
 * coins: a distribution bot or a farm, not one coin's insider.
 */
export function findHubs(
  txCounts: ReadonlyMap<string, number>,
  opts: { network?: Network; payees?: ReadonlyMap<string, Payees> } = {},
): Set<string> {
  const hubs = new Set(KNOWN_HUBS.map(lc));
  for (const [addr, n] of txCounts) if (n >= RULES.hub.minTxCount) hubs.add(lc(addr));
  if (opts.network === "testnet") {
    const spread = RULES.hub.testnetFanout;
    for (const [addr, p] of opts.payees ?? []) if (p.wallets >= spread.wallets && p.coins >= spread.coins) hubs.add(lc(addr));
  }
  return hubs;
}

/**
 * What kind of payment a funding is. A contract's payout counts as the caller's own funding only when
 * the call was a multi-send (a function whose job is sending HYPE to many addresses), the sender put HYPE
 * in, and the multi-send contract itself paid. Anything else a contract paid is a sale, a game win or a
 * refund. `payer`: the contract that paid it; `call`: the transaction's call, if known.
 */
export function fundingKind(via: "tx" | "internal", payer: string, call: TxCall | undefined): FundingKind {
  if (via === "tx") return "transfer";
  const multisend = call !== undefined && MULTISEND_SELECTORS.has(call.selector) && call.to === lc(payer) && BigInt(call.value) > 0n;
  return multisend ? "multisend" : "payout";
}

/**
 * Who each funder paid: the number of tracked wallets, and the number of different coins those wallets
 * traded (`traded`: wallet → coins it bought or sold). Coins the funder launched itself (`launched`:
 * creator or launcher → coins) don't count: a creator whose wallets buy each of its own launches is
 * running rings, not spreading wallets around. Input for the testnet hub rule.
 */
export function payeesOf(
  fundings: Iterable<Funding>,
  traded: ReadonlyMap<string, ReadonlySet<string>>,
  launched: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
): Map<string, Payees> {
  const paid = new Map<string, Set<string>>();
  for (const f of fundings) {
    if (lc(f.funder) === lc(f.wallet)) continue;
    const k = lc(f.funder);
    if (!paid.has(k)) paid.set(k, new Set());
    paid.get(k)!.add(lc(f.wallet));
  }
  const out = new Map<string, Payees>();
  for (const [f, ws] of paid) {
    const coins = new Set<string>();
    const own = launched.get(f);
    for (const w of ws) for (const c of traded.get(w) ?? []) if (!own?.has(c)) coins.add(c);
    out.set(f, { wallets: ws.size, coins: coins.size });
  }
  return out;
}

/** Every non-system wallet that traded, received a buy, or moved the token. */
export function actorsOf(trades: Trade[], transfers: TokenTransfer[], system: ReadonlySet<string>): Set<Address> {
  const out = new Map<string, Address>();
  const add = (a: Address) => {
    if (!system.has(lc(a))) out.set(lc(a), a);
  };
  for (const t of trades) {
    add(t.trader);
    add(t.holder);
  }
  for (const t of transfers) {
    add(t.from);
    add(t.to);
  }
  return new Set(out.values());
}

/** All links among one coin's actors, from funding, direct token passes and "bought for" trades. */
export function buildLinks(input: {
  actors: Iterable<Address>;
  creator: Address;
  launcher: Address;
  launchTx: Hex;
  trades: Trade[];
  transfers: TokenTransfer[];
  fundings: Funding[];
  hubs: ReadonlySet<string>;
  system: ReadonlySet<string>;
}): Link[] {
  const { hubs, system } = input;
  const ignore = (a: string) => hubs.has(lc(a)) || system.has(lc(a));
  const actors = new Set([...input.actors].map(lc));
  const links: Link[] = [];

  if (lc(input.creator) !== lc(input.launcher)) {
    links.push({ a: input.launcher, b: input.creator, reason: "is-creator", evidence: [input.launchTx] });
  }

  // Funding: plain transfers and multi-sends. Any other contract payout is a sale, a game win or a refund
  // (seen live: a marketplace paying sellers 88% of a round price, coin-flip and game payouts sent by the
  // games' own bots) and links no one, unless the coin's own creator or launcher sent that transaction.
  const team = new Set([lc(input.creator), lc(input.launcher)]);
  const counts = (f: Funding) => f.kind !== "payout" || team.has(lc(f.funder));
  // A coin's own creator or launcher is never a public hub for that coin, however busy it is elsewhere.
  const publicFunder = (a: string) => system.has(lc(a)) || (hubs.has(lc(a)) && !team.has(lc(a)));
  // One payment per funder and wallet (the first), so repeated top-ups don't repeat the link.
  const byFunder = new Map<string, Map<string, Funding>>();
  for (const f of input.fundings) {
    if (!actors.has(lc(f.wallet)) || publicFunder(f.funder) || lc(f.funder) === lc(f.wallet) || !counts(f)) continue;
    const k = lc(f.funder);
    if (!byFunder.has(k)) byFunder.set(k, new Map());
    const paid = byFunder.get(k)!;
    if (!paid.has(lc(f.wallet))) paid.set(lc(f.wallet), f);
  }
  for (const [k, paid] of byFunder) {
    const fs = [...paid.values()];
    // An actor funding another links them; a shared private funder links the funded wallets.
    if (actors.has(k)) for (const f of fs) links.push({ a: f.funder, b: f.wallet, reason: "funded-by", evidence: [f.tx] });
    for (let i = 1; i < fs.length; i++) {
      const [x, y] = [fs[0]!, fs[i]!];
      links.push({ a: x.wallet, b: y.wallet, reason: "shared-funder", via: x.funder, evidence: [x.tx, y.tx] });
    }
  }

  // Tokens handed directly from one wallet to another (not through the pool or a router).
  for (const t of input.transfers) {
    if (ignore(t.from) || ignore(t.to) || lc(t.from) === lc(t.to)) continue;
    links.push({ a: t.from, b: t.to, reason: "token-pass", evidence: [t.tx] });
  }

  // One wallet sending a trade that moves another wallet's tokens (a buy delivered elsewhere, or a sell
  // of someone else's tokens, which needs their approval).
  for (const tr of input.trades) {
    if (lc(tr.trader) !== lc(tr.holder) && !ignore(tr.holder) && !ignore(tr.trader)) {
      links.push({ a: tr.trader, b: tr.holder, reason: tr.side === "buy" ? "bought-for" : "sold-for", evidence: [tr.tx] });
    }
  }
  return links;
}

/** Links between two wallets directly: tokens or a trade moved from one to the other, or the launch named the other. */
const PAIR: ReadonlySet<LinkReason> = new Set(["token-pass", "bought-for", "sold-for", "is-creator"]);

/**
 * A set of wallets DELPHI treats as one actor. `anchor`: the funder whose star it is, or the smallest
 * address of a set joined by direct token or trade links. `links`: the links that make the group.
 */
export type Group = { anchor: string; members: Set<string>; links: Link[] };

/**
 * The groups behind a coin's links (v0.3). Wallets that moved tokens or trades straight between each
 * other join transitively. Each funder's star (the wallets it paid, plus itself if it is on the coin) is
 * one group, widened by those direct links, and never chained to another funder's star through a wallet
 * both paid. Groups can overlap; each one stands on its own evidence.
 */
export function groupsOf(links: Link[]): Group[] {
  const pairs = links.filter((l) => PAIR.has(l.reason));
  const root = unionFind(pairs);
  const comps = new Map<string, { members: Set<string>; links: Link[] }>();
  for (const [w, r] of root) {
    if (!comps.has(r)) comps.set(r, { members: new Set(), links: [] });
    comps.get(r)!.members.add(w);
  }
  for (const l of pairs) comps.get(root.get(lc(l.a))!)!.links.push(l);

  const stars = new Map<string, { members: Set<string>; links: Link[] }>();
  for (const l of links) {
    if (PAIR.has(l.reason)) continue;
    const anchor = lc(l.via ?? l.a);
    if (!stars.has(anchor)) stars.set(anchor, { members: new Set(), links: [] });
    const s = stars.get(anchor)!;
    for (const w of [l.a, l.b]) s.members.add(lc(w));
    s.links.push(l);
  }
  const widen = (seed: Set<string>, base: Link[]) => {
    const members = new Set<string>();
    const out = [...base];
    const seen = new Set<string>();
    for (const w of seed) {
      const r = root.get(w);
      if (r === undefined) {
        members.add(w);
        continue;
      }
      if (seen.has(r)) continue;
      seen.add(r);
      const c = comps.get(r)!;
      for (const m of c.members) members.add(m);
      out.push(...c.links);
    }
    return { members, links: out };
  };

  const groups: Group[] = [];
  for (const [anchor, s] of stars) groups.push({ anchor, ...widen(s.members, s.links) });
  for (const [r, c] of comps) if (c.members.size >= 2) groups.push({ anchor: r, members: new Set(c.members), links: [...c.links] });
  return groups;
}

/** Union-find over links: wallet (lowercase) → its set's smallest address. */
function unionFind(links: Link[]): Map<string, string> {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = x;
    while (parent.get(c) !== r) {
      const n = parent.get(c)!;
      parent.set(c, r);
      c = n;
    }
    return r;
  };
  for (const l of links) {
    const [a, b] = [lc(l.a), lc(l.b)];
    for (const x of [a, b]) if (!parent.has(x)) parent.set(x, x);
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  }
  const out = new Map<string, string>();
  for (const x of parent.keys()) out.set(x, find(x));
  return out;
}

/**
 * Each wallet's actor (wallet, lowercase → cluster id, the smallest address in its cluster), for checks
 * that need every wallet in exactly one place (wash trading, people counts). Built from the groups,
 * biggest first: a wallet in two funders' stars goes to the bigger one, and the stars stay apart.
 */
export function clusters(links: Link[], wallets: Iterable<string> = []): Map<string, string> {
  const groups = groupsOf(links)
    .sort((x, y) => y.members.size - x.members.size || (x.anchor < y.anchor ? -1 : x.anchor > y.anchor ? 1 : 0));
  const out = new Map<string, string>();
  for (const g of groups) {
    const free = [...g.members].filter((m) => !out.has(m));
    if (free.length === 0) continue;
    const id = free.reduce((m, x) => (x < m ? x : m));
    for (const m of free) out.set(m, id);
  }
  for (const w of wallets) if (!out.has(lc(w))) out.set(lc(w), lc(w));
  for (const l of links) for (const w of [lc(l.a), lc(l.b)]) if (!out.has(w)) out.set(w, w);
  return out;
}

/**
 * How many different actors are behind a coin: every wallet that traded, held or moved it, with
 * linked wallets (one private gas funder, tokens passed between them…) counted once. A faucet
 * that funded everyone links no one, so this is an upper bound on the number of people.
 */
export function peopleOf(d: CoinData): { wallets: number; people: number } {
  const wallets = [...actorsOf(d.trades, d.transfers, d.system)].map(lc);
  const cl = clusters(d.links, wallets);
  return { wallets: wallets.length, people: new Set(wallets.map((w) => cl.get(w))).size };
}

/** The links that hold a set of wallets together (for evidence), capped to keep reports readable. */
export function linksWithin(links: Link[], members: ReadonlySet<string>, cap = 6): Link[] {
  return links.filter((l) => members.has(lc(l.a)) && members.has(lc(l.b))).slice(0, cap);
}

/**
 * Evidence for a group narrowed to some of its members (the early buyers, the holders): links between
 * two of them first, then links that reach one of them.
 */
export function groupEvidence(g: Group, members: ReadonlySet<string>, cap = 6): Link[] {
  const touches = (l: Link) => Number(members.has(lc(l.a))) + Number(members.has(lc(l.b)));
  return g.links
    .filter((l) => touches(l) > 0)
    .sort((x, y) => touches(y) - touches(x))
    .slice(0, cap);
}

export const isSystem = (d: Pick<CoinData, "system">, a: string) => d.system.has(lc(a));
