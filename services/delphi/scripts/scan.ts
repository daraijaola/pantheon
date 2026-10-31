// Scans every Ascend coin on Elysium testnet and writes one report per coin, plus an index.
// Read-only: public chain reads, no keys, no transactions. Live, so run it by hand:
//   node scripts/scan.ts                  everything (first run fills the cache: a few minutes)
//   node scripts/scan.ts --no-explorer    cached funding data only (no new funding lookups)
//   node scripts/scan.ts --only 0x…       one coin's report (the scan itself still covers all coins)
//   node scripts/scan.ts --no-kalos       Ascend coins only (skip every coin on Kalos)
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAddress, isAddress } from "viem";
import { makeClient } from "../src/chain.ts";
import { loadConfig, RULES } from "../src/config.ts";
import { ChainFunding } from "../src/funding.ts";
import { BatchRpc } from "../src/rpc.ts";
import { collect } from "../src/ingest.ts";
import { analyze, toIndexMarkdown, toMarkdown, type CoinReport } from "../src/report.ts";
import { Store } from "../src/store.ts";

const args = process.argv.slice(2);
const onlyArg = args.includes("--only") ? args[args.indexOf("--only") + 1] : undefined;
if (onlyArg !== undefined && !isAddress(onlyArg, { strict: false })) {
  console.error("--only needs a token address");
  process.exit(2);
}
const only = onlyArg ? getAddress(onlyArg) : undefined;

const cfg = loadConfig();
const store = new Store(cfg.dbPath);
// Funding is read from the chain itself: the explorer's API sits behind a bot checkpoint since Oct 25.
const explorer = args.includes("--no-explorer") ? null : new ChainFunding();
const log = (m: string) => console.error(`[delphi] ${m}`);
const bigints = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

try {
  const started = Date.now();
  const kalos = args.includes("--no-kalos") ? null : { rpc: new BatchRpc() };
  const { coins, head, notes, liquidity } = await collect({ client: makeClient(cfg.elysiumRpc, (ms, what) => log(`RPC asked us to slow down (${what}): waiting ${ms / 1000} s`)), store, cfg, explorer, kalos, log });
  const now = new Date();
  const reports = coins
    .filter((d) => !only || d.coin.token === only)
    .map((d) => analyze(d, { explorerWeb: cfg.explorerWeb, now }));
  if (only && reports.length === 0) throw new Error(`${only} is not a coin DELPHI reads (Ascend launches${kalos ? " and Kalos pools" : ""})`);
  // A Kalos coin's own notes (decimals, supply changes, how it was read) go with its report.
  for (const r of reports) for (const n of liquidity.get(r.coin.token.toLowerCase())?.notes ?? []) if (!r.notes.includes(n)) r.notes.push(n);

  // File names come from the token address only, never from the coin's self-chosen name.
  const dir = join(cfg.outDir, "coins");
  mkdirSync(dir, { recursive: true });
  const file = (r: CoinReport) => `coins/${r.coin.token}.md`;
  for (const r of reports) {
    writeFileSync(join(dir, `${r.coin.token}.json`), `${JSON.stringify(r, null, 2)}\n`);
    writeFileSync(join(dir, `${r.coin.token}.md`), toMarkdown(r));
    const liq = liquidity.get(r.coin.token.toLowerCase());
    if (liq) writeFileSync(join(dir, `${r.coin.token}.liquidity.json`), `${JSON.stringify(liq, bigints, 2)}\n`);
  }
  if (!only) {
    writeFileSync(join(cfg.outDir, "index.md"), toIndexMarkdown(reports, file));
    const scan = { rules: RULES, network: cfg.network, generatedAt: now.toISOString(), head: head.toString(), launchpad: cfg.launchpad, notes, reports };
    writeFileSync(join(cfg.outDir, "scan.json"), `${JSON.stringify(scan, null, 2)}\n`);
  }

  const count = (v: CoinReport["verdict"]) => reports.filter((r) => r.verdict === v).length;
  log(`done in ${Math.round((Date.now() - started) / 1000)} s, up to block ${head}`);
  log(`rules ${RULES.version}, ${cfg.network} profile`);
  const kalosCount = reports.filter((r) => r.coin.market === "kalos").length;
  if (kalosCount) log(`${kalosCount} of them on Kalos`);
  log(`${reports.length} coins: ${count("FLAG")} FLAG, ${count("WATCH")} WATCH, ${count("CLEAN")} CLEAN, ${count("NOT_ENOUGH_DATA")} NOT ENOUGH DATA`);
  for (const n of notes) log(`note: ${n}`);
  log(`reports in ${cfg.outDir}/`);
} finally {
  store.close();
}
