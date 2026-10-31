// Explains DELPHI's verdicts in plain English with Claude: one short report per coin, every point
// linked to its transactions. Works from DELPHI's cache (run scripts/scan.ts first for fresh data):
// the only network calls are read-only RPC reads and the Claude API. Live, so run it by hand:
//   node scripts/explain.ts               coins with a finding or a CLEAN verdict, and any with 5+ trades
//   node scripts/explain.ts --only 0x…    one coin
//   node scripts/explain.ts --all         every coin
//   node scripts/explain.ts --force       explain again even if the coin's data has not changed
//   node scripts/explain.ts --dry         list the coins and print the first one's coin_report; no Claude calls
// Every run also rewrites out/site.json, the file the website reads.
import Anthropic from "@anthropic-ai/sdk";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAddress, isAddress } from "viem";
import { costOf, explainCoin, explanationKey, toExplainedMarkdown, type Explained } from "../src/ai/explain.ts";
import { loadApiKey } from "../src/ai/key.ts";
import { coinReport } from "../src/ai/tools.ts";
import { siteBundle, type KalosExtras, type Saved } from "../src/ai/site.ts";
import { loadWorkspace } from "../src/ai/workspace.ts";
import { makeClient, mapLimit } from "../src/chain.ts";
import { loadConfig, supplyOf } from "../src/config.ts";
import { balances, pct } from "../src/detect.ts";
import { peopleOf } from "../src/graph.ts";
import { collect } from "../src/ingest.ts";
import { analyze, mdText, type CoinReport } from "../src/report.ts";
import { BatchRpc } from "../src/rpc.ts";
import { summarize } from "../src/safety-run.ts";
import type { SafetyReport } from "../src/safety.ts";
import { Store } from "../src/store.ts";

const args = process.argv.slice(2);
const onlyArg = args.includes("--only") ? args[args.indexOf("--only") + 1] : undefined;
if (onlyArg !== undefined && !isAddress(onlyArg, { strict: false })) {
  console.error("--only needs a token address");
  process.exit(2);
}
const only = onlyArg ? getAddress(onlyArg) : undefined;
const dry = args.includes("--dry");

const cfg = loadConfig();
const store = new Store(cfg.dbPath);
const log = (m: string) => console.error(`[delphi-ai] ${m}`);

try {
  const client = makeClient(cfg.elysiumRpc, (ms, what) => log(`RPC asked us to slow down (${what}): waiting ${ms / 1000} s`));
  // Cached funding only: explaining never spends the explorer allowance.
  const { coins, head, hubs, liquidity } = await collect({ client, store, cfg, explorer: null, kalos: args.includes("--no-kalos") ? null : { rpc: new BatchRpc() }, log });
  const now = new Date();
  const reports = coins.map((d) => analyze(d, { explorerWeb: cfg.explorerWeb, now }));
  const ws = await loadWorkspace({ client, store, cfg, coins, reports, hubs, liquidity });

  const worth = (r: CoinReport) => r.verdict !== "NOT_ENOUGH_DATA" || r.stats.trades >= 5;
  const targets = reports.filter((r) => (only ? r.coin.token === only : args.includes("--all") || worth(r)));
  if (only && targets.length === 0) throw new Error(`${only} is not a coin DELPHI reads`);
  const dir = join(cfg.outDir, "coins");
  mkdirSync(dir, { recursive: true });
  const saved = (r: CoinReport) => join(dir, `${r.coin.token}.ai.json`);
  // A coin that only gained trades keeps its explanation for up to 3 days: the site then shows it next
  // to the report it was written for. A new verdict or a changed check is explained again at once.
  const fresh = (r: CoinReport) => {
    if (!existsSync(saved(r))) return false;
    const x = JSON.parse(readFileSync(saved(r), "utf8")) as Explained & { report?: CoinReport };
    if (x.key === explanationKey(r)) return true;
    const young = now.getTime() - Date.parse(x.generatedAt) < 3 * 86_400_000;
    return young && x.verdict === r.verdict && JSON.stringify(x.report?.checks) === JSON.stringify(r.checks);
  };
  const todo = targets.filter((r) => args.includes("--force") || !fresh(r));
  log(`${targets.length} coins to explain, ${targets.length - todo.length} already up to date`);

  if (dry) {
    for (const r of todo) log(`  ${r.coin.token} ${r.verdict} (${r.stats.trades} trades)`);
    if (todo[0]) console.log(JSON.stringify(coinReport(ws, { token: todo[0].coin.token }), null, 2));
  } else if (todo.length) {
    const claude = new Anthropic({ apiKey: loadApiKey() });
    const done: Explained[] = [];
    await mapLimit(todo, 3, async (r) => {
      try {
        const x = await explainCoin(claude, ws, r.coin.token, { now });
        // The report is saved with its explanation, so the two are always shown together.
        writeFileSync(saved(r), `${JSON.stringify({ ...x, report: r }, null, 2)}\n`);
        writeFileSync(join(dir, `${r.coin.token}.ai.md`), toExplainedMarkdown(r, x, cfg.explorerWeb));
        done.push(x);
        log(`${r.coin.token} ${r.verdict}: ${x.toolCalls.length} tool calls, ${x.usage.requests} requests, about $${costOf(x.usage).toFixed(3)}`);
      } catch (err) {
        if (err instanceof Anthropic.AuthenticationError) throw err;
        log(`${r.coin.token}: not explained: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    const total = done.reduce((s, x) => s + costOf(x.usage), 0);
    log(`explained ${done.length}/${todo.length} coins, about $${total.toFixed(2)} at list prices`);
  }

  // One page with every explained coin in this scan, worst first.
  const order: Record<CoinReport["verdict"], number> = { FLAG: 0, WATCH: 1, CLEAN: 2, NOT_ENOUGH_DATA: 3 };
  const rows = reports
    .filter((r) => existsSync(saved(r)))
    .map((r) => ({ r, x: JSON.parse(readFileSync(saved(r), "utf8")) as Saved }))
    .sort((a, b) => order[a.r.verdict] - order[b.r.verdict] || b.r.stats.trades - a.r.stats.trades);
  if (!dry) {
    const lines = [
      "# DELPHI, in plain words",
      "",
      "| Coin | Verdict | In one sentence |",
      "| --- | --- | --- |",
      ...rows.map(
        ({ r, x }) =>
          `| [${mdText(r.coin.symbol, 16)}](coins/${r.coin.token}.ai.md) | ${r.verdict.replaceAll("_", " ")} | ${x.explanation.headline.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/[\\|[\]()<>]/g, (ch) => `\\${ch}`)} |`,
      ),
      "",
      "_Written by Claude from DELPHI's data. Each coin's page links every point to its transactions._",
      "",
    ];
    writeFileSync(join(cfg.outDir, "explained.md"), lines.join("\n"));
    log(`${rows.length} explained coins listed in ${cfg.outDir}/explained.md`);
  }

  // The website's data: every verdict, and each explanation next to the report it explains.
  const people = new Map(coins.map((d) => [d.coin.token.toLowerCase(), peopleOf(d)]));
  // Kalos coins: who holds them, their pools' liquidity, and the contract checks the scan saved.
  const kalos = new Map<string, KalosExtras>();
  for (const d of coins) {
    if (d.coin.market !== "kalos") continue;
    const t = d.coin.token.toLowerCase();
    const supply = supplyOf(d.coin);
    const held = [...balances(d)].sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0));
    const liq = liquidity.get(t);
    const tvl = liq?.pools.reduce((s, p) => (p.tvlHype === null ? s : s + p.tvlHype), 0n) ?? 0n;
    const safe = store.recall<SafetyReport>("safety", t);
    kalos.set(t, {
      creatorPct: pct(held.find(([w]) => w === d.coin.creator.toLowerCase())?.[1] ?? 0n, supply),
      top5Pct: pct(held.slice(0, 5).reduce((s, [, v]) => s + v, 0n), supply),
      windowed: d.coin.windowFrom !== undefined,
      pools: liq?.pools.length ?? 0,
      tvlHype: liq?.pools.some((p) => p.tvlHype !== null) ? Number(tvl / 10n ** 14n) / 1e4 : null,
      lpOwners: liq?.lpOwners ?? 0,
      bigRemovals: liq?.pools.reduce((s, p) => s + p.bigRemovals.length, 0) ?? 0,
      ...(safe ? { safety: summarize(safe) } : {}),
    });
  }
  const bundle = siteBundle({ reports, saved: rows.map(({ x }) => x), explorerWeb: cfg.explorerWeb, head: head.toString(), people, kalos, now });
  writeFileSync(join(cfg.outDir, "site.json"), `${JSON.stringify(bundle)}\n`);
  if (bundle.kalos) log(`site data for ${bundle.kalos.coins.length} Kalos coins`);
  log(`site data for ${bundle.coins.length} coins (${Object.keys(bundle.explained).length} explained) in ${cfg.outDir}/site.json`);
} finally {
  store.close();
}
