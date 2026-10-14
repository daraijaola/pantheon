// End-to-end rehearsal of a Trials round on a local fork of Elysium (never the real chain). Run by hand:
//   anvil --host 127.0.0.1 --port 8547 --fork-url https://testnet-rpc.elysium.kinetiq.xyz --compute-units-per-second 40
//   node scripts/fork-trials.ts out/trials/round-2.json [http://127.0.0.1:8547]
// As the curator (impersonated on the fork), it proposes the round exactly as Micheal's script would
// (fingerprint = keccak256 of the file), waits the registry's 24 hours, starts it, then lets the basket buy:
// first with no settle trades, then after a tiny settle trade on each coin, and reports what happened.
import { readFileSync } from "node:fs";
import { createTestClient, createWalletClient, decodeEventLog, http, keccak256, parseAbi, parseUnits, type Address, type Hex } from "viem";
import { makeClient } from "../src/chain.ts";

const FILE = process.argv[2] ?? "out/trials/round-2.json";
const FORK = process.argv[3] ?? "http://127.0.0.1:8547";
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(FORK)) throw new Error("only against a local fork");
const bytes = readFileSync(FILE);
const round = JSON.parse(bytes.toString()) as { symbols: string[]; tokens: Address[]; pools: Hex[]; weightsBps: number[]; perRunCaps: number[] };
const fingerprint = keccak256(bytes);
const dep = JSON.parse(readFileSync("../../deployments/elysium-testnet.json", "utf8")) as Record<string, Address>;
const CURATOR: Address = "0x155224663abE76b427F07EbF34B57cC920C47E9e";
const TRADER: Address = "0x000000000000000000000000000000000000ac1d";
const SWAPPER: Address = "0x31A67d054D34Ec18cb23A43B0E3ad1F756aA1500";
const PM: Address = "0x12E84206cB53aE0df055482ebc4658635096E1aA";

const chain = { id: 99_801, name: "fork", nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 }, rpcUrls: { default: { http: [FORK] } } } as const;
const client = makeClient(FORK);
const test = createTestClient({ mode: "anvil", chain, transport: http(FORK, { timeout: 300_000 }) });
const abi = parseAbi([
  "struct Constituent { bytes32 poolId; address token; uint16 weightBps; uint128 perRunCap; }",
  "struct Proposal { uint64 eta; bool vetoed; bool executed; bytes32 scoreRoot; string methodologyURI; }",
  "struct PoolKey { address currency0; address currency1; address hooks; address poolManager; uint24 fee; bytes32 parameters; }",
  "function propose(Constituent[] list, bytes32 scoreRoot, string methodologyURI) returns (uint256)",
  "function execute(uint256 id)",
  "function proposal(uint256 id) view returns (Proposal, Constituent[])",
  "function proposalCount() view returns (uint256)",
  "function active() view returns (Constituent[])",
  "function rebalance(uint256 k)",
  "function mint(address to, uint256 value)",
  "function approve(address spender, uint256 value) returns (bool)",
  "function swapExactIn(PoolKey key, bool zeroForOne, uint256 amountIn) returns (uint256 out)",
  "function poolIdToPoolKey(bytes32 id) view returns (address, address, address, address, uint24, bytes32)",
  "event BasketBuy(address indexed token, uint256 quoteIn, uint256 tokensOut, uint160 emaSqrt, uint160 spotSqrt)",
  "event BasketSkip(address indexed token, uint8 reason)",
]);
const SKIPS = ["NONE", "NO_AVERAGE", "STALE_AVERAGE", "BREAKER", "PRICE_OUT_OF_BAND", "NOTHING_TO_SPEND"];

let failed = 0;
const check = (what: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
};
async function send(from: Address, address: Address, functionName: string, args: unknown[] = []) {
  const w = createWalletClient({ account: from, chain, transport: http(FORK, { timeout: 300_000 }) });
  const gas = ((await client.estimateContractGas({ address, abi, functionName, args, account: from } as never)) * 3n) / 2n;
  const hash = await w.writeContract({ address, abi, functionName, args, gas } as never);
  const r = await client.waitForTransactionReceipt({ hash, timeout: 300_000 });
  if (r.status !== "success") throw new Error(`${functionName} reverted (${hash})`);
  return r;
}
const name = (t: string) => round.symbols[round.tokens.findIndex((x) => x.toLowerCase() === t.toLowerCase())] ?? t.slice(0, 10);
const outcome = (r: Awaited<ReturnType<typeof send>>) => {
  const res: string[] = [];
  for (const l of r.logs) {
    if (l.address.toLowerCase() !== dep.indexVault!.toLowerCase()) continue;
    try {
      const e = decodeEventLog({ abi, topics: l.topics as [Hex, ...Hex[]], data: l.data }) as { eventName: string; args: Record<string, unknown> };
      if (e.eventName === "BasketBuy") res.push(`${name(e.args.token as string)} bought for ${(Number(e.args.quoteIn) / 1e6).toFixed(2)} USDC`);
      if (e.eventName === "BasketSkip") res.push(`${name(e.args.token as string)} skipped: ${SKIPS[Number(e.args.reason)]}`);
    } catch {
      /* not a basket event */
    }
  }
  return res;
};

await test.mine({ blocks: 1 }); // Elysium (Arbitrum software): anvil answers calls only after a block of its own
for (const a of [CURATOR, TRADER]) {
  await test.setBalance({ address: a, value: 10n ** 18n });
  await test.impersonateAccount({ address: a });
}
console.log(`fork ${FORK} at block ${await client.getBlockNumber()}; round file fingerprint ${fingerprint.slice(0, 18)}…\n`);

// 1. Propose, exactly as Micheal's script does it.
const list = round.tokens.map((token, i) => ({ poolId: round.pools[i]!, token, weightBps: round.weightsBps[i]!, perRunCap: BigInt(round.perRunCaps[i]!) }));
const id = (await client.readContract({ address: dep.constituentRegistry!, abi, functionName: "proposalCount" })) as bigint;
await send(CURATOR, dep.constituentRegistry!, "propose", [list, fingerprint, "https://pantheonindex.com/trials"]);
const [p, stored] = (await client.readContract({ address: dep.constituentRegistry!, abi, functionName: "proposal", args: [id] })) as unknown as [{ eta: bigint; scoreRoot: Hex }, typeof list];
check(`proposal ${id} stores the round file's fingerprint`, p.scoreRoot === fingerprint);
check("and exactly the round's coins, weights and caps", JSON.stringify(stored.map((c) => [c.token, c.poolId, c.weightBps, c.perRunCap.toString()])) === JSON.stringify(list.map((c) => [c.token, c.poolId, c.weightBps, c.perRunCap.toString()])));

// 2. It can't start early; after 24 hours anyone can start it.
let early = false;
try {
  await client.simulateContract({ address: dep.constituentRegistry!, abi, functionName: "execute", args: [id], account: TRADER });
} catch {
  early = true;
}
check("it can't be started before its 24 hours are up", early);
await test.setNextBlockTimestamp({ timestamp: p.eta + 60n });
await test.mine({ blocks: 1 });
await send(TRADER, dep.constituentRegistry!, "execute", [id]);
const active = (await client.readContract({ address: dep.constituentRegistry!, abi, functionName: "active" })) as typeof list;
check("after 24 hours it starts, and the basket is the round's coins", JSON.stringify(active.map((c) => c.token)) === JSON.stringify(round.tokens), round.symbols.join(", "));

// 3. The basket buys: first with no settle trades at all.
await send(TRADER, dep.usdc!, "mint", [dep.indexVault!, parseUnits("50", 6)]);
const first = outcome(await send(TRADER, dep.indexVault!, "rebalance", [5n]));
console.log("      rebalance with no settle trades:");
for (const l of first) console.log(`        ${l}`);
check("with no settle trades, coins nobody traded lately are skipped as stale", first.some((l) => l.includes("STALE_AVERAGE")), `${first.filter((l) => l.includes("STALE")).length} stale`);

// 4. A tiny settle trade (0.01 USDC) on each coin, then rebalance again.
await send(TRADER, dep.usdc!, "mint", [TRADER, parseUnits("1", 6)]);
await send(TRADER, dep.usdc!, "approve", [SWAPPER, parseUnits("1", 6)]);
for (const pool of round.pools) {
  const [c0, c1, hooks, poolManager, fee, parameters] = (await client.readContract({ address: PM, abi, functionName: "poolIdToPoolKey", args: [pool] })) as readonly [Address, Address, Address, Address, number, Hex];
  await send(TRADER, SWAPPER, "swapExactIn", [{ currency0: c0, currency1: c1, hooks, poolManager, fee, parameters }, c0.toLowerCase() === dep.usdc!.toLowerCase(), parseUnits("0.01", 6)]);
}
const second = outcome(await send(TRADER, dep.indexVault!, "rebalance", [5n]));
console.log("      rebalance after a 0.01 USDC settle trade on each coin:");
for (const l of second) console.log(`        ${l}`);
check("after tiny settle trades the basket buys its coins", second.filter((l) => l.includes("bought")).length >= 3, `${second.filter((l) => l.includes("bought")).length} of 5 bought`);

// 5. What we recommend: small settle trades spread over a few hours, so each price average catches up.
for (let k = 0; k < 2; k++) {
  await test.increaseTime({ seconds: 3 * 3_600 });
  await test.mine({ blocks: 1 });
  for (const pool of round.pools) {
    const [c0, c1, hooks, poolManager, fee, parameters] = (await client.readContract({ address: PM, abi, functionName: "poolIdToPoolKey", args: [pool] })) as readonly [Address, Address, Address, Address, number, Hex];
    await send(TRADER, SWAPPER, "swapExactIn", [{ currency0: c0, currency1: c1, hooks, poolManager, fee, parameters }, c0.toLowerCase() === dep.usdc!.toLowerCase(), parseUnits("0.01", 6)]);
  }
}
await send(TRADER, dep.usdc!, "mint", [dep.indexVault!, parseUnits("20", 6)]);
const third = outcome(await send(TRADER, dep.indexVault!, "rebalance", [5n]));
console.log("      rebalance after 6 more hours of small settle trades:");
for (const l of third) console.log(`        ${l}`);
check("after settle trades spread over hours, the basket buys (nearly) all its coins", third.filter((l) => l.includes("bought")).length >= 4, `${third.filter((l) => l.includes("bought")).length} of 5 bought`);

console.log(`\n${failed === 0 ? "all checks passed" : `${failed} check(s) failed`}`);
process.exit(failed ? 1 : 0);
