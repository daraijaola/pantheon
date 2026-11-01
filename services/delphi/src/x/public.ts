// What @heyDelph may know about wallets. She answers in public, so the X channel gets a public view of
// DELPHI's data: coin-level facts (verdicts and the reasons behind them, counts, shares of the supply,
// contract checks, the names of known contracts) and nothing that ties a wallet to anyone. Never who
// funded a wallet or when, which wallets are linked to it (groups, clusters, trades sent for another
// wallet, the evidence lines that name them), or its exact balance or profit. Each view is an allowlist
// over the explainer's own functions (src/ai/tools.ts), which stay as they are for internal use. The
// reply checks in text.ts are the last line behind these views.
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { coinOf, coinReport, listCoins, listHolders, listTrades, lookupTransaction, walletProfile } from "../ai/tools.ts";
import type { Workspace } from "../ai/workspace.ts";
import { KNOWN_HUBS, supplyOf } from "../config.ts";
import { balances, pct } from "../detect.ts";
import { actorsOf, clusters, isSystem } from "../graph.ts";
import type { LinkReason } from "../types.ts";
import { KNOWN_ADDRESSES } from "./xtools.ts";

const lc = (a: string) => a.toLowerCase();
const sum = (vs: Iterable<bigint>) => [...vs].reduce((s, v) => s + v, 0n);

/** Sent with every wallet view, so she knows the gaps are on purpose. */
export const PRIVATE =
  "Who funded a wallet, which wallets are linked to it, and its balance or profit are never said in public: DELPHI keeps them private. Counts and shares of the supply are fine.";

/** A trade as anyone may see it: when, which way, whose tokens and what share of the supply. Not who sent it for whom, nor what was paid. */
type TradeRow = ReturnType<typeof listTrades>["rows"][number];
const tradeView = (t: TradeRow) => ({ tx: t.tx, time: t.time, secondsAfterLaunch: t.secondsAfterLaunch, side: t.side, wallet: t.wallet, pctOfSupply: t.pctOfSupply, pool: t.pool });

/** coin_report without the evidence lines (they name the linked wallets) and with the creator's holding as a share. */
export function publicCoinReport(ws: Workspace, input: { token: string }) {
  const r = coinReport(ws, input);
  const d = coinOf(ws, input.token);
  const launch = "creatorBoughtAtLaunch" in r.launch ? { ...r.launch, creatorBoughtAtLaunch: { pctOfSupply: r.launch.creatorBoughtAtLaunch.pctOfSupply } } : r.launch;
  return {
    token: r.token,
    nameSetByCreator: r.nameSetByCreator,
    symbolSetByCreator: r.symbolSetByCreator,
    ...(r.trades ? { trades: r.trades } : {}),
    verdict: r.verdict,
    checks: r.checks,
    notes: r.notes,
    ...(r.missing ? { missing: r.missing } : {}),
    launch,
    activity: r.activity,
    supply: {
      total: r.supply.total,
      holders: r.supply.holders,
      heldByWallets: r.supply.heldByWallets,
      heldByWalletsPct: r.supply.heldByWalletsPct,
      creatorHoldsPctOfSupply: pct(balances(d).get(lc(d.coin.creator)) ?? 0n, supplyOf(d.coin)),
    },
    walletLinksFound: r.walletLinksFound,
    findings: r.findings.map((f) => ({ check: f.check, severity: f.severity, summary: f.summary, metrics: f.metrics })),
  };
}

export function publicTrades(ws: Workspace, input: Parameters<typeof listTrades>[1]) {
  const t = listTrades(ws, input);
  return { total: t.total, offset: t.offset, rows: t.rows.map(tradeView) };
}

/** The biggest holders and their shares, as any explorer shows them: not which of them are linked, nor exact amounts. */
export function publicHolders(ws: Workspace, input: { token: string; limit?: number }) {
  const h = listHolders(ws, input);
  return { holders: h.holders, heldByWallets: h.heldByWallets, rows: h.rows.map((r) => ({ wallet: r.wallet, pctOfHeld: r.pctOfHeld, pctOfSupply: r.pctOfSupply, isCreator: r.isCreator })) };
}

const REASON: Record<LinkReason, string> = {
  "shared-funder": "shared funder",
  "funded-by": "one funded another",
  "token-pass": "token passes",
  "bought-for": "trades sent for another wallet",
  "sold-for": "trades sent for another wallet",
  "is-creator": "launch sent for the creator",
};

/** The linked groups on a coin, counted: how many wallets, what they hold together, what links them. Never their members. */
export function publicClusters(ws: Workspace, input: { token: string }) {
  const d = coinOf(ws, input.token);
  const bal = balances(d);
  const held = sum(bal.values());
  const groups = new Map<string, string[]>();
  for (const [w, root] of clusters(d.links, [...actorsOf(d.trades, d.transfers, d.system)].map(lc))) {
    if (isSystem(d, w)) continue;
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(w);
  }
  const creator = lc(d.coin.creator);
  const rows = [...groups.values()]
    .filter((m) => m.length > 1)
    .map((members) => {
      const set = new Set(members);
      const linkedBy: Record<string, number> = {};
      for (const l of d.links) if (set.has(lc(l.a)) && set.has(lc(l.b))) linkedBy[REASON[l.reason]] = (linkedBy[REASON[l.reason]] ?? 0) + 1;
      return { wallets: members.length, pctOfHeld: pct(sum(members.map((w) => bal.get(w) ?? 0n)), held), includesCreator: set.has(creator), linkedBy };
    })
    .sort((a, b) => b.wallets - a.wallets);
  return { clusters: rows.length, rows: rows.slice(0, 10), note: "Groups are counted, never listed: which wallets are in a group is not said in public." };
}

/** One wallet on one coin: its role, share and trades, and the other coins it touched. */
export function publicWallet(ws: Workspace, input: { token: string; wallet: string }) {
  const w = walletProfile(ws, input);
  const count = (side: "buy" | "sell") => listTrades(ws, { token: input.token, wallet: input.wallet, side, limit: 1 }).total;
  return {
    wallet: w.wallet,
    kind: w.kind,
    isCreator: w.isCreator,
    sentTheLaunch: w.sentTheLaunch,
    holdsPctOfSupply: w.holds.pctOfSupply,
    trades: { total: w.trades.total, buys: count("buy"), sells: count("sell"), rows: w.trades.rows.map(tradeView) },
    otherCoins: w.otherCoins.map((o) => ({ token: o.token, symbolSetByCreator: o.symbolSetByCreator, verdict: o.verdict, trades: o.trades, stillHolds: o.holds !== "0" })),
    private: PRIVATE,
  };
}

/** What a transaction did as a launch, a trade or a token transfer. Not the links it proves, nor the HYPE funding it paid. */
export function publicTransaction(ws: Workspace, input: { tx: string }) {
  const { launches = [], trades = [], transfers = [] } = lookupTransaction(ws, input);
  if (launches.length + trades.length + transfers.length === 0) {
    return { tx: input.tx, known: false, note: "DELPHI has no record of this transaction as a launch, a trade or a token transfer" };
  }
  return {
    tx: input.tx,
    launches,
    trades: trades.map((x) => ({ token: x.token, symbolSetByCreator: x.symbolSetByCreator, ...tradeView(x) })),
    transfers: transfers.map((x) => ({ token: x.token, from: x.from, to: x.to })),
  };
}

/**
 * Every address a reply about this coin may name: the coin, its creator and launcher, its infrastructure,
 * and the wallets that traded or moved it. Not the wallets that funded them: DELPHI knows those only from
 * who paid whom.
 */
export function publicAddresses(ws: Workspace, token: string): Set<string> {
  const d = coinOf(ws, token);
  const out = new Set<string>([d.coin.token, d.coin.creator, d.coin.launcher, ...d.system].map(lc));
  for (const t of d.trades) [t.trader, t.holder].forEach((a) => out.add(lc(a)));
  for (const t of d.transfers) [t.from, t.to].forEach((a) => out.add(lc(a)));
  return out;
}

const hiddenOf = new WeakMap<Workspace, ReadonlySet<string>>();

/**
 * Addresses DELPHI knows only as someone's funder (a wallet's funding, or the funder behind a link): a
 * reply must never name them. One that is public in its own right (a coin, a creator, a trader on any
 * coin, a known contract or faucet) is left off. Worked out once per snapshot.
 */
export function privateAddresses(ws: Workspace): ReadonlySet<string> {
  const cached = hiddenOf.get(ws);
  if (cached) return cached;
  const open = new Set<string>([...Object.keys(KNOWN_ADDRESSES), ...KNOWN_HUBS].map(lc));
  for (const d of ws.coins.values()) for (const a of publicAddresses(ws, d.coin.token)) open.add(a);
  const out = new Set<string>();
  for (const fs of ws.fundings.values()) for (const f of fs) if (!open.has(lc(f.funder))) out.add(lc(f.funder));
  for (const d of ws.coins.values()) for (const l of d.links) if (l.via && !open.has(lc(l.via))) out.add(lc(l.via));
  hiddenOf.set(ws, out);
  return out;
}

const token = z.string().describe("The coin's token address (0x…)");
const wallet = z.string().describe("A wallet address (0x…)");
const limit = (max: number) => z.number().int().min(1).max(max).optional();

/** Her read-only tools over DELPHI's data, each answering with a public view as JSON. `onCall` sees every call. */
export function publicReadTools(ws: Workspace, onCall: (name: string) => void = () => {}) {
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
        "DELPHI's report for one coin: verdict, what each check found and how much, plus launch, trading volume, supply held by wallets, the creator's share, and what data is missing. Start here.",
      inputSchema: z.object({ token }),
      run: json("coin_report", publicCoinReport),
    }),
    betaZodTool({
      name: "trades",
      description:
        "One coin's trades in time order: when (and seconds after launch), buy or sell, which wallet's tokens moved, the share of the supply, and the pool. Filter by wallet or side; page with offset.",
      inputSchema: z.object({
        token,
        wallet: wallet.optional(),
        side: z.enum(["buy", "sell"]).optional(),
        limit: limit(100),
        offset: z.number().int().min(0).optional(),
      }),
      run: json("trades", publicTrades),
    }),
    betaZodTool({
      name: "holders",
      description: "Who holds one coin now (wallets only, not pools or contracts), biggest first: % of all wallet-held tokens, % of supply, and whether it is the creator.",
      inputSchema: z.object({ token, limit: limit(100) }),
      run: json("holders", publicHolders),
    }),
    betaZodTool({
      name: "clusters",
      description:
        "Groups of linked wallets on this coin (wallets DELPHI treats as one actor), biggest first: how many wallets, the share they hold together, whether the creator is in it, and what links them. Counts only: which wallets are in a group is never said in public.",
      inputSchema: z.object({ token }),
      run: json("clusters", publicClusters),
    }),
    betaZodTool({
      name: "wallet",
      description:
        "One wallet on one coin: its role (creator, launcher), its share of the supply, its trades, and the other coins it traded or holds. Never who funded it, its linked wallets or its balance: those stay private.",
      inputSchema: z.object({ token, wallet }),
      run: json("wallet", publicWallet),
    }),
    betaZodTool({
      name: "transaction",
      description: "What one transaction did, across every scanned coin: launches, trades and token transfers.",
      inputSchema: z.object({ tx: z.string().describe("A transaction hash (0x + 64 hex)") }),
      run: json("transaction", publicTransaction),
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
