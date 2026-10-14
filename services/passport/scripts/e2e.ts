// P9 checker, run by hand against the live service and registry (never in tests). Read-only: no keys.
// People link on pantheonindex.com/passport; this confirms the result on-chain:
//   node --env-file-if-exists=.env scripts/e2e.ts <elysium-address> [--api http://127.0.0.1:8787] [--from-block N]
// Checks: the API's tier and validity match the registry, PassportIssued is on chain (tx links),
// /passport/stats counts it, and after an unlink, when the Hyperliquid wallet may link again.
import { getAddress, isAddress, parseAbi, parseAbiItem, type Address } from "viem";
import { loadConfig } from "../src/config.ts";
import { createElysiumClient } from "../src/registry.ts";

const args = process.argv.slice(2);
const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const target = args.find((a) => !a.startsWith("--") && isAddress(a, { strict: false }));
if (!target) {
  console.error("usage: node --env-file-if-exists=.env scripts/e2e.ts <elysium-address> [--api URL] [--from-block N]");
  process.exit(2);
}
const account = getAddress(target);
const api = (opt("--api") ?? "http://127.0.0.1:8787").replace(/\/$/, "");
/** The block the current registry was deployed in (Elysium testnet, Oct 14). */
const fromBlock = BigInt(opt("--from-block") ?? "9127920");

const config = loadConfig();
if (!config.registryAddress) throw new Error("REGISTRY_ADDRESS is not set");
const registry = config.registryAddress;
const client = createElysiumClient(config);
const EXPLORER = "https://elysium.kinetiq.xyz/testnet-explorer";

const abi = parseAbi([
  "struct Passport { bytes32 hlKey; uint8 tier; uint32 stamps; uint64 issuedAt; uint64 expiry; uint64 linkedAt; }",
  "function passportOf(address account) view returns (Passport)",
  "function isValid(address account) view returns (bool)",
  "function tierOf(address account) view returns (uint8)",
  "function multiplierOf(address account) view returns (uint256)",
  "function rebindableAt(bytes32 hlKey) view returns (uint64)",
]);
const ISSUED = parseAbiItem(
  "event PassportIssued(address indexed account, bytes32 indexed hlKey, uint8 tier, uint32 stamps, uint64 issuedAt, uint64 expiry)",
);
const UNLINKED = parseAbiItem("event Unlinked(address indexed account, bytes32 indexed hlKey, uint64 rebindableAt)");

const read = <T>(functionName: "passportOf" | "isValid" | "tierOf" | "multiplierOf", a: Address = account) =>
  client.readContract({ address: registry, abi, functionName, args: [a] }) as Promise<T>;
const getJson = async (path: string) => {
  const res = await fetch(`${api}${path}`, { signal: AbortSignal.timeout(20_000) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

const [view, stats, onPassport, onValid, onTier, onMult, head] = await Promise.all([
  getJson(`/passport/${account}`),
  getJson("/passport/stats"),
  read<{ hlKey: `0x${string}`; tier: number; expiry: bigint; linkedAt: bigint }>("passportOf"),
  read<boolean>("isValid"),
  read<number>("tierOf"),
  read<bigint>("multiplierOf"),
  client.getBlockNumber(),
]);
const [issued, unlinked] = await Promise.all([
  client.getLogs({ address: registry, event: ISSUED, args: { account }, fromBlock, toBlock: head }),
  client.getLogs({ address: registry, event: UNLINKED, args: { account }, fromBlock, toBlock: head }),
]);

console.log(`account   ${account}`);
console.log(`registry  ${registry}  (blocks ${fromBlock}–${head})`);
console.log(`API       ${view.status} ${JSON.stringify(view.body)}`);
console.log(`chain     valid=${onValid} tier=${onTier} multiplier=${Number(onMult) / 1e18}× expiry=${new Date(Number(onPassport.expiry) * 1000).toISOString()}`);
for (const l of issued) console.log(`issued    tier ${l.args.tier}  ${EXPLORER}/tx/${l.transactionHash}`);
for (const l of unlinked) {
  const at = Number(l.args.rebindableAt);
  console.log(`unlinked  may link again ${new Date(at * 1000).toISOString()}  ${EXPLORER}/tx/${l.transactionHash}`);
}

const checks: Array<[string, boolean]> = [
  ["API tier matches the registry's tierOf", view.body.tier === onTier],
  ["API validity matches the registry's isValid", view.body.valid === onValid],
];
if (onValid) {
  checks.push(["PassportIssued is on chain", issued.length > 0]);
  checks.push(["/passport/stats counts it", Number(stats.body.valid) >= 1]);
}
if (unlinked.length > 0) {
  const last = unlinked.at(-1)!;
  const cooling = Number(last.args.rebindableAt) * 1000 > Date.now();
  console.log(`cooldown  ${cooling ? "active: re-linking that Hyperliquid wallet now must fail with REBIND_COOLDOWN" : "over"}`);
}
let failed = 0;
for (const [what, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
  if (!ok) failed++;
}
process.exit(failed ? 1 : 0);
