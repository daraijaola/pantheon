// Entry point: node --env-file-if-exists=.env src/server.ts   (npm start)
// Wires config, keys, clients, storage and the API, and listens on 127.0.0.1 only.
import { loadAttestor, loadPepper } from "./attest.ts";
import { loadConfig } from "./config.ts";
import { openDatabase, PassportStore, SqliteChallengeStore } from "./db.ts";
import { createHyperEvmReader } from "./evm/hyperevm.ts";
import { createHlClient } from "./hl/client.ts";
import { buildApp } from "./api.ts";
import { createElysiumClient, createRegistryReader } from "./registry.ts";
import { PassportService } from "./service.ts";

const config = loadConfig();
if (!config.registryAddress) {
  console.error("REGISTRY_ADDRESS is not set: deploy HypePassportRegistry first (P9)");
  process.exit(1);
}

const db = openDatabase(config.dbPath);
const service = new PassportService({
  chainId: config.chainId,
  challenges: new SqliteChallengeStore(db),
  store: new PassportStore(db),
  hl: createHlClient(config),
  evm: createHyperEvmReader(config),
  registry: createRegistryReader(createElysiumClient(config), config.registryAddress),
  attestor: loadAttestor(config.attestorKeyFile),
  pepper: loadPepper(config.pepperFile),
  // relayer: P8
});

const app = buildApp(service, { logger: true });
await app.listen({ host: config.host, port: config.port });

// systemd / Ctrl-C: finish in-flight requests, then close the database cleanly.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, async () => {
    await app.close();
    db.close();
    process.exit(0);
  });
}
