// Entry point: node --env-file-if-exists=.env src/server.ts   (npm start)
// Loads DELPHI's latest verdicts, then looks for a new scan every REFRESH_SEC.
import { buildApp } from "./api.ts";
import { dirname, join } from "node:path";
import { WalletReads } from "./wallet-reads.ts";
import { BagReader } from "./bag.ts";
import { BasketReader, chainRewards, indexerCalls } from "./basket.ts";
import { CampaignReader } from "./campaign.ts";
import { makeClient } from "./chain.ts";
import { loadConfig } from "./config.ts";
import { FreshChecks, runDelphi } from "./fresh.ts";
import { Guard, GuardReader } from "./guard.ts";
import { ElsewhereReader, publicCalls } from "./elsewhere.ts";
import { chainFootprint, FootprintReader } from "./footprint.ts";
import { chainHistory, HistoryReader } from "./history.ts";
import { chainBalances, HoldingsReader } from "./holdings.ts";
import { scanStages } from "./scan.ts";
import { knownContracts } from "./known.ts";
import { chainStake, StakeReader } from "./stake.ts";
import { RecordReader, roundsCalls } from "./record.ts";
import { roundVoters, StandingReader } from "./standing.ts";
import { RoundReader, trialsCalls } from "./trials.ts";
import { Verdicts } from "./verdicts.ts";

const cfg = loadConfig();
const verdicts = new Verdicts(cfg.scanFile);
// Not the server's logger: Guard can log while it starts, before the server exists.
const guard = new Guard(cfg.guardFile, { log: (msg) => console.warn(`[guard] ${msg}`) });
/** New verdicts or sales have arrived: Guard looks them over. */
function watch() {
  const added = guard.observe(verdicts.seen()) + guard.observeSales(verdicts.sales(), (t) => verdicts.seenOne(t));
  if (added) app.log.info({ added }, "new guard alerts");
}
const fresh = cfg.freshReads
  ? new FreshChecks(verdicts, runDelphi(cfg.delphiDir), { gapMs: cfg.freshGapSec * 1000, log: (msg) => app.log.info(msg), onLoaded: watch })
  : undefined;
const chain = makeClient(cfg.rpc);
const holdings = new HoldingsReader(() => verdicts.coins(), chainBalances(chain));
const archive = makeClient(cfg.archiveRpc, { batch: true });
const history = new HistoryReader(verdicts, chainHistory(archive));
const footprint = new FootprintReader({ network: () => verdicts.health().network, verdict: (t) => verdicts.get(t) }, chainFootprint(archive), knownContracts(cfg.deployment));
const stake = new StakeReader(() => verdicts.health().network, chainStake(chain, { staking: cfg.deployment.staking, passport: cfg.deployment.passportRegistry }));
const elsewhere = cfg.elsewhereReads ? new ElsewhereReader(publicCalls(), { log: (msg) => app.log.warn(msg) }) : undefined;
const bag = new BagReader(holdings, verdicts, fresh, footprint, (msg) => app.log.warn(msg));
const indexer = indexerCalls(cfg.indexerUrl);
const rounds = roundsCalls(cfg.trialsUrl);
const standing = new StandingReader({ history, stake, indexer, voters: roundVoters(rounds.rounds) });
const scan = (wallet: string) => scanStages(wallet, { history, holdings, standing, footprint, elsewhere, bag: (h, f) => bag.fromHoldings(h, f), log: (msg) => app.log.warn(msg) });
const basket = new BasketReader({ verdicts, stake, indexer, rewards: chainRewards(chain, cfg.deployment.staking), usdc: cfg.deployment.usdc });
const round = new RoundReader(verdicts, trialsCalls(cfg.trialsUrl));
const record = new RecordReader(verdicts, rounds, async () => new Set((await basket.basket()).coins.map((c) => c.token)));
const reads = new WalletReads(join(dirname(cfg.guardFile), "wallet-reads"), scan);
const app = buildApp(verdicts, { logger: true, holdings, history, bag, scan, reads, stake, basket, standing, guard: new GuardReader(guard, holdings), round, record, campaigns: new CampaignReader(round), footprint, elsewhere, ...(fresh ? { fresh } : {}) });

let lastSaid: string | null = null;
function refresh() {
  if (verdicts.refresh()) {
    const { coins, scannedAt } = verdicts.health();
    app.log.info({ coins, scannedAt }, "new verdicts loaded");
    watch();
  }
  const { lastError } = verdicts.health();
  if (lastError && lastError !== lastSaid) app.log.warn({ error: lastError }, "can't read DELPHI's results; keeping the last good copy");
  lastSaid = lastError;
}

refresh();
const timer = setInterval(refresh, cfg.refreshSec * 1000);
const guardTimer = fresh ? setInterval(() => fresh.tick(), cfg.guardReadSec * 1000) : undefined;
await app.listen({ host: "127.0.0.1", port: cfg.port });

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, async () => {
    clearInterval(timer);
    clearInterval(guardTimer);
    fresh?.stop();
    await app.close();
    process.exit(0);
  });
}
