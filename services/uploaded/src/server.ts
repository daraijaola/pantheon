// Entry point: node --env-file-if-exists=.env src/server.ts   (npm start)
// Loads DELPHI's latest verdicts, then looks for a new scan every REFRESH_SEC.
import { buildApp } from "./api.ts";
import { BagReader } from "./bag.ts";
import { BasketReader, chainRewards, indexerCalls } from "./basket.ts";
import { makeClient } from "./chain.ts";
import { loadConfig } from "./config.ts";
import { FreshChecks, runDelphi } from "./fresh.ts";
import { chainHistory, HistoryReader } from "./history.ts";
import { chainBalances, HoldingsReader } from "./holdings.ts";
import { scanStages } from "./scan.ts";
import { chainStake, StakeReader } from "./stake.ts";
import { Verdicts } from "./verdicts.ts";

const cfg = loadConfig();
const verdicts = new Verdicts(cfg.scanFile);
const fresh = cfg.freshReads
  ? new FreshChecks(verdicts, runDelphi(cfg.delphiDir), { gapMs: cfg.freshGapSec * 1000, log: (msg) => app.log.info(msg) })
  : undefined;
const chain = makeClient(cfg.rpc);
const holdings = new HoldingsReader(() => verdicts.coins(), chainBalances(chain));
const history = new HistoryReader(verdicts, chainHistory(makeClient(cfg.archiveRpc, { batch: true })));
const stake = new StakeReader(() => verdicts.health().network, chainStake(chain, { staking: cfg.deployment.staking, passport: cfg.deployment.passportRegistry }));
const bag = new BagReader(holdings, verdicts, fresh);
const scan = (wallet: string) => scanStages(wallet, { history, holdings, bag: (h) => bag.fromHoldings(h), log: (msg) => app.log.warn(msg) });
const basket = new BasketReader({ verdicts, stake, indexer: indexerCalls(cfg.indexerUrl), rewards: chainRewards(chain, cfg.deployment.staking), usdc: cfg.deployment.usdc });
const app = buildApp(verdicts, { logger: true, holdings, history, bag, scan, stake, basket, ...(fresh ? { fresh } : {}) });

let lastSaid: string | null = null;
function refresh() {
  if (verdicts.refresh()) {
    const { coins, scannedAt } = verdicts.health();
    app.log.info({ coins, scannedAt }, "new verdicts loaded");
  }
  const { lastError } = verdicts.health();
  if (lastError && lastError !== lastSaid) app.log.warn({ error: lastError }, "can't read DELPHI's results; keeping the last good copy");
  lastSaid = lastError;
}

refresh();
const timer = setInterval(refresh, cfg.refreshSec * 1000);
await app.listen({ host: "127.0.0.1", port: cfg.port });

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, async () => {
    clearInterval(timer);
    fresh?.stop();
    await app.close();
    process.exit(0);
  });
}
