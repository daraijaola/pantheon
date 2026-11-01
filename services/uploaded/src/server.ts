// Entry point: node --env-file-if-exists=.env src/server.ts   (npm start)
// Loads DELPHI's latest verdicts, then looks for a new scan every REFRESH_SEC.
import { buildApp } from "./api.ts";
import { loadConfig } from "./config.ts";
import { FreshChecks, runDelphi } from "./fresh.ts";
import { Verdicts } from "./verdicts.ts";

const cfg = loadConfig();
const verdicts = new Verdicts(cfg.scanFile);
const fresh = cfg.freshReads
  ? new FreshChecks(verdicts, runDelphi(cfg.delphiDir), { gapMs: cfg.freshGapSec * 1000, log: (msg) => app.log.info(msg) })
  : undefined;
const app = buildApp(verdicts, { logger: true, ...(fresh ? { fresh } : {}) });

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
