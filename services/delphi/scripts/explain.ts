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
import { siteBundle, type Saved } from "../src/ai/site.ts";
import { loadWorkspace } from "../src/ai/workspace.ts";
import { makeClient, mapLimit } from "../src/chain.ts";
import { loadConfig } from "../src/config.ts";
import { peopleOf } from "../src/graph.ts";
import { collect } from "../src/ingest.ts";
import { analyze, mdText, type CoinReport } from "../src/report.ts";
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
  const { coins, head, hubs } = await collect({ client, store, cfg, explorer: null, log });
  const now = new Date();
  const reports = coins.map((d) => analyze(d, { explorerWeb: cfg.explorerWeb, now }));
  const ws = await loadWorkspace({ client, store, cfg, coins, reports, hubs });

  const worth = (r: CoinReport) => r.verdict !== "NOT_ENOUGH_DATA" || r.stats.trades >= 5;
  const targets = reports.filter((r) => (only ? r.coin.token === only : args.includes("--all") || worth(r)));
  if (only && targets.length === 0) throw new Error(`${only} is not an Ascend coin launched from ${cfg.launchpad}`);
  const dir = join(cfg.outDir, "coins");
  mkdirSync(dir, { recursive: true });
  const saved = (r: CoinReport) => join(dir, `${r.coin.token}.ai.json`);
  const fresh = (r: CoinReport) =>
    existsSync(saved(r)) && (JSON.parse(readFileSync(saved(r), "utf8")) as Explained).key === explanationKey(r);
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
  const bundle = siteBundle({ reports, saved: rows.map(({ x }) => x), explorerWeb: cfg.explorerWeb, head: head.toString(), people, now });
  writeFileSync(join(cfg.outDir, "site.json"), `${JSON.stringify(bundle)}\n`);
  log(`site data for ${bundle.coins.length} coins (${Object.keys(bundle.explained).length} explained) in ${cfg.outDir}/site.json`);
} finally {
  store.close();
}
