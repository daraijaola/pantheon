// The explainer's tools: read-only views over one DELPHI scan. Answers are plain JSON with amounts
// already in human units and the transactions behind each fact, so the model can be concrete
// without doing arithmetic on raw integers. No tool writes, signs, or touches the network.
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { formatUnits, isAddress, isHash } from "viem";
import { z } from "zod";
import { RULES, TOTAL_SUPPLY } from "../config.ts";
import { balances, pct } from "../detect.ts";
import { actorsOf, clusters as clusterMap, isSystem, linksWithin } from "../graph.ts";
import type { CoinData, Link, LinkReason, Trade, Verdict } from "../types.ts";
import type { Currency, Workspace } from "./workspace.ts";

const lc = (a: string) => a.toLowerCase();
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const iso = (t: number) => new Date(t * 1000).toISOString().replace(".000Z", "Z");
const sum = (vs: Iterable<bigint>) => [...vs].reduce((s, v) => s + v, 0n);

/** A human amount: "12,345,678.9", or 4 significant digits below 1. */
export function amount(v: bigint, decimals = 18): string {
  const n = Number(formatUnits(v, decimals));
  return n.toLocaleString("en-US", n !== 0 && Math.abs(n) < 1 ? { maximumSignificantDigits: 4 } : { maximumFractionDigits: 2 });
}

/** Text the coin's creator chose: control and bidi characters stripped, length capped. Still untrusted. */
const untrusted = (s: string | null) => (s ? [...s.replace(/[\p{Cc}\p{Cf}]/gu, "")].slice(0, 40).join("") : null);

export class ToolInputError extends Error {
  override name = "ToolInputError";
}

function coinOf(ws: Workspace, token: string): CoinData {
  if (!isAddress(token, { strict: false })) throw new ToolInputError(`${token} is not an address`);
  const d = ws.coins.get(lc(token));
  if (!d) throw new ToolInputError(`${token} is not a coin in this scan (use list_coins)`);
  return d;
}

function reportOf(ws: Workspace, d: CoinData) {
  const r = ws.reports.get(lc(d.coin.token));
  if (!r) throw new ToolInputError(`no report for ${d.coin.token}`);
  return r;
}

/** The currency on the other side of the coin in a pool (USDC in an Ascend pool, anything outside). */
function quoteOf(ws: Workspace, d: CoinData, pool: string): Currency | null {
  const pair = ws.pools.get(lc(pool));
  if (!pair) return null;
  return lc(pair[0].address) === lc(d.coin.token) ? pair[1] : pair[0];
}

function priceText(ws: Workspace, d: CoinData, t: Trade): string {
  const q = quoteOf(ws, d, t.pool);
  return q ? `${amount(t.quote, q.decimals)} ${q.symbol}` : `${t.quote} (raw units of an unknown currency)`;
}

function tradeRow(ws: Workspace, d: CoinData, t: Trade) {
  return {
    tx: t.tx,
    time: iso(t.time),
    secondsAfterLaunch: t.time - d.coin.launchTime,
    side: t.side,
    wallet: t.holder,
    ...(lc(t.trader) !== lc(t.holder) ? { sentBy: t.trader } : {}),
    tokens: amount(t.tokens),
    pctOfSupply: pct(t.tokens, TOTAL_SUPPLY),
    [t.side === "buy" ? "paid" : "received"]: priceText(ws, d, t),
    pool: t.outside ? "outside Ascend (no Ascend fee)" : "Ascend",
  };
}

const MEANING: Record<LinkReason, string> = {
  "shared-funder": "both got HYPE from the same private wallet (`via`)",
  "funded-by": "`a` sent HYPE to `b`",
  "token-pass": "`a` sent tokens straight to `b`, not through a pool",
  "bought-for": "`a` paid for a buy whose tokens went to `b`",
  "sold-for": "`a` sent a sell of `b`'s tokens",
  "is-creator": "`a` sent the launch but named `b` as the creator",
};

const linkRow = (l: Link) => ({ a: l.a, b: l.b, reason: l.reason, meaning: MEANING[l.reason], ...(l.via ? { via: l.via } : {}), evidence: l.evidence });

/** Buys and sells summed per currency: what was spent and received. */
function volume(ws: Workspace, d: CoinData, trades: Trade[]) {
  const by = new Map<string, { currency: Currency | null; spent: bigint; received: bigint }>();
  for (const t of trades) {
    const q = quoteOf(ws, d, t.pool);
    const k = q ? lc(q.address) : "?";
    const cur = by.get(k) ?? { currency: q, spent: 0n, received: 0n };
    if (t.side === "buy") cur.spent += t.quote;
    else cur.received += t.quote;
    by.set(k, cur);
  }
  return [...by.values()].map(({ currency: q, spent, received }) => ({
    currency: q?.symbol ?? "unknown",
    spentOnBuys: q ? amount(spent, q.decimals) : spent.toString(),
    receivedFromSells: q ? amount(received, q.decimals) : received.toString(),
  }));
}

// ------------------------------------------------------------------ the tools, as plain functions

export function listCoins(ws: Workspace, input: { verdict?: Verdict; limit?: number }) {
  const all = [...ws.reports.values()];
  const order: Record<Verdict, number> = { FLAG: 0, WATCH: 1, CLEAN: 2, NOT_ENOUGH_DATA: 3 };
  const rows = all
    .filter((r) => !input.verdict || r.verdict === input.verdict)
    .sort((a, b) => order[a.verdict] - order[b.verdict] || b.stats.trades - a.stats.trades)
    .slice(0, input.limit ?? 20);
  const count = (v: Verdict) => all.filter((r) => r.verdict === v).length;
  return {
    coins: all.length,
    byVerdict: { FLAG: count("FLAG"), WATCH: count("WATCH"), CLEAN: count("CLEAN"), NOT_ENOUGH_DATA: count("NOT_ENOUGH_DATA") },
    rows: rows.map((r) => ({
      token: r.coin.token,
      symbolSetByCreator: untrusted(r.coin.symbol),
      verdict: r.verdict,
      trades: r.stats.trades,
      traders: r.stats.traders,
      holders: r.stats.holders,
      launched: r.coin.launchTime,
    })),
  };
}

export function coinReport(ws: Workspace, input: { token: string }) {
  const d = coinOf(ws, input.token);
  const r = reportOf(ws, d);
  const c = d.coin;
  const bal = balances(d);
  const held = sum(bal.values());
  const buys = d.trades.filter((t) => t.side === "buy");
  const sells = d.trades.filter((t) => t.side === "sell");
  const counted = d.trades.filter((t) => t.tokens > 0n && !isSystem(d, t.holder)).length;
  const first = d.trades[0];
  const last = d.trades.at(-1);
  const needs: Record<string, string> = {};
  if (r.checks.wash === "not-enough-data") needs.washTrading = `needs ${RULES.wash.minTrades} trades by wallets, has ${counted}`;
  if (r.checks.concentration === "not-enough-data") needs.hiddenConcentration = `needs ${RULES.concentration.minHolders} holders, has ${bal.size}`;
  if (d.fundingMissing > 0) needs.fundingHistory = `${d.fundingMissing} wallet(s) have no funding history, so links through shared funders may be missing`;
  return {
    token: c.token,
    nameSetByCreator: untrusted(c.name),
    symbolSetByCreator: untrusted(c.symbol),
    verdict: r.verdict,
    checks: r.checks,
    notes: r.notes,
    ...(Object.keys(needs).length ? { missing: needs } : {}),
    launch: {
      tx: c.launchTx,
      time: iso(c.launchTime),
      creator: c.creator,
      ...(lc(c.launcher) !== lc(c.creator) ? { sentBy: c.launcher } : {}),
      creatorBoughtAtLaunch: { tokens: amount(c.devBuyTokens), pctOfSupply: pct(c.devBuyTokens, TOTAL_SUPPLY) },
      pricedIn: quoteOf(ws, d, c.poolId)?.symbol ?? "unknown",
    },
    activity: {
      trades: d.trades.length,
      buys: buys.length,
      sells: sells.length,
      outsideAscend: d.trades.filter((t) => t.outside).length,
      wallets: r.stats.traders,
      tokensBought: amount(sum(buys.map((t) => t.tokens))),
      tokensSold: amount(sum(sells.map((t) => t.tokens))),
      volume: volume(ws, d, d.trades),
      ...(first ? { firstTrade: { time: iso(first.time), secondsAfterLaunch: first.time - c.launchTime, tx: first.tx } } : {}),
      ...(last ? { lastTrade: { time: iso(last.time), secondsAfterLaunch: last.time - c.launchTime, tx: last.tx } } : {}),
    },
    supply: {
      total: amount(TOTAL_SUPPLY),
      holders: bal.size,
      heldByWallets: amount(held),
      heldByWalletsPct: pct(held, TOTAL_SUPPLY),
      creatorHolds: amount(bal.get(lc(c.creator)) ?? 0n),
    },
    walletLinksFound: d.links.length,
    findings: r.findings.map((f) => ({
      check: f.detector,
      severity: f.severity,
      summary: f.summary,
      metrics: f.metrics,
      evidence: f.evidence.map((e) => ({ what: e.what, tx: e.tx })),
    })),
  };
}

export function listTrades(ws: Workspace, input: { token: string; wallet?: string; side?: "buy" | "sell"; limit?: number; offset?: number }) {
  const d = coinOf(ws, input.token);
  const w = input.wallet ? lc(input.wallet) : null;
  const rows = d.trades.filter((t) => (!w || lc(t.holder) === w || lc(t.trader) === w) && (!input.side || t.side === input.side));
  const offset = input.offset ?? 0;
  const page = rows.slice(offset, offset + (input.limit ?? 40));
  return { total: rows.length, offset, rows: page.map((t) => tradeRow(ws, d, t)) };
}

export function listHolders(ws: Workspace, input: { token: string; limit?: number }) {
  const d = coinOf(ws, input.token);
  const bal = balances(d);
  const held = sum(bal.values());
  const cl = clusterMap(d.links, bal.keys());
  const size = new Map<string, number>();
  for (const root of cl.values()) size.set(root, (size.get(root) ?? 0) + 1);
  const lastIn = (w: string) => d.transfers.findLast((t) => lc(t.to) === w)?.tx ?? null;
  const rows = [...bal].sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0)).slice(0, input.limit ?? 25);
  return {
    holders: bal.size,
    heldByWallets: amount(held),
    rows: rows.map(([w, v]) => {
      const root = cl.get(w)!;
      const n = size.get(root)!;
      return {
        wallet: w,
        tokens: amount(v),
        pctOfHeld: pct(v, held),
        pctOfSupply: pct(v, TOTAL_SUPPLY),
        isCreator: w === lc(d.coin.creator),
        ...(n > 1 ? { cluster: short(root), walletsInCluster: n } : {}),
        lastReceivedIn: lastIn(w),
      };
    }),
  };
}

export function listLinks(ws: Workspace, input: { token: string; wallet?: string; limit?: number }) {
  const d = coinOf(ws, input.token);
  const w = input.wallet ? lc(input.wallet) : null;
  const rows = d.links.filter((l) => !w || lc(l.a) === w || lc(l.b) === w);
  return { total: rows.length, rows: rows.slice(0, input.limit ?? 40).map(linkRow) };
}

export function listClusters(ws: Workspace, input: { token: string }) {
  const d = coinOf(ws, input.token);
  const bal = balances(d);
  const held = sum(bal.values());
  const actors = actorsOf(d.trades, d.transfers, d.system);
  const cl = clusterMap(d.links, [...actors].map(lc));
  const groups = new Map<string, string[]>();
  for (const [w, root] of cl) {
    if (isSystem(d, w)) continue;
    groups.set(root, [...(groups.get(root) ?? []), w]);
  }
  const out = [...groups.values()]
    .filter((m) => m.length > 1)
    .map((members) => {
      const set = new Set(members);
      const tokens = sum(members.map((w) => bal.get(w) ?? 0n));
      return {
        wallets: members.length,
        members: members.slice(0, 15).map((w) => ({
          wallet: w,
          holds: amount(bal.get(w) ?? 0n),
          trades: d.trades.filter((t) => lc(t.holder) === w || lc(t.trader) === w).length,
          isCreator: w === lc(d.coin.creator),
        })),
        holdTogether: amount(tokens),
        pctOfHeld: pct(tokens, held),
        linksHoldingItTogether: linksWithin(d.links, set, 10).map(linkRow),
      };
    })
    .sort((a, b) => b.wallets - a.wallets);
  return { clusters: out.length, rows: out.slice(0, 10) };
}

export function walletProfile(ws: Workspace, input: { token: string; wallet: string }) {
  const d = coinOf(ws, input.token);
  if (!isAddress(input.wallet, { strict: false })) throw new ToolInputError(`${input.wallet} is not an address`);
  const w = lc(input.wallet);
  const bal = balances(d);
  const mine = d.trades.filter((t) => lc(t.holder) === w || lc(t.trader) === w);
  const actors = actorsOf(d.trades, d.transfers, d.system);
  const cl = clusterMap(d.links, [...actors].map(lc));
  const root = cl.get(w);
  const cluster = root ? [...cl].filter(([m, r]) => r === root && m !== w && !isSystem(d, m)).map(([m]) => m) : [];
  const funding = ws.fundings.get(w);
  const elsewhere = [...ws.coins.values()]
    .filter((o) => lc(o.coin.token) !== lc(d.coin.token))
    .map((o) => ({ o, n: o.trades.filter((t) => lc(t.holder) === w || lc(t.trader) === w).length, held: balances(o).get(w) ?? 0n }))
    .filter((x) => x.n > 0 || x.held > 0n)
    .slice(0, 15);
  return {
    wallet: w,
    kind: isSystem(d, w) ? "infrastructure (pool, router, vault…)" : "wallet",
    isCreator: w === lc(d.coin.creator),
    sentTheLaunch: w === lc(d.coin.launcher),
    holds: { tokens: amount(bal.get(w) ?? 0n), pctOfSupply: pct(bal.get(w) ?? 0n, TOTAL_SUPPLY) },
    trades: {
      total: mine.length,
      tokensBought: amount(sum(mine.filter((t) => t.side === "buy").map((t) => t.tokens))),
      tokensSold: amount(sum(mine.filter((t) => t.side === "sell").map((t) => t.tokens))),
      volume: volume(ws, d, mine),
      rows: mine.slice(0, 20).map((t) => tradeRow(ws, d, t)),
    },
    links: d.links.filter((l) => lc(l.a) === w || lc(l.b) === w).slice(0, 20).map(linkRow),
    linkedWallets: cluster.slice(0, 20),
    fundedBy: funding
      ? funding.slice(0, 10).map((f) => ({ funder: f.funder, hype: amount(f.value), tx: f.tx, time: iso(f.time), publicHub: f.publicHub }))
      : "unknown: DELPHI has no funding history for this wallet",
    otherCoins: elsewhere.map(({ o, n, held }) => ({
      token: o.coin.token,
      symbolSetByCreator: untrusted(o.coin.symbol),
      verdict: ws.reports.get(lc(o.coin.token))?.verdict ?? null,
      trades: n,
      holds: amount(held),
    })),
  };
}

export function lookupTransaction(ws: Workspace, input: { tx: string }) {
  if (!isHash(input.tx)) throw new ToolInputError(`${input.tx} is not a transaction hash`);
  const h = lc(input.tx);
  const launches = [];
  const trades = [];
  const transfers = [];
  const links = [];
  for (const d of ws.coins.values()) {
    const symbol = untrusted(d.coin.symbol);
    if (lc(d.coin.launchTx) === h) launches.push({ token: d.coin.token, symbolSetByCreator: symbol, creator: d.coin.creator, sentBy: d.coin.launcher });
    for (const t of d.trades) if (lc(t.tx) === h) trades.push({ token: d.coin.token, symbolSetByCreator: symbol, ...tradeRow(ws, d, t) });
    for (const t of d.transfers) {
      if (lc(t.tx) === h) transfers.push({ token: d.coin.token, from: t.from, to: t.to, tokens: amount(t.value) });
    }
    for (const l of d.links) if (l.evidence.some((e) => lc(e) === h)) links.push({ token: d.coin.token, ...linkRow(l) });
  }
  const fundings = [...ws.fundings]
    .flatMap(([wallet, fs]) => fs.filter((f) => lc(f.tx) === h).map((f) => ({ wallet, funder: f.funder, hype: amount(f.value), time: iso(f.time) })));
  const known = launches.length + trades.length + transfers.length + links.length + fundings.length > 0;
  return known
    ? { tx: input.tx, launches, trades, transfers, links, fundings }
    : { tx: input.tx, known: false, note: "DELPHI has no record of this transaction" };
}

// ------------------------------------------------------------------ what a report may cite

/** Every transaction that is part of one coin's data: its launch, trades, transfers, links and its wallets' funding. */
export function coinTxs(ws: Workspace, token: string): Set<string> {
  const d = coinOf(ws, token);
  const out = new Set<string>([lc(d.coin.launchTx)]);
  for (const t of d.trades) out.add(lc(t.tx));
  for (const t of d.transfers) out.add(lc(t.tx));
  for (const l of d.links) for (const e of l.evidence) out.add(lc(e));
  for (const w of actorsOf(d.trades, d.transfers, d.system)) for (const f of ws.fundings.get(lc(w)) ?? []) out.add(lc(f.tx));
  return out;
}

/** Every address one coin's data mentions: the token, its creator and launcher, its wallets, their funders. */
export function coinAddresses(ws: Workspace, token: string): Set<string> {
  const d = coinOf(ws, token);
  const out = new Set<string>([d.coin.token, d.coin.creator, d.coin.launcher, ...d.system].map(lc));
  for (const t of d.trades) [t.trader, t.holder].forEach((a) => out.add(lc(a)));
  for (const t of d.transfers) [t.from, t.to].forEach((a) => out.add(lc(a)));
  for (const l of d.links) [l.a, l.b, ...(l.via ? [l.via] : [])].forEach((a) => out.add(lc(a)));
  for (const w of actorsOf(d.trades, d.transfers, d.system)) for (const f of ws.fundings.get(lc(w)) ?? []) out.add(lc(f.funder));
  return out;
}

// ------------------------------------------------------------------ the same, as tools for Claude

const token = z.string().describe("The coin's token address (0x…)");
const wallet = z.string().describe("A wallet address (0x…)");
const limit = (max: number) => z.number().int().min(1).max(max).optional();

/** The read-only tools, each answering with JSON. `onCall` sees every call (for logs and counts). */
export function readTools(ws: Workspace, onCall: (name: string) => void = () => {}) {
  const json =
    <I>(name: string, fn: (ws: Workspace, input: I) => unknown) =>
    (input: I) => {
      onCall(name);
      return JSON.stringify(fn(ws, input));
    };
  return [
    betaZodTool({
      name: "coin_report",
      description:
        "DELPHI's report for one coin: verdict, what each check found and the transactions it cites, plus launch, trading volume, supply held by wallets, and what data is missing. Start here.",
      inputSchema: z.object({ token }),
      run: json("coin_report", coinReport),
    }),
    betaZodTool({
      name: "trades",
      description:
        "One coin's trades in time order: when (and seconds after launch), buy or sell, which wallet's tokens moved (and who sent it, if someone else), tokens, % of supply, what was paid or received, and the pool. Filter by wallet or side; page with offset.",
      inputSchema: z.object({
        token,
        wallet: wallet.optional(),
        side: z.enum(["buy", "sell"]).optional(),
        limit: limit(100),
        offset: z.number().int().min(0).optional(),
      }),
      run: json("trades", listTrades),
    }),
    betaZodTool({
      name: "holders",
      description:
        "Who holds one coin now (wallets only, not pools or contracts): tokens, % of all wallet-held tokens, % of supply, whether it is the creator, its cluster of linked wallets, and the last transaction that sent it tokens.",
      inputSchema: z.object({ token, limit: limit(100) }),
      run: json("holders", listHolders),
    }),
    betaZodTool({
      name: "links",
      description:
        "Why DELPHI treats wallets as one actor on this coin: each link has a reason (shared funder, funded by, token pass, bought for, sold for, is creator), its meaning, and the transactions that show it. Filter by wallet.",
      inputSchema: z.object({ token, wallet: wallet.optional(), limit: limit(100) }),
      run: json("links", listLinks),
    }),
    betaZodTool({
      name: "clusters",
      description:
        "Groups of linked wallets on this coin (two or more wallets acting as one): members, their holdings and trade counts, what the group holds together, and the links holding it together.",
      inputSchema: z.object({ token }),
      run: json("clusters", listClusters),
    }),
    betaZodTool({
      name: "wallet",
      description:
        "Everything DELPHI knows about one wallet on one coin: role (creator, launcher), balance, its trades and volume, its links and linked wallets, who funded it with HYPE (and whether that funder is a public faucet), and the other coins it traded or holds.",
      inputSchema: z.object({ token, wallet }),
      run: json("wallet", walletProfile),
    }),
    betaZodTool({
      name: "transaction",
      description:
        "What one transaction did, across every scanned coin: launches, trades, token transfers, the wallet links it proves, and HYPE funding it paid.",
      inputSchema: z.object({ tx: z.string().describe("A transaction hash (0x + 64 hex)") }),
      run: json("transaction", lookupTransaction),
    }),
    betaZodTool({
      name: "list_coins",
      description:
        "Every coin in this scan with its verdict, trades, traders and holders, worst first, plus totals by verdict. Use it to put one coin in context.",
      inputSchema: z.object({ verdict: z.enum(["FLAG", "WATCH", "CLEAN", "NOT_ENOUGH_DATA"]).optional(), limit: limit(50) }),
      run: json("list_coins", listCoins),
    }),
  ];
}
