// End-to-end test of the keeper in LIVE mode on a local fork of Elysium (never the real chain).
// Run by hand: start the fork, then this:
//   anvil --host 127.0.0.1 --port 8547 --fork-url https://testnet-rpc.elysium.kinetiq.xyz --compute-units-per-second 40
//   node scripts/fork-test.ts [http://127.0.0.1:8547]
// On the fork it trades PNTH (so fees accrue) and stakes, then runs keeper rounds with anvil's public test
// key and checks what really changed: PNTH burned, the basket's USDC streamed, boosts refreshed after
// time passes, nothing sent when there is nothing to do, nothing sent from an empty wallet, nothing at all
// in practice mode.
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestClient, createWalletClient, http, parseAbi, parseUnits, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { elysium, erc20Abi, makeClient, stakingAbi } from "../src/chain.ts";
import { loadConfig, readKeeperKey } from "../src/config.ts";
import { createChain, tick, type Report } from "../src/keeper.ts";
import type { State } from "../src/state.ts";

const FORK = process.argv[2] ?? "http://127.0.0.1:8547";
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(FORK)) throw new Error("fork-test only runs against a local fork");
// anvil's first account: a public test key, worthless, used only on this local fork.
const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const SWAPPER: Address = "0x31A67d054D34Ec18cb23A43B0E3ad1F756aA1500";
const PNTH_POOL = "0x301789b69e15b7fe9bbc0dbd39145b2fe78bba9bd0b9bb2d74de64e1d665f22d" as const;
const TRADER: Address = "0x000000000000000000000000000000000000ac1d";

const cfg = { ...loadConfig({ ...process.env, ELYSIUM_RPC: FORK, KEEPER_MODE: "live" }), passportApi: "http://127.0.0.1:9" };
const dep = cfg.deployment;
const client = makeClient(FORK);
const test = createTestClient({ mode: "anvil", chain: elysium(FORK), transport: http(FORK) });
const trader = createWalletClient({ account: TRADER, chain: elysium(FORK), transport: http(FORK) });

const tokenAbi = parseAbi(["function mint(address to, uint256 value)", "function approve(address spender, uint256 value) returns (bool)"]);
const stakeAbi = parseAbi(["function stake(uint256 amount)"]);
const swapperAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; address hooks; address poolManager; uint24 fee; bytes32 parameters; }",
  "function swapExactIn(PoolKey key, bool zeroForOne, uint256 amountIn) returns (uint256 out)",
]);
const pmAbi = parseAbi(["function poolIdToPoolKey(bytes32 id) view returns (address, address, address, address, uint24, bytes32)"]);

let failed = 0;
const check = (what: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
};
const bal = (token: Address, who: Address) => client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] });
const send = async (address: Address, abi: never, functionName: string, args: unknown[]) => {
  const hash = await trader.writeContract({ address, abi, functionName, args, chain: elysium(FORK) } as never);
  const r = await client.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${functionName} reverted on the fork`);
};

// Elysium runs Arbitrum's node software, whose block headers lack Ethereum's blob-gas field: anvil
// refuses calls on the forked block itself ("Excess blob gas not set") until it has mined one of its own.
await test.mine({ blocks: 1 });
const [c0, c1, hooks, poolManager, fee, parameters] = await client.readContract({ address: "0x12E84206cB53aE0df055482ebc4658635096E1aA", abi: pmAbi, functionName: "poolIdToPoolKey", args: [PNTH_POOL] });
const key = { currency0: c0, currency1: c1, hooks, poolManager, fee, parameters };
const pnthIs0 = c0.toLowerCase() === dep.pnth.toLowerCase();

/** Some trading on the fork, so PNTH's pool earns fees on both sides; optionally a stake. */
async function trade(usdc: number, sellPnth: number, stakePnth = 0) {
  await send(dep.usdc, tokenAbi as never, "mint", [TRADER, parseUnits(String(usdc), 6)]);
  await send(dep.usdc, tokenAbi as never, "approve", [SWAPPER, parseUnits(String(usdc), 6)]);
  await send(SWAPPER, swapperAbi as never, "swapExactIn", [key, !pnthIs0, parseUnits(String(usdc), 6)]);
  await send(dep.pnth, tokenAbi as never, "approve", [SWAPPER, parseUnits(String(sellPnth), 18)]);
  await send(SWAPPER, swapperAbi as never, "swapExactIn", [key, pnthIs0, parseUnits(String(sellPnth), 18)]);
  if (stakePnth > 0) {
    await send(dep.pnth, tokenAbi as never, "approve", [dep.staking, parseUnits(String(stakePnth), 18)]);
    await send(dep.staking, stakeAbi as never, "stake", [parseUnits(String(stakePnth), 18)]);
  }
}

// The keeper, live, with the public anvil key in a 0600 file (the same loading path as the service).
const keyFile = join(mkdtempSync(join(tmpdir(), "keeper-fork-")), "keeper.key");
writeFileSync(keyFile, ANVIL_KEY);
chmodSync(keyFile, 0o600);
const account = privateKeyToAccount(readKeeperKey(keyFile));
const wallet = createWalletClient({ account, chain: elysium(FORK), transport: http(FORK) });
const chain = createChain(client, cfg, wallet);
const state: State = { stakedCursor: cfg.fromBlock.toString(), stakers: [], sweep: 0, pokesSince: 0 };
const round = (mode: "dry" | "live" = "live"): Promise<Report> =>
  tick({ cfg: { ...cfg, mode }, chain, pokes: async () => Promise.reject(new Error("no Passport service on the fork")), state, sender: account.address });
const sentKinds = (r: Report) => r.sent.map((s) => `${s.kind}${s.ok ? "" : "(failed)"}`).join(",") || "nothing";

console.log(`fork ${FORK} at block ${await client.getBlockNumber()}, keeper ${account.address}\n`);
await test.setBalance({ address: TRADER, value: 10n ** 18n });
await test.setBalance({ address: account.address, value: 10n ** 18n });
await test.impersonateAccount({ address: TRADER });

// 1. Fees from trading, plus a new staker: one live round must route the fees and spend the basket.
await trade(200, 1_000_000, 5_000_000);
const burned0 = await bal(dep.pnth, dep.burnSink);
const r1 = await round();
const burned1 = await bal(dep.pnth, dep.burnSink);
check("round 1 sends the fee run and the basket rebalance", sentKinds(r1) === "run,rebalance", sentKinds(r1));
check("PNTH was burned from the fees", burned1 > burned0, `+${(burned1 - burned0) / 10n ** 18n} PNTH`);
check("the basket vault spent all its USDC (streamed: no basket list yet)", (await bal(dep.usdc, dep.indexVault)) === 0n);
check("the keeper found the new staker", state.stakers.some((a) => a.toLowerCase() === TRADER.toLowerCase()), `${state.stakers.length} stakers known`);

// 2. Straight after: nothing to do, so nothing is sent.
const r2 = await round();
check("round 2 (nothing new) sends nothing", r2.sent.length === 0, sentKinds(r2));

// 3. Three days later every stake's time bonus has grown (≈ +5%): the keeper refreshes the boosts.
await test.increaseTime({ seconds: 3 * 86_400 });
await test.mine({ blocks: 1 });
const before = await client.readContract({ address: dep.staking, abi: stakingAbi, functionName: "accounts", args: [TRADER] });
const r3 = await round();
const after = await client.readContract({ address: dep.staking, abi: stakingAbi, functionName: "accounts", args: [TRADER] });
const next = await client.readContract({ address: dep.staking, abi: stakingAbi, functionName: "workingOf", args: [TRADER] });
check("round 3 (3 days later) refreshes boosts", sentKinds(r3).includes("poke"), sentKinds(r3));
check("the staker's working balance grew and is now up to date", after[2] > before[2] && after[2] === next, `${before[2] / 10n ** 18n} → ${after[2] / 10n ** 18n}`);

// 4. Practice mode with fees waiting: it would send the run, but sends nothing.
await trade(100, 500_000);
const p0 = await bal(dep.pnth, dep.burnSink);
const r4 = await round("dry");
check("practice mode reports the run as worth sending", r4.calls.find((c) => c.kind === "run")?.worthSending === true);
check("practice mode sends nothing and burns nothing", r4.sent.length === 0 && (await bal(dep.pnth, dep.burnSink)) === p0);

// 5. Live, but the keeper's wallet is empty: it must not try.
await test.setBalance({ address: account.address, value: 0n });
const r5 = await round();
check("an empty keeper wallet sends nothing and says so", r5.sent.length === 0 && r5.notes.some((n) => /below/.test(n)), r5.notes.join("; "));

// 6. Topped up again: the waiting fees go out.
await test.setBalance({ address: account.address, value: 10n ** 18n });
const r6 = await round();
check("after a top-up the waiting fees are routed", sentKinds(r6).startsWith("run"), sentKinds(r6));

console.log(`\n${failed === 0 ? "all checks passed" : `${failed} check(s) failed`}`);
process.exit(failed ? 1 : 0);
