// What-if probe, run by hand (live network, simulation only: nothing is ever sent):
//   node --env-file-if-exists=.env scripts/probe-whatif.ts [usdc-to-trade]
// In one simulated block: mint test USDC (Ascend's mock USDC mint is public), buy PNTH with it, sell
// part back, so fees accrue on both sides. Then the keeper's own calls: route PNTH's fees, then
// rebalance the basket. Their events are decoded exactly like a real keeper round would decode them.
import { parseAbi, parseUnits, type Address } from "viem";
import { effectsOf, makeClient, routerAbi, vaultAbi } from "../src/chain.ts";
import { loadConfig } from "../src/config.ts";
import { DRY_SENDER } from "../src/keeper.ts";
import { describe, type Kind } from "../src/plan.ts";

const cfg = loadConfig();
const dep = cfg.deployment;
const client = makeClient(cfg.rpc);
const usdcIn = parseUnits(process.argv[2] ?? "200", 6);
const SWAPPER = "0x31A67d054D34Ec18cb23A43B0E3ad1F756aA1500" as Address; // deployments/elysium-testnet-tools.json
const sellPnth = parseUnits("1000000", 18);

const tokenAbi = parseAbi(["function mint(address to, uint256 value)", "function approve(address spender, uint256 value) returns (bool)"]);
const swapperAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; address hooks; address poolManager; uint24 fee; bytes32 parameters; }",
  "function swapExactIn(PoolKey key, bool zeroForOne, uint256 amountIn) returns (uint256 out)",
]);
const pmAbi = parseAbi(["function poolIdToPoolKey(bytes32 id) view returns (address, address, address, address, uint24, bytes32)"]);
const pm = "0x12E84206cB53aE0df055482ebc4658635096E1aA" as Address;
const pnthPool = "0x301789b69e15b7fe9bbc0dbd39145b2fe78bba9bd0b9bb2d74de64e1d665f22d" as const;
const [c0, c1, hooks, poolManager, fee, parameters] = await client.readContract({ address: pm, abi: pmAbi, functionName: "poolIdToPoolKey", args: [pnthPool] });
const key = { currency0: c0, currency1: c1, hooks, poolManager, fee, parameters };
const pnthIs0 = c0.toLowerCase() === dep.pnth.toLowerCase();

const { results } = await client.simulateCalls({
  account: DRY_SENDER,
  validation: false,
  calls: [
    { to: dep.usdc, abi: tokenAbi, functionName: "mint", args: [DRY_SENDER, usdcIn] },
    { to: dep.usdc, abi: tokenAbi, functionName: "approve", args: [SWAPPER, usdcIn] },
    { to: SWAPPER, abi: swapperAbi, functionName: "swapExactIn", args: [key, !pnthIs0, usdcIn] }, // buy PNTH
    { to: dep.pnth, abi: tokenAbi, functionName: "approve", args: [SWAPPER, sellPnth] },
    { to: SWAPPER, abi: swapperAbi, functionName: "swapExactIn", args: [key, pnthIs0, sellPnth] }, // sell some back
    { to: dep.pnthRouter, abi: routerAbi, functionName: "run" },
    { to: dep.indexVault, abi: vaultAbi, functionName: "rebalance", args: [BigInt(cfg.basketK)] },
  ],
});

const labels = ["mint test USDC", "approve", "buy PNTH", "approve", "sell 1,000,000 PNTH", "keeper: run", "keeper: rebalance"];
results.forEach((r, i) => console.log(`${r.status === "success" ? "ok  " : "FAIL"} ${labels[i]}${r.status === "success" ? "" : `: ${(r.error as { shortMessage?: string })?.shortMessage}`}`));
for (const [i, kind] of [[5, "run"], [6, "rebalance"]] as Array<[number, Kind]>) {
  const r = results[i]!;
  const effects = effectsOf((r.logs ?? []) as never, { router: dep.pnthRouter, vault: dep.indexVault, staking: dep.staking });
  console.log(`\n${kind} (~${r.gasUsed} gas):`);
  for (const l of describe({ kind, ok: r.status === "success", gasUsed: r.gasUsed, effects }, { usdc: dep.usdc, pnth: dep.pnth })) console.log(`  - ${l}`);
}
