// Live probe, run by hand (needs `forge build` in contracts-check): node scripts/probe-batch-gas.ts [n]
// READ-ONLY on Elysium testnet: eth_estimateGas / eth_call of contracts-check/src/BatchProbe.sol,
// which submits n attestations through the chain's real Multicall3 inside the call. Shows whether
// allowFailure makes the node under-estimate gas (the relayer bug), and Arbitrum's L1/L2 gas split.
import { readFileSync } from "node:fs";
import {
  createPublicClient,
  decodeAbiParameters,
  decodeFunctionResult,
  encodeDeployData,
  encodeFunctionData,
  getContractAddress,
  http,
  keccak256,
  parseAbi,
  toHex,
  type Abi,
  type Hex,
} from "viem";
import { generatePrivateKey, mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { buildAttestation, signAttestation, type Attestation } from "../src/attest.ts";
import { loadConfig } from "../src/config.ts";

const n = Number(process.argv[2] ?? 5);
const artifact = JSON.parse(readFileSync(new URL("../contracts-check/out/BatchProbe.sol/BatchProbe.json", import.meta.url), "utf8")) as {
  abi: Abi;
  bytecode: { object: Hex };
};
const client = createPublicClient({ transport: http(loadConfig().elysiumRpc) });
const attestor = mnemonicToAccount("test test test test test test test test test test test junk", { addressIndex: 0 }); // public test key
const from = privateKeyToAccount(generatePrivateKey()).address; // fresh: nonce 0, so addresses are known
const registry = getContractAddress({ from: getContractAddress({ from, nonce: 0n }), nonce: 1n });
const now = Number((await client.getBlock()).timestamp);

type AttArgs = Omit<Attestation, "issuedAt" | "expiry" | "deadline" | "chainId"> & { issuedAt: bigint; expiry: bigint; deadline: bigint; chainId: bigint };
const atts: AttArgs[] = [];
const sigs: Hex[] = [];
for (let i = 0; i < n; i++) {
  const a = buildAttestation({ account: privateKeyToAccount(generatePrivateKey()).address, hlKey: keccak256(toHex(`hl-${i}`)), tier: 2, stamps: 5 }, now);
  atts.push({ ...a, issuedAt: BigInt(a.issuedAt), expiry: BigInt(a.expiry), deadline: BigInt(a.deadline), chainId: BigInt(a.chainId) });
  sigs.push(await signAttestation(attestor, registry, a));
}
const deploy = (allowFailure: boolean) => encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: [attestor.address, atts, sigs, allowFailure] });
const issuedWith = async (allowFailure: boolean, gas: bigint) => {
  const { data } = await client.call({ account: from, data: deploy(allowFailure), gas });
  const [, issued] = decodeAbiParameters([{ type: "address" }, { type: "bool[]" }], data!);
  return (issued as boolean[]).filter(Boolean).length;
};

const lenient = await client.estimateGas({ account: from, data: deploy(true) });
const strict = await client.estimateGas({ account: from, data: deploy(false) });
const relayerGas = (strict * 13n) / 10n + 50_000n; // what src/relayer.ts sends

// Arbitrum Nitro's NodeInterface (virtual, eth_call only) splits an estimate into L1 posting and L2 execution.
const nodeInterface = parseAbi([
  "function gasEstimateComponents(address to, bool contractCreation, bytes data) payable returns (uint64 gasEstimate, uint64 gasEstimateForL1, uint256 baseFee, uint256 l1BaseFeeEstimate)",
]);
let split: Record<string, string>;
try {
  const { data } = await client.call({
    to: "0x00000000000000000000000000000000000000C8",
    data: encodeFunctionData({ abi: nodeInterface, functionName: "gasEstimateComponents", args: ["0x0000000000000000000000000000000000000000", true, deploy(false)] }),
  });
  const [total, forL1, baseFee] = decodeFunctionResult({ abi: nodeInterface, functionName: "gasEstimateComponents", data: data! });
  split = { total: total.toString(), forL1: forL1.toString(), baseFeeGwei: (Number(baseFee) / 1e9).toString() };
} catch (e) {
  split = { error: (e as Error).message.split("\n")[0]! };
}

console.log({
  submits: n,
  estimateAllowFailureTrue: lenient.toString(),
  estimateAllowFailureFalse: strict.toString(),
  underEstimate: lenient < strict,
  issuedWithLenientEstimate: `${await issuedWith(true, lenient)}/${n}`,
  issuedWithRelayerGas: `${await issuedWith(true, relayerGas)}/${n}`,
  nodeInterface: split,
});
