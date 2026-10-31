// Two coins side by side (feature "compare"): "@heyDelph $A vs $B". For each coin, the same facts in the
// same shape: verdict and checks, holders, the creator's share, age, trades and the wallet links DELPHI
// found. Tickers repeat, so a ticker shared by several coins is never guessed: she asks for the address.
import { isAddress } from "viem";
import { z } from "zod";
import { listClusters } from "../ai/tools.ts";
import { supplyOf } from "../config.ts";
import { balances, pct } from "../detect.ts";
import { coinsByTicker } from "./find.ts";
import { untrusted } from "./text.ts";
import { jsonTool, type ExtraTool } from "./tooling.ts";
import type { Snapshot } from "./xtools.ts";

const lc = (a: string) => a.toLowerCase();

/** A coin by address or $TICKER, or why it can't be picked. */
function pick(snap: Snapshot, q: string): { token: string } | { error: string } {
  const s = q.trim().replace(/^\$/, "");
  if (isAddress(s, { strict: false })) return snap.ws.reports.has(lc(s)) ? { token: lc(s) } : { error: `${s} is not an Ascend coin DELPHI has read` };
  const hits = coinsByTicker(snap.ws, s);
  if (hits.length === 1) return { token: hits[0]! };
  if (hits.length > 1) return { error: `${hits.length} coins use the ticker $${untrusted(s, 16)}: ask for the address (0x…)` };
  return { error: `no Ascend coin uses the ticker $${untrusted(s, 16)}` };
}

function side(snap: Snapshot, token: string) {
  const d = snap.ws.coins.get(token)!;
  const r = snap.ws.reports.get(token)!;
  const bal = balances(d);
  const held = [...bal.values()].reduce((s, v) => s + v, 0n);
  const mine = bal.get(lc(d.coin.creator)) ?? 0n;
  const groups = listClusters(snap.ws, { token }).rows;
  const biggest = [...groups].sort((a, b) => b.pctOfHeld - a.pctOfHeld)[0];
  const secs = Math.max(0, snap.readAt.getTime() / 1000 - d.coin.launchTime);
  return {
    token: d.coin.token,
    symbolSetByCreator: d.coin.symbol ? untrusted(d.coin.symbol, 16) : null,
    verdict: r.verdict,
    checks: r.checks,
    mainFinding: r.findings[0]?.summary ?? null,
    holders: bal.size,
    traders: r.stats.traders,
    trades: d.trades.length,
    age: { days: Math.floor(secs / 86_400), hours: Math.floor(secs / 3_600) },
    creatorHolds: { pctOfSupply: pct(mine, supplyOf(d.coin)), pctOfHeld: pct(mine, held) },
    creatorBoughtAtLaunchPctOfSupply: pct(d.coin.devBuyTokens, supplyOf(d.coin)),
    walletLinksFound: d.links.length,
    linkedGroups: groups.length,
    ...(biggest ? { biggestGroup: { wallets: biggest.wallets, pctOfHeld: biggest.pctOfHeld } } : {}),
  };
}

export function compareCoins(snap: Snapshot, input: { a: string; b: string }) {
  const a = pick(snap, input.a);
  const b = pick(snap, input.b);
  if ("error" in a || "error" in b) return { error: [a, b].flatMap((x) => ("error" in x ? [x.error] : [])).join(". ") };
  if (a.token === b.token) return { sameCoin: a.token, error: "both name the same coin: there is nothing to compare" };
  return { coins: [side(snap, a.token), side(snap, b.token)] };
}

export const compareTool: ExtraTool = {
  feature: "compare",
  name: "compare_coins",
  guidance:
    'compare_coins puts two coins side by side: verdicts and checks, holders, the creator\'s share, age, trades and wallet links found. Use it for "$A vs $B". Say what differs, briefly: one short line per coin, or per fact. Set token and verdict to the first coin. If both name the same coin, say so: there is nothing to compare.',
  build: (env) =>
    jsonTool(env, {
      name: "compare_coins",
      description:
        "Two Ascend coins side by side, by token address or $TICKER: verdict, checks, main finding, holders, traders, trades, age, the creator's share and launch buy, wallet links and linked groups. Counts as coin_report for both.",
      inputSchema: z.object({
        a: z.string().min(1).max(64).describe("The first coin: token address (0x…) or $TICKER"),
        b: z.string().min(1).max(64).describe("The second coin: token address (0x…) or $TICKER"),
      }),
      run: (i) => {
        const out = compareCoins(env.snap, i);
        if ("coins" in out && out.coins) for (const c of out.coins) env.coinChecked(c.token);
        return out;
      },
    }),
};
