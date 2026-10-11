// Relayer (spec §5.3, §6.2): submits attestations on Elysium with the service's gas-only wallet,
// so users need no Elysium gas. Batches go through Multicall3 aggregate3 (submit is permissionless).
import {
  createWalletClient,
  decodeErrorResult,
  decodeFunctionResult,
  encodeFunctionData,
  http,
  multicall3Abi,
  nonceManager,
  parseEventLogs,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readSecretFile, type Attestation } from "./attest.ts";
import type { Config } from "./config.ts";
import { elysiumTestnet, registryAbi } from "./registry.ts";

export type RelayItem = { attestation: Attestation; signature: Hex };
export type RelayResult = { ok: true; txHash: Hex } | { ok: false; reason: string };

export interface Relayer {
  /** One attestation, one transaction; resolves with the hash once it is mined and the passport issued. */
  submit(a: Attestation, sig: Hex): Promise<Hex>;
  /** Many attestations, batched; one result per item, in order. */
  submitMany(items: RelayItem[]): Promise<RelayResult[]>;
  balance(): Promise<bigint>;
}

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as Address;

export type ElysiumRelayerOptions = {
  wallet: WalletClient;
  client: PublicClient;
  registry: Address;
  multicall?: Address;
  /** ~138k gas per first-link submit; 25 per batch keeps a transaction near 3.5M gas. */
  batchSize?: number;
  receiptTimeoutMs?: number;
};

const args = (a: Attestation) =>
  [
    { ...a, issuedAt: BigInt(a.issuedAt), expiry: BigInt(a.expiry), deadline: BigInt(a.deadline), chainId: BigInt(a.chainId) },
  ] as const;

export class ElysiumRelayer implements Relayer {
  readonly address: Address;
  #o: Required<ElysiumRelayerOptions>;

  constructor(o: ElysiumRelayerOptions) {
    if (!o.wallet.account) throw new TypeError("relayer wallet needs an account");
    this.address = o.wallet.account.address;
    this.#o = { multicall: MULTICALL3, batchSize: 25, receiptTimeoutMs: 60_000, ...o };
  }

  balance(): Promise<bigint> {
    return this.#o.client.getBalance({ address: this.address });
  }

  async submit(a: Attestation, sig: Hex): Promise<Hex> {
    const { wallet, client, registry } = this.#o;
    const hash = await wallet.writeContract({
      address: registry,
      abi: registryAbi,
      functionName: "submit",
      args: [...args(a), sig],
      account: wallet.account!,
      chain: wallet.chain,
    });
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: this.#o.receiptTimeoutMs });
    if (receipt.status !== "success" || !this.#issued(receipt).has(key(a.account, a.issuedAt))) throw new Error(`submit reverted (${hash})`);
    return hash;
  }

  async submitMany(items: RelayItem[]): Promise<RelayResult[]> {
    const results: RelayResult[] = [];
    for (let i = 0; i < items.length; i += this.#o.batchSize) results.push(...(await this.#batch(items.slice(i, i + this.#o.batchSize))));
    return results;
  }

  /** Simulate first so reverting items are dropped with a reason; send the rest in one aggregate3. */
  async #batch(items: RelayItem[]): Promise<RelayResult[]> {
    const { wallet, client, registry, multicall } = this.#o;
    const calls = items.map((it) => ({
      target: registry,
      allowFailure: true,
      callData: encodeFunctionData({ abi: registryAbi, functionName: "submit", args: [...args(it.attestation), it.signature] }),
    }));
    const { data } = await client.call({
      account: this.address,
      to: multicall,
      data: encodeFunctionData({ abi: multicall3Abi, functionName: "aggregate3", args: [calls] }),
    });
    const simulated = decodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", data: data! });

    const results: RelayResult[] = simulated.map((r) => (r.success ? { ok: false, reason: "pending" } : { ok: false, reason: reason(r.returnData) }));
    const sendable = calls.filter((_, i) => simulated[i]!.success);
    if (sendable.length === 0) return results;

    // With allowFailure, a sub-call that runs out of gas just "fails" and the transaction still
    // succeeds, so eth_estimateGas happily under-estimates and the LAST submits silently drop (seen
    // on anvil). Estimate with allowFailure off for the calls known to succeed, then add a margin.
    const strict = encodeFunctionData({
      abi: multicall3Abi,
      functionName: "aggregate3",
      args: [sendable.map((c) => ({ ...c, allowFailure: false }))],
    });
    const gas = await client.estimateGas({ account: this.address, to: multicall, data: strict });
    const hash = await wallet.writeContract({
      address: multicall,
      abi: multicall3Abi,
      functionName: "aggregate3",
      args: [sendable],
      account: wallet.account!,
      chain: wallet.chain,
      gas: (gas * 13n) / 10n + 50_000n,
    });
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: this.#o.receiptTimeoutMs });
    const issued = receipt.status === "success" ? this.#issued(receipt) : new Set<string>();
    items.forEach((it, i) => {
      if (!simulated[i]!.success) return;
      results[i] = issued.has(key(it.attestation.account, it.attestation.issuedAt))
        ? { ok: true, txHash: hash }
        : { ok: false, reason: `not issued in ${hash}` };
    });
    return results;
  }

  /** (account, issuedAt) of every PassportIssued the registry logged in this receipt. */
  #issued(receipt: TransactionReceipt): Set<string> {
    const logs = parseEventLogs({ abi: registryAbi, eventName: "PassportIssued", logs: receipt.logs, strict: true });
    return new Set(
      logs.filter((l) => l.address.toLowerCase() === this.#o.registry.toLowerCase()).map((l) => key(l.args.account, Number(l.args.issuedAt))),
    );
  }
}

const key = (account: Address, issuedAt: number) => `${account.toLowerCase()}:${issuedAt}`;

function reason(revertData: Hex): string {
  try {
    const { errorName, args: a } = decodeErrorResult({ abi: registryAbi, data: revertData });
    return a && a.length > 0 ? `${errorName}(${a.join(", ")})` : errorName;
  } catch {
    return `reverted ${revertData.slice(0, 10)}`;
  }
}

/** The relayer from RELAYER_KEY_FILE (gas-only key, separate from the attestor; §9). */
export function createElysiumRelayer(config: Config, client: PublicClient): ElysiumRelayer {
  if (!config.registryAddress) throw new Error("REGISTRY_ADDRESS is not set");
  const key = readSecretFile(config.relayerKeyFile);
  const account = privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as Hex, { nonceManager });
  const wallet = createWalletClient({ account, chain: elysiumTestnet(config.elysiumRpc), transport: http(config.elysiumRpc, { timeout: 15_000 }) });
  return new ElysiumRelayer({ wallet, client, registry: config.registryAddress });
}
