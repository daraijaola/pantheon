// Live probe, run by hand: node scripts/probe-registry-call.ts   (needs `npm run test:contracts` or
// `forge build` in contracts-check first). READ-ONLY: one eth_call on Elysium testnet runs
// contracts-check/src/SubmitProbe.sol, which deploys the reference registry and submits an
// attestation signed by attest.ts, inside the call. Nothing is broadcast, no key leaves this box,
// and the attestor is anvil's public test key #0.
import { readFileSync } from "node:fs";
import {
  BaseError,
  createPublicClient,
  decodeAbiParameters,
  decodeErrorResult,
  encodeDeployData,
  getContractAddress,
  http,
  type Abi,
  type Hex,
} from "viem";
import { generatePrivateKey, mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { buildAttestation, signAttestation, type Attestation } from "../src/attest.ts";
import { loadConfig } from "../src/config.ts";
import { hlKeyOf } from "../src/link.ts";

const artifact = JSON.parse(
  readFileSync(new URL("../contracts-check/out/SubmitProbe.sol/SubmitProbe.json", import.meta.url), "utf8"),
) as { abi: Abi; bytecode: { object: Hex } };

const registryAbi = (
  JSON.parse(readFileSync(new URL("../contracts-check/out/HypePassportRegistry.sol/HypePassportRegistry.json", import.meta.url), "utf8")) as {
    abi: Abi;
  }
).abi;

/** The registry's custom error behind a revert (the probe bubbles it up unchanged). */
function revertReason(e: unknown): string {
  const raw = e instanceof BaseError ? (e.walk((x) => typeof (x as { data?: unknown }).data === "string") as { data?: Hex } | null)?.data : undefined;
  if (!raw) return e instanceof Error ? e.message.split("\n")[0]! : String(e);
  try {
    const { errorName, args } = decodeErrorResult({ abi: registryAbi, data: raw });
    return `${errorName}(${(args ?? []).join(", ")})`;
  } catch {
    return `unknown revert ${raw}`;
  }
}

const config = loadConfig();
const client = createPublicClient({ transport: http(config.elysiumRpc) });
const MNEMONIC = "test test test test test test test test test test test junk";
const attestor = mnemonicToAccount(MNEMONIC, { addressIndex: 0 });
const account = mnemonicToAccount(MNEMONIC, { addressIndex: 2 }).address;
const hlKey = hlKeyOf(`0x${"11".repeat(32)}`, mnemonicToAccount(MNEMONIC, { addressIndex: 1 }).address);

// A fresh sender has nonce 0, so the probe and the registry it deploys have known addresses,
// and the attestation can be signed for the registry's real verifyingContract up front.
const from = privateKeyToAccount(generatePrivateKey()).address;
const probe = getContractAddress({ from, nonce: 0n });
const registry = getContractAddress({ from: probe, nonce: 1n });

const block = await client.getBlock();
const now = Number(block.timestamp);
console.log({ chainId: await client.getChainId(), block: block.number, blockTime: new Date(now * 1000).toISOString(), registry });

const asArgs = (a: Attestation) => ({
  ...a,
  issuedAt: BigInt(a.issuedAt),
  expiry: BigInt(a.expiry),
  deadline: BigInt(a.deadline),
  chainId: BigInt(a.chainId),
});

async function run(label: string, a: Attestation, sig: Hex) {
  const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: [attestor.address, asArgs(a), sig] });
  try {
    const { data: out } = await client.call({ account: from, data });
    const [reg, digest, chainId, ts, valid, tier, stamps, multiplier, bound] = decodeAbiParameters(
      ["address", "bytes32", "uint256", "uint256", "bool", "uint8", "uint32", "uint256", "address"].map((type) => ({ type })),
      out!,
    );
    console.log(label, { accepted: true, reg, digest, chainId, ts, valid, tier, stamps, multiplier: Number(multiplier) / 1e18, boundToAccount: bound === account });
  } catch (e) {
    console.log(label, { accepted: false, reason: revertReason(e) });
  }
}

const good = buildAttestation({ account, hlKey, tier: 2, stamps: 5 }, now);
await run("signed now        ", good, await signAttestation(attestor, registry, good));
await run("tampered tier 3   ", { ...good, tier: 3 }, await signAttestation(attestor, registry, good));
const late = buildAttestation({ account, hlKey, tier: 2, stamps: 5 }, now - 7200);
await run("deadline passed   ", late, await signAttestation(attestor, registry, late));
const otherReg = getContractAddress({ from: probe, nonce: 2n });
await run("wrong registry sig", good, await signAttestation(attestor, otherReg, good));
