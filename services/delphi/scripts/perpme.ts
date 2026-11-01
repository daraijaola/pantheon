// Reads every PerpMe launch (the launchpad behind Kalos's Sniper) into DELPHI's shape and prints a compact
// table, with the three checks run on their own (no wallet links yet: funding and linking join when this is
// merged into the main scan). xStock coins are left out, as Kalos's Sniper hides them. Read-only. Live, so
// run it by hand:
//   node scripts/perpme.ts                  every PerpMe coin that isn't an xStock
//   node scripts/perpme.ts --only 0x…       one coin (or its symbol); the read still covers every launch
//   node scripts/perpme.ts --json out/perpme.json
// Cache: DB_PATH (default data/perpme-dev.db). It refuses data/delphi.db, the main scan's cache.
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { formatUnits, isAddress } from "viem";
import { makeClient } from "../src/chain.ts";
import { loadConfig, supplyOf } from "../src/config.ts";
import { balances, pct } from "../src/detect.ts";
import { collectPerpme } from "../src/perpme-collect.ts";
import { PERPME_QUOTES } from "../src/perpme.ts";
import { analyze } from "../src/report.ts";
import { BatchRpc } from "../src/rpc.ts";
import { Store } from "../src/store.ts";
import type { CoinData } from "../src/types.ts";

const args = process.argv.slice(2);
const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const only = opt("--only");
const jsonOut = opt("--json");

const dbPath = process.env.DB_PATH || "data/perpme-dev.db";
if (basename(resolve(dbPath)) === "delphi.db" && basename(dirname(resolve(dbPath))) === "data") {
  console.error("refusing to use data/delphi.db (the main scan's cache): set DB_PATH to another file");
  process.exit(2);
}

const cfg = loadConfig({ ...process.env, DB_PATH: dbPath });
const store = new Store(dbPath);
const rpc = new BatchRpc();
const t0 = Date.now();
const log = (m: string) => console.error(`[perpme ${Math.round((Date.now() - t0) / 1000)}s] ${m}`);
const WEB = "https://test-explorer.elysium.kinetiq.xyz";
const lc = (a: string) => a.toLowerCase();
const n = (x: number) => x.toLocaleString("en-US");
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const hype = (wei: bigint | null) => (wei === null ? "-" : Number(formatUnits(wei, 18)).toLocaleString("en-US", { maximumFractionDigits: 3 }));
/** What PerpMe coins are priced in, by name (PerpMe's WHYPE is shown as HYPE, as PerpMe and Kalos do). */
const PAIR_NAMES: Record<string, string> = Object.fromEntries(PERPME_QUOTES.map((a, i) => [lc(a), ["HYPE", "USDC", "KALOS"][i]!]));
/** Coin names are chosen by whoever launched them: no control characters, capped. */
const clean = (s: string | null, max = 14) => (s ?? "?").replace(/[\p{C}]/gu, "").trim().slice(0, max) || "?";

/** What an address holds, replayed from the coin's transfers (system addresses included). */
function heldBy(d: CoinData, a: string): bigint {
  let v = 0n;
  for (const t of d.transfers) {
    if (lc(t.to) === lc(a)) v += t.value;
    if (lc(t.from) === lc(a)) v -= t.value;
  }
  return v;
}

try {
  const got = await collectPerpme({
    client: makeClient(cfg.elysiumRpc, (ms, what) => log(`public RPC asked us to slow down (${what}): waiting ${ms / 1000} s`)),
    rpc,
    store,
    log,
  });
  const pick = (d: { coin: CoinData["coin"] }) => !only || (isAddress(only, { strict: false }) ? lc(d.coin.token) === lc(only) : lc(d.coin.symbol ?? "") === lc(only));
  const coins = got.skeletons.filter(pick).map((s): CoinData => ({ ...s, links: [], fundingMissing: 0, network: cfg.network }));
  if (only && !coins.length) throw new Error(`${only} is not a PerpMe coin (xStocks are left out)`);
  const rows = coins
    .map((d) => {
      const r = analyze(d, { explorerWeb: WEB });
      const liq = got.liquidity.get(lc(d.coin.token));
      const supply = supplyOf(d.coin);
      const bal = [...balances(d).values()].sort((a, b) => (b > a ? 1 : b < a ? -1 : 0));
      const state = (k: "bundle" | "wash" | "concentration") => {
        const f = r.findings.find((x) => x.detector === k);
        if (f) return `${f.severity} (${Object.values(f.metrics)[0]})`;
        return r.checks[k] === "clear" ? "clear" : "n/e/d";
      };
      return {
        d,
        r,
        liq,
        cells: [
          clean(d.coin.symbol),
          short(d.coin.token),
          new Date(d.coin.launchTime * 1000).toISOString().slice(5, 16).replace("T", " "),
          liq ? (PAIR_NAMES[lc(liq.pairToken)] ?? short(liq.pairToken)) : "?",
          n(d.trades.length),
          n(r.stats.traders),
          n(r.stats.holders),
          String(pct(d.coin.devBuyTokens, supply)),
          String(pct(heldBy(d, d.coin.creator), supply)),
          String(pct(bal.slice(0, 5).reduce((s, v) => s + v, 0n), supply)),
          liq ? hype(liq.hypeInPool) : "-",
          liq ? (liq.locked ? "locked" : "OPEN") + (liq.unlocked.length ? `+${liq.unlocked.length}` : "") : "?",
          liq?.restriction.active ? "on" : "",
          state("bundle"),
          state("wash"),
          state("concentration"),
          r.verdict,
        ],
      };
    })
    .sort((a, b) => b.d.trades.length - a.d.trades.length);

  const head = ["coin", "token", "launched", "pair", "trades", "traders", "holders", "dev buy %", "creator %", "top 5 %", "HYPE in pool", "LP", "window", "bundle", "wash", "concentration", "verdict"];
  const width = head.map((h, i) => Math.max(h.length, ...rows.map((c) => [...c.cells[i]!].length)));
  const line = (c: string[]) => c.map((x, i) => x.padEnd(width[i]!)).join("  ");
  console.log(`\nPerpMe coins at block ${got.head} (parent block ${got.parentHead ?? "?"}); checks run unlinked (no funding links yet)\n`);
  console.log(line(head));
  console.log(width.map((w) => "-".repeat(w)).join("  "));
  for (const r of rows) console.log(line(r.cells));
  const verdicts = new Map<string, number>();
  for (const r of rows) verdicts.set(r.r.verdict, (verdicts.get(r.r.verdict) ?? 0) + 1);
  console.log(
    `\n${rows.length} coins (${got.launches.length} launches read, ${got.launches.filter((l) => l.xstock).length} xStocks left out). Verdicts: ${[...verdicts].map(([v, c]) => `${v} ${c}`).join(", ")}.` +
      "\ndev buy %: the creator's buy in the launch transaction; creator % and top 5 %: what they hold now (of the total supply; contracts and pools left out)." +
      "\nLP: the launch position in PerpMe's locker (+N: other positions anyone can withdraw). window: launch protection still on. n/e/d: not enough data.",
  );
  for (const note of got.notes.filter((x) => !only || x.startsWith(`${coins[0]?.coin.symbol}: `) || !/^[^ ]+: /.test(x))) console.log(`note: ${note}`);
  if (jsonOut) {
    mkdirSync(dirname(jsonOut), { recursive: true });
    const replacer = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v instanceof Map ? Object.fromEntries(v) : v instanceof Set ? [...v] : v);
    const body = { head: got.head, parentHead: got.parentHead, notes: got.notes, coins: rows.map((r) => ({ token: r.d.coin.token, symbol: r.d.coin.symbol, verdict: r.r.verdict, stats: r.r.stats, findings: r.r.findings, notes: r.r.notes, liquidity: r.liq })) };
    writeFileSync(jsonOut, `${JSON.stringify(body, replacer, 2)}\n`);
  }
  log(`done in ${Math.round((Date.now() - t0) / 1000)} s, ${rpc.requests} requests to the explorer's node, cache ${dbPath}`);
} finally {
  store.close();
}
