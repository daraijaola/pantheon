// End-to-end test of the indexer on a local fork of Elysium (never the real chain). Run by hand:
//   anvil --host 127.0.0.1 --port 8547 --fork-url https://testnet-rpc.elysium.kinetiq.xyz --compute-units-per-second 40
//   node scripts/fork-test.ts [http://127.0.0.1:8547]
// On the fork it makes every kind of event PANTHEON emits: fees burned and sent to the basket, basket
// proposal 0 started, the basket buying its coins, a stake, an unstake, a cancel, a withdraw and a claim.
// Then it runs the indexer and checks its answers against the fork's own numbers.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestClient, createWalletClient, http, parseAbi, parseUnits, type Address, type Hex } from "viem";
import { buildApp } from "../src/api.ts";
import { makeClient, tokenAbi } from "../src/chain.ts";
import { loadConfig } from "../src/config.ts";
import { Indexer, loadSaved } from "../src/indexer.ts";

const FORK = process.argv[2] ?? "http://127.0.0.1:8547";
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(FORK)) throw new Error("fork-test only runs against a local fork");
const cfg = { ...loadConfig({ ...process.env, ELYSIUM_RPC: FORK }), stateFile: join(mkdtempSync(join(tmpdir(), "indexer-fork-")), "index.json") };
const d = cfg.deployment;
const client = makeClient(FORK);
const chain = { id: 99_801, name: "fork", nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 }, rpcUrls: { default: { http: [FORK] } } } as const;
// A fresh fork fetches contract storage from the public RPC on first use (rate-limited): be patient.
const test = createTestClient({ mode: "anvil", chain, transport: http(FORK, { timeout: 300_000 }) });
const TRADER: Address = "0x000000000000000000000000000000000000ac1d";
const SWAPPER: Address = "0x31A67d054D34Ec18cb23A43B0E3ad1F756aA1500";
const PM: Address = "0x12E84206cB53aE0df055482ebc4658635096E1aA";
const PNTH_POOL: Hex = "0x301789b69e15b7fe9bbc0dbd39145b2fe78bba9bd0b9bb2d74de64e1d665f22d";
const wallet = createWalletClient({ account: TRADER, chain, transport: http(FORK, { timeout: 300_000 }) });

const abi = parseAbi([
  "function mint(address to, uint256 value)",
  "function approve(address spender, uint256 value) returns (bool)",
  "struct PoolKey { address currency0; address currency1; address hooks; address poolManager; uint24 fee; bytes32 parameters; }",
  "function swapExactIn(PoolKey key, bool zeroForOne, uint256 amountIn) returns (uint256 out)",
  "function poolIdToPoolKey(bytes32 id) view returns (address, address, address, address, uint24, bytes32)",
  "function run() returns (uint256, uint256)",
  "function execute(uint256 id)",
  "function rebalance(uint256 k)",
  "function stake(uint256 amount)",
  "function requestUnstake(uint256 amount)",
  "function cancelUnstake()",
  "function withdraw()",
  "function claim()",
  "struct Constituent { bytes32 poolId; address token; uint16 weightBps; uint128 perRunCap; }",
  "struct Proposal { uint64 eta; bool vetoed; bool executed; bytes32 scoreRoot; string methodologyURI; }",
  "function proposal(uint256 id) view returns (Proposal, Constituent[])",
  "function totalStaked() view returns (uint256)",
]);

let failed = 0;
const check = (what: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
};
let step = "";
const send = async (address: Address, functionName: string, args: unknown[] = []) => {
  step = `${functionName} on ${address.slice(0, 10)}`;
  // Estimate plus 50%: staking costs more when time has passed (the keeper uses the same margin).
  const gas = ((await client.estimateContractGas({ address, abi, functionName, args, account: TRADER } as never)) * 3n) / 2n;
  const hash = await wallet.writeContract({ address, abi, functionName, args, gas } as never);
  const r = await client.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${step} reverted on the fork (tx ${hash})`);
};
const keyOf = async (poolId: Hex) => {
  const [currency0, currency1, hooks, poolManager, fee, parameters] = (await client.readContract({ address: PM, abi, functionName: "poolIdToPoolKey", args: [poolId] })) as readonly [Address, Address, Address, Address, number, Hex];
  return { currency0, currency1, hooks, poolManager, fee, parameters };
};
/** Buy `usdc` worth of the coin in `poolId` (the coin is whichever side isn't USDC). */
const buy = async (poolId: Hex, usdc: bigint) => {
  const key = await keyOf(poolId);
  await send(d.usdc, "approve", [SWAPPER, usdc]);
  await send(SWAPPER, "swapExactIn", [key, key.currency0.toLowerCase() === d.usdc.toLowerCase(), usdc]);
};
const bal = (token: Address, who: Address) => client.readContract({ address: token, abi: tokenAbi, functionName: "balanceOf", args: [who] });

// Elysium runs Arbitrum's node software: anvil answers calls only after mining a block of its own.
await test.mine({ blocks: 1 });
await test.setBalance({ address: TRADER, value: 10n ** 18n });
await test.impersonateAccount({ address: TRADER });
console.log(`fork ${FORK} at block ${await client.getBlockNumber()}\n`);

// Fees on both sides of PNTH's pool, routed: a burn and a basket payment.
console.log("  trading PNTH, then routing its fees");
await send(d.usdc, "mint", [TRADER, parseUnits("1000", 6)]);
await buy(PNTH_POOL, parseUnits("200", 6));
const pnthKey = await keyOf(PNTH_POOL);
await send(d.pnth, "approve", [SWAPPER, parseUnits("1000000", 18)]);
await send(SWAPPER, "swapExactIn", [pnthKey, pnthKey.currency0.toLowerCase() === d.pnth.toLowerCase(), parseUnits("1000000", 18)]);
await send(d.pnthRouter, "run");

// A staker who unstakes, changes their mind, unstakes again.
await send(d.pnth, "approve", [d.staking, parseUnits("5000000", 18)]);
await send(d.staking, "stake", [parseUnits("5000000", 18)]);
await send(d.staking, "requestUnstake", [parseUnits("1000000", 18)]);
await send(d.staking, "cancelUnstake");
await send(d.staking, "requestUnstake", [parseUnits("1000000", 18)]);

// Basket proposal 0 starts once its 24 hours are up; then fresh prices and a rebalance buy the coins.
const [p0, list] = (await client.readContract({ address: d.constituentRegistry, abi, functionName: "proposal", args: [0n] })) as unknown as [{ eta: bigint }, Array<{ poolId: Hex; token: Address }>];
await test.setNextBlockTimestamp({ timestamp: p0.eta + 60n });
await test.mine({ blocks: 1 });
await send(d.constituentRegistry, "execute", [0n]);
for (const c of list) {
  console.log(`  settle: 1 USDC of ${c.token.slice(0, 10)}`);
  await buy(c.poolId, parseUnits("1", 6)); // Micheal's "settle": a fresh price average
}
await send(d.usdc, "mint", [d.indexVault, parseUnits("50", 6)]);
const vaultBefore = await bal(d.usdc, d.indexVault);
await send(d.indexVault, "rebalance", [5n]);
const vaultAfter = await bal(d.usdc, d.indexVault);

// Three days on: the unstake can be withdrawn and the streamed basket coins claimed.
await test.increaseTime({ seconds: 3 * 86_400 + 60 });
await test.mine({ blocks: 1 });
await send(d.staking, "withdraw");
await send(d.staking, "claim");

// Now the indexer, from the deployment block, on the fork.
const ix = new Indexer(client, cfg, loadSaved(cfg.stateFile, cfg.fromBlock));
const added = await ix.poll();
const app = buildApp(() => (ix.live ? { records: ix.saved.records, live: ix.live, explorer: cfg.explorer, usdc: d.usdc, pnth: d.pnth, nowSec: Number((ix.live.readAt)) } : null));
const get = async (url: string) => (await app.inject(url)).json();
console.log(`indexed ${added} events\n`);

const kinds = new Set(ix.saved.records.map((r) => r.kind));
for (const k of ["proposed", "executed", "run", "burn", "to-basket", "buy", "stream", "reward", "stake", "unstake", "cancel-unstake", "withdraw", "claim"]) check(`saw a "${k}" event`, kinds.has(k as never));

const s = await get("/stats");
check("burned = the burn sink's balance on the fork", s.pnth.burned.raw === (await bal(d.pnth, d.burnSink)).toString(), s.pnth.burned.value);
check("burned from fees counts both fee runs (Micheal's and ours)", s.pnth.burns === 2, `${s.pnth.burns} burns`);
check("basket spent = what left the vault in the rebalance", s.basket.spent.raw === (vaultBefore - vaultAfter).toString(), `${s.basket.spent.value} USDC in ${s.basket.buys} buys, ${s.basket.skips} skips`);
check("basket waiting = the vault's USDC now", s.basket.waiting.raw === vaultAfter.toString());
check("total staked = the staking contract's own total", s.staking.totalStaked.raw === (await client.readContract({ address: d.staking, abi, functionName: "totalStaked" })).toString());
check("stakers counted: the deployer and the trader", s.staking.stakers === 2, String(s.staking.stakers));
check("rewards now include the basket coins, not just USDC", s.staking.rewards.length > 1, s.staking.rewards.map((r: { symbol: string }) => r.symbol).join(", "));
check("the indexer's own cross-checks agree", s.consistent.stakedTotal && s.consistent.burnedFromFeesNotAboveBurnSink);

const b = await get("/basket");
check("proposal 0 is the active basket", b.active?.id === 0 && b.proposals[0].status === "active");
check("the active basket shows its 5 coins and its start transaction", b.active?.coins.length === 5 && !!b.active?.started?.url);
const bought = b.active?.coins.filter((c: { buys: number }) => c.buys > 0) ?? [];
check("coins the basket bought show amounts and a receipt", bought.length > 0 && bought.every((c: { bought: { raw: string }; lastBuy: { url: string } }) => BigInt(c.bought.raw) > 0n && c.lastBuy.url.includes("/tx/")), bought.map((c: { symbol: string; bought: { value: string } }) => `${c.symbol} ${Number(c.bought.value).toFixed(0)}`).join(", "));
for (const c of b.active?.coins ?? []) if (c.lastSkip) console.log(`      ${c.symbol} skipped: ${c.lastSkip.reason}`);

const r = await get(`/receipts?account=${TRADER}`);
check("the trader's receipts: stake, unstakes, cancel, withdraw, claims", ["stake", "unstake", "cancel-unstake", "withdraw", "claim"].every((k) => r.items.some((x: { kind: string }) => x.kind === k)), r.items.map((x: { kind: string }) => x.kind).join(","));
const page1 = await get("/receipts?limit=5");
const page2 = await get(`/receipts?limit=5&before=${page1.next}`);
check("paging gives the next older events without overlap", page2.items.length > 0 && page2.items[0].block <= page1.items[4].block && !page2.items.some((x: { tx: string; logIndex: number }) => page1.items.some((y: { tx: string; logIndex: number }) => y.tx === x.tx && y.logIndex === x.logIndex)));

console.log(`\n${failed === 0 ? "all checks passed" : `${failed} check(s) failed`}`);
process.exit(failed ? 1 : 0);
