// Entry point: node --env-file-if-exists=.env src/main.ts   (npm start)
// One keeper round every INTERVAL_SEC, never two at once. Each round is one JSON line on stdout.
// Practice mode (the default) never loads a key and never sends anything.
import { createWalletClient, http, type Address, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { elysium, makeClient, politeFetch } from "./chain.ts";
import { loadConfig, readKeeperKey } from "./config.ts";
import { createChain, passportFeed, tick } from "./keeper.ts";
import { loadState, saveState } from "./state.ts";

const cfg = loadConfig();
const client = makeClient(cfg.rpc);
let wallet: WalletClient | undefined;
let sender: Address | undefined;
if (cfg.mode === "live") {
  const account = privateKeyToAccount(readKeeperKey(cfg.keyFile));
  wallet = createWalletClient({ account, chain: elysium(cfg.rpc), transport: http(cfg.rpc, { fetchFn: politeFetch() }) });
  sender = account.address;
}
const chain = createChain(client, cfg, wallet);
const pokes = passportFeed(cfg.passportApi);
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

console.log(json({ msg: "keeper started", mode: cfg.mode, everySec: cfg.intervalSec, sender: sender ?? "practice (none)" }));

let stopping = false;
let timer: NodeJS.Timeout | undefined;
async function round() {
  const state = loadState(cfg.stateFile, cfg.fromBlock);
  try {
    const report = await tick({ cfg, chain, pokes, state, ...(sender ? { sender } : {}) });
    saveState(cfg.stateFile, state);
    console.log(json(report));
  } catch (e) {
    console.log(json({ msg: "round failed", error: (e as Error).message.split("\n")[0] }));
  }
  if (!stopping) timer = setTimeout(round, cfg.intervalSec * 1000);
}
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    stopping = true;
    clearTimeout(timer);
    console.log(json({ msg: "keeper stopping" }));
  });
}
await round();
