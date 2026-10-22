// Scans every Ascend coin on Elysium testnet and writes one report per coin, plus an index.
// Read-only: public RPC and explorer reads, no keys, no transactions. Live, so run it by hand:
//   node scripts/scan.ts                  everything (first run fills the cache: a few minutes)
//   node scripts/scan.ts --no-explorer    cached funding data only (when the explorer allowance is used up)
//   node scripts/scan.ts --only 0x…       one coin's report (the scan itself still covers all coins)
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAddress, isAddress } from "viem";
import { makeClient } from "../src/chain.ts";
import { loadConfig, RULES } from "../src/config.ts";
import { Explorer } from "../src/explorer.ts";
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
const explorer = args.includes("--no-explorer") ? null : new Explorer(cfg.explorerApi);
const log = (m: string) => console.error(`[delphi] ${m}`);

try {
  const started = Date.now();
  const { coins, head, notes } = await collect({ client: makeClient(cfg.elysiumRpc, (ms, what) => log(`RPC asked us to slow down (${what}): waiting ${ms / 1000} s`)), store, cfg, explorer, log });
  const now = new Date();
  const reports = coins
    .filter((d) => !only || d.coin.token === only)
    .map((d) => analyze(d, { explorerWeb: cfg.explorerWeb, now }));
  if (only && reports.length === 0) throw new Error(`${only} is not an Ascend coin launched from ${cfg.launchpad}`);

  // File names come from the token address only, never from the coin's self-chosen name.
  const dir = join(cfg.outDir, "coins");
  mkdirSync(dir, { recursive: true });
  const file = (r: CoinReport) => `coins/${r.coin.token}.md`;
  for (const r of reports) {
    writeFileSync(join(dir, `${r.coin.token}.json`), `${JSON.stringify(r, null, 2)}\n`);
    writeFileSync(join(dir, `${r.coin.token}.md`), toMarkdown(r));
  }
  if (!only) {
    writeFileSync(join(cfg.outDir, "index.md"), toIndexMarkdown(reports, file));
    const scan = { rules: RULES, network: cfg.network, generatedAt: now.toISOString(), head: head.toString(), launchpad: cfg.launchpad, notes, reports };
    writeFileSync(join(cfg.outDir, "scan.json"), `${JSON.stringify(scan, null, 2)}\n`);
  }

  const count = (v: CoinReport["verdict"]) => reports.filter((r) => r.verdict === v).length;
  log(`done in ${Math.round((Date.now() - started) / 1000)} s, up to block ${head}`);
  log(`rules ${RULES.version}, ${cfg.network} profile`);
  log(`${reports.length} coins: ${count("FLAG")} FLAG, ${count("WATCH")} WATCH, ${count("CLEAN")} CLEAN, ${count("NOT_ENOUGH_DATA")} NOT ENOUGH DATA`);
  for (const n of notes) log(`note: ${n}`);
  log(`reports in ${cfg.outDir}/`);
} finally {
  store.close();
}
