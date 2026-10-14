// One practice round, printed for people (run by hand; live network, read-only, sends nothing):
//   node --env-file-if-exists=.env scripts/once.ts
// It does not save its state, so it never moves the running keeper's cursors.
import { makeClient } from "../src/chain.ts";
import { loadConfig } from "../src/config.ts";
import { createChain, passportFeed, tick } from "../src/keeper.ts";
import { loadState } from "../src/state.ts";

const cfg = { ...loadConfig(), mode: "dry" as const };
const state = loadState(cfg.stateFile, cfg.fromBlock);
const r = await tick({ cfg, chain: createChain(makeClient(cfg.rpc), cfg), pokes: passportFeed(cfg.passportApi), state });

console.log(`Keeper practice round at block ${r.head} (${r.at})`);
console.log(`Stakers known: ${r.stakers}, boosts checked: ${r.checked}`);
for (const c of r.calls) {
  console.log(`\n${c.worthSending ? "WOULD SEND" : "skip      "}  ${c.kind}  (~${c.gas} gas)`);
  for (const l of c.lines) console.log(`  - ${l}`);
}
console.log(`\nCost if sent: ${r.cost}`);
for (const n of r.notes) console.log(`Note: ${n}`);
