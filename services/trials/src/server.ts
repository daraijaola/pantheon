// Entry point: node --env-file-if-exists=.env src/server.ts   (npm start)
// Round files are re-read on every request (there are only a few), so opening a round is just
// committing its file: no restart needed.
import { createPublicClient, defineChain, http, parseAbi } from "viem";
import { buildApp } from "./api.ts";
import { loadConfig } from "./config.ts";
import { loadRounds } from "./round.ts";
import { Ballots } from "./state.ts";

const cfg = loadConfig();
const chain = defineChain({
  id: cfg.chainId,
  name: "Elysium",
  nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
  rpcUrls: { default: { http: [cfg.rpc] } },
});
const client = createPublicClient({ chain, transport: http(cfg.rpc, { retryCount: 3, timeout: 20_000 }) });
const PASSPORT = parseAbi(["function tierOf(address account) view returns (uint8)"]);

const app = buildApp(
  {
    rounds: () => loadRounds(cfg.roundsDir),
    ballots: new Ballots(cfg.stateFile),
    tierOf: async (voter) => Number(await client.readContract({ address: cfg.passportRegistry, abi: PASSPORT, functionName: "tierOf", args: [voter] })),
    chainId: cfg.chainId,
  },
  { logger: true },
);
await app.listen({ host: "127.0.0.1", port: cfg.port });

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, async () => {
    await app.close();
    process.exit(0);
  });
}
