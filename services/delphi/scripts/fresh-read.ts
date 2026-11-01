// One fresh read of every Ascend coin, printed as JSON in the shape of out/scan.json, for Get uploaded's
// "check any coin". It takes about 10 s, and every market together about 3.5 minutes, so only Ascend is
// read here. It uses the same cache and rules as the scan and writes only to that cache.
//   node scripts/fresh-read.ts
import { accessSync, constants, existsSync } from "node:fs";
import { makeClient } from "../src/chain.ts";
import { loadConfig } from "../src/config.ts";
import { ChainFunding } from "../src/funding.ts";
import { collect } from "../src/ingest.ts";
import { analyze } from "../src/report.ts";
import { Store } from "../src/store.ts";

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
const store = new Store(cfg.dbPath);
try {
  const client = makeClient(cfg.elysiumRpc, (ms, what) => log(`RPC asked us to slow down (${what}): waiting ${ms / 1000} s`));
  const { coins, head } = await collect({ client, store, cfg, explorer: new ChainFunding(), log });
  const now = new Date();
  const reports = coins.map((d) => analyze(d, { explorerWeb: cfg.explorerWeb, now }));
  process.stdout.write(JSON.stringify({ network: cfg.network, generatedAt: now.toISOString(), head: head.toString(), reports }));
} finally {
  store.close();
}
