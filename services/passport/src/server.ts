// Entry point: node --env-file-if-exists=.env src/server.ts   (npm start)
// Wires config, keys, clients, storage and the API, and listens on 127.0.0.1 only.
import { loadAttestor, loadPepper } from "./attest.ts";
import { loadConfig } from "./config.ts";
import { openDatabase, PassportStore, SqliteChallengeStore } from "./db.ts";
import { createHyperEvmReader } from "./evm/hyperevm.ts";
import { createHlClient } from "./hl/client.ts";
import { buildApp } from "./api.ts";
import { existsSync } from "node:fs";
import { createElysiumClient, createRegistryReader } from "./registry.ts";
import { createElysiumRelayer } from "./relayer.ts";
import { Scheduler } from "./scheduler.ts";
import { PassportService } from "./service.ts";
import { createPreflightReader, preflight, PreflightError } from "./preflight.ts";

const config = loadConfig();
if (!config.registryAddress) {
  console.error("REGISTRY_ADDRESS is not set: deploy HypePassportRegistry first (P9)");
  process.exit(1);
}

const db = openDatabase(config.dbPath);
const elysium = createElysiumClient(config);
// Without a relayer key the API still signs; users submit themselves and re-checks stay signed-only.
const relayer = existsSync(config.relayerKeyFile) ? createElysiumRelayer(config, elysium) : undefined;
const deps = {
  chainId: config.chainId,
  challenges: new SqliteChallengeStore(db),
  store: new PassportStore(db),
  hl: createHlClient(config),
  evm: createHyperEvmReader(config),
  registry: createRegistryReader(elysium, config.registryAddress),
  attestor: loadAttestor(config.attestorKeyFile),
  relayer,
};
// The registry must trust our attestor and share our signing domain, or every passport would bounce.
try {
  await preflight(createPreflightReader(elysium, config.registryAddress), {
    chainId: config.chainId,
    registry: config.registryAddress,
    attestor: deps.attestor.address,
  });
} catch (e) {
  if (!(e instanceof PreflightError)) throw e;
  console.error(`refusing to start: ${e.message}`);
  process.exit(1);
}
const service = new PassportService({ ...deps, pepper: loadPepper(config.pepperFile) });
const scheduler = new Scheduler(deps);

const app = buildApp(service, { logger: true });
await app.listen({ host: config.host, port: config.port });
if (!relayer) app.log.warn(`no relayer key at ${config.relayerKeyFile}: attestations are returned, not relayed`);
scheduler.start(60_000, (r) => {
  if (r.checked || r.signed || r.unlinked || r.errors.length) app.log.info({ scheduler: r }, "scheduler run");
});

// systemd / Ctrl-C: finish in-flight requests, then close the database cleanly.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, async () => {
    scheduler.stop();
    await app.close();
    db.close();
    process.exit(0);
  });
}
