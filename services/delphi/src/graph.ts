// Linking wallets into clusters: addresses that behave as one actor. Every link carries the
// transactions that show it. Public hubs (faucets, bridges, exchanges) never link anyone.
import type { Address, Hex } from "viem";
import { KNOWN_HUBS, RULES } from "./config.ts";
import type { CoinData, Funding, Link, TokenTransfer, Trade } from "./types.ts";

const lc = (a: string) => a.toLowerCase();

/**
 * Funders that are public infrastructure: listed faucets, or anything with a huge transaction count.
 * Linking through them would make every faucet user "one sybil ring" (on testnet that is everyone).
 */
export function findHubs(txCounts: ReadonlyMap<string, number>): Set<string> {
  const hubs = new Set(KNOWN_HUBS.map(lc));
  for (const [addr, n] of txCounts) if (n >= RULES.hub.minTxCount) hubs.add(lc(addr));
  return hubs;
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

  // Funding: a shared private funder links the funded wallets; an actor funding another links them.
  const byFunder = new Map<string, Funding[]>();
  for (const f of input.fundings) {
    if (!actors.has(lc(f.wallet)) || ignore(f.funder) || lc(f.funder) === lc(f.wallet)) continue;
    if (actors.has(lc(f.funder))) links.push({ a: f.funder, b: f.wallet, reason: "funded-by", evidence: [f.tx] });
    const k = lc(f.funder);
    if (!byFunder.has(k)) byFunder.set(k, []);
    byFunder.get(k)!.push(f);
  }
  for (const group of byFunder.values()) {
    const first = new Map<string, Funding>();
    for (const f of group) if (!first.has(lc(f.wallet))) first.set(lc(f.wallet), f);
    const fs = [...first.values()];
    for (let i = 1; i < fs.length; i++) {
      links.push({ a: fs[0]!.wallet, b: fs[i]!.wallet, reason: "shared-funder", via: fs[0]!.funder, evidence: [fs[0]!.tx, fs[i]!.tx] });
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

/** Union-find over links: wallet (lowercase) → cluster id (the cluster's smallest address). */
export function clusters(links: Link[], wallets: Iterable<string> = []): Map<string, string> {
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
  const add = (x: string) => {
    if (!parent.has(x)) parent.set(x, x);
  };
  for (const w of wallets) add(lc(w));
  for (const l of links) {
    const a = lc(l.a);
    const b = lc(l.b);
    add(a);
    add(b);
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  }
  const out = new Map<string, string>();
  for (const x of parent.keys()) out.set(x, find(x));
  return out;
}

/** The links that hold a set of wallets together (for evidence), capped to keep reports readable. */
export function linksWithin(links: Link[], members: ReadonlySet<string>, cap = 6): Link[] {
  return links.filter((l) => members.has(lc(l.a)) && members.has(lc(l.b))).slice(0, cap);
}

export const isSystem = (d: Pick<CoinData, "system">, a: string) => d.system.has(lc(a));
