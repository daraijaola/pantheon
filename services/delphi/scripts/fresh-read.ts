// One fresh read of every Ascend coin, printed as JSON in the shape of out/scan.json, for Get uploaded's
// "check any coin" and its Guard. It takes about 10 s, and every market together about 3.5 minutes, so only
// Ascend is read here. It uses the same cache and rules as the scan and writes only to that cache. It adds
// `creatorSells`: every sale by a coin's creator, its launcher or a wallet linked to them, and `dailyPrices`:
// each coin's last trade of each UTC day, in its pool's quote coin, to show how a coin did over time.
//   node scripts/fresh-read.ts
import { accessSync, constants, existsSync } from "node:fs";
import { makeClient } from "../src/chain.ts";
import { loadConfig, supplyOf } from "../src/config.ts";
import { ChainFunding } from "../src/funding.ts";
import { groupsOf } from "../src/graph.ts";
import { collect } from "../src/ingest.ts";
import { analyze } from "../src/report.ts";
import { Store } from "../src/store.ts";
import type { CoinData } from "../src/types.ts";

const log = (m: string) => console.error(`[fresh-read] ${m}`);
const cfg = loadConfig();
// DELPHI's cache belongs to its service user: stop before touching it as anyone else.
if (existsSync(cfg.dbPath)) {
  try {
    accessSync(cfg.dbPath, constants.W_OK);
  } catch {
    console.error(`run this as DELPHI's service user: ${cfg.dbPath} is not writable for you`);
    process.exit(2);
  }
}
const lc = (a: string) => a.toLowerCase();

/** Sales by the creator's group, each with its size in millionths of the supply. */
function creatorSells(d: CoinData) {
  const team = new Set([lc(d.coin.creator), lc(d.coin.launcher)]);
  for (const g of groupsOf(d.links)) if ([...g.members].some((m) => team.has(m))) for (const m of g.members) team.add(m);
  const supply = supplyOf(d.coin);
  return d.trades
    .filter((t) => t.side === "sell" && team.has(lc(t.holder)))
    .map((t) => ({ token: lc(d.coin.token), wallet: lc(t.holder), ppm: Number((t.tokens * 1_000_000n) / supply), tx: t.tx, url: `${cfg.explorerWeb}/tx/${t.tx}`, time: t.time }));
}

/** The last price of each UTC day: [day number, price]. In raw units, so only compare it with itself. */
function dailyPrices(d: CoinData): Array<[number, number]> {
  const last = new Map<number, number>();
  for (const t of [...d.trades].sort((a, b) => a.time - b.time)) if (t.tokens > 0n && !t.outside) last.set(Math.floor(t.time / 86_400), Number(t.quote) / Number(t.tokens));
  return [...last];
}

const store = new Store(cfg.dbPath);
try {
  const client = makeClient(cfg.elysiumRpc, (ms, what) => log(`RPC asked us to slow down (${what}): waiting ${ms / 1000} s`));
  const { coins, head } = await collect({ client, store, cfg, explorer: new ChainFunding(), log });
  const now = new Date();
  const reports = coins.map((d) => analyze(d, { explorerWeb: cfg.explorerWeb, now }));
  process.stdout.write(JSON.stringify({ network: cfg.network, generatedAt: now.toISOString(), head: head.toString(), reports, creatorSells: coins.flatMap(creatorSells), dailyPrices: Object.fromEntries(coins.map((d) => [lc(d.coin.token), dailyPrices(d)])) }));
} finally {
  store.close();
}
