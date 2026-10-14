// Entry point: node --env-file-if-exists=.env src/server.ts   (npm start)
// Reads the chain once before answering, then polls every POLL_SEC (never two polls at once).
import { buildApp } from "./api.ts";
import { makeClient } from "./chain.ts";
import { loadConfig } from "./config.ts";
import { Indexer, loadSaved, save } from "./indexer.ts";
import type { Ctx } from "./views.ts";

const cfg = loadConfig();
const indexer = new Indexer(makeClient(cfg.rpc), cfg, loadSaved(cfg.stateFile, cfg.fromBlock));
const d = cfg.deployment;
const ctx = (): Ctx | null =>
  indexer.live
    ? { records: indexer.saved.records, live: indexer.live, explorer: cfg.explorer, usdc: d.usdc, pnth: d.pnth, nowSec: Math.floor(Date.now() / 1000) }
    : null;

const app = buildApp(ctx, { logger: true });
await app.listen({ host: "127.0.0.1", port: cfg.port });

let stopping = false;
let timer: NodeJS.Timeout | undefined;
async function loop() {
  try {
    const added = await indexer.poll();
    save(cfg.stateFile, indexer.saved);
    if (added) app.log.info({ added, block: indexer.live?.block, events: indexer.saved.records.length }, "indexed");
  } catch (e) {
    app.log.warn({ error: (e as Error).message.split("\n")[0] }, "poll failed; serving the last good data");
  }
  if (!stopping) timer = setTimeout(loop, cfg.pollSec * 1000);
}
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, async () => {
    stopping = true;
    clearTimeout(timer);
    await app.close();
    process.exit(0);
  });
}
await loop();
