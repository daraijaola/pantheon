// HyperEVM mainnet holdings of one HL address, read in ONE Multicall3 aggregate3 call (spec §3).
// HyperEVM serves only the latest block (HL JSON-RPC docs), so there is no holding-duration check.
import { createPublicClient, http, isAddress, parseAbi, type Address, type PublicClient } from "viem";
import { hyperEvm } from "viem/chains";
import { HYPEREVM, type Config } from "../config.ts";
import { realSleep, WeightLimiter, type Sleep } from "../ratelimit.ts";

const multicallAbi = parseAbi([
  "function getEthBalance(address addr) view returns (uint256 balance)",
  "function getBlockNumber() view returns (uint256 blockNumber)",
]);
const balanceOfAbi = parseAbi(["function balanceOf(address owner) view returns (uint256)"]);
const accountantAbi = parseAbi(["function kHYPEToHYPE(uint256 kHYPEAmount) view returns (uint256)"]);

const WAD = 10n ** 18n;

/**
 * kHYPE and Kinetiq's accountant are upgradeable proxies, so a rate outside these bounds means a bug
 * or an upgrade, not staking rewards. It is then treated as unread (kHYPE scores 0).
 * - min 1.0: kHYPE started at 1:1 and HL has "no automatic slashing" (HL staking docs).
 * - max 1.2: 1.0263 on 2026-10-11 after ~15 months (~2%/yr), so years of headroom.
 */
export const KHYPE_RATE_BOUNDS = { min: WAD, max: (WAD * 6n) / 5n } as const;

/** Raw on-chain amounts (18 decimals, Hypurr is an NFT count); null when that read failed. */
export type EvmHoldings = {
  blockNumber: bigint;
  nativeHype: bigint | null;
  whype: bigint | null;
  khype: bigint | null;
  /** HYPE (18 dp) per 1e18 kHYPE. */
  khypeRate: bigint | null;
  hypurr: bigint | null;
  kntq: bigint | null;
  /** Names of the reads that failed; scoring counts them as 0. */
  failed: Array<Exclude<keyof EvmHoldings, "failed" | "blockNumber">>;
};

export type EvmErrorCode = "BAD_REQUEST" | "UNAVAILABLE";

export class EvmError extends Error {
  override name = "EvmError";
  readonly code: EvmErrorCode;

  constructor(code: EvmErrorCode, message: string, opts: { cause?: unknown } = {}) {
    super(message, { cause: opts.cause });
    this.code = code;
  }
}

export type HyperEvmReaderOptions = {
  client: PublicClient;
  /** One unit per JSON-RPC request (HL caps the public RPC at 100/min per IP). */
  limiter: WeightLimiter;
  sleep?: Sleep;
  retryDelaysMs?: readonly number[];
};

export class HyperEvmReader {
  readonly limiter: WeightLimiter;
  #client: PublicClient;
  #sleep: Sleep;
  #retryDelaysMs: readonly number[];

  constructor(o: HyperEvmReaderOptions) {
    this.#client = o.client;
    this.limiter = o.limiter;
    this.#sleep = o.sleep ?? realSleep;
    this.#retryDelaysMs = o.retryDelaysMs ?? [5_000, 10_000, 20_000];
  }

  async holdings(user: Address): Promise<EvmHoldings> {
    if (!isAddress(user, { strict: false })) throw new EvmError("BAD_REQUEST", "user is not an address");
    const owner = user.toLowerCase() as Address;
    const contracts = [
      { address: HYPEREVM.MULTICALL3, abi: multicallAbi, functionName: "getBlockNumber" },
      { address: HYPEREVM.MULTICALL3, abi: multicallAbi, functionName: "getEthBalance", args: [owner] },
      { address: HYPEREVM.WHYPE, abi: balanceOfAbi, functionName: "balanceOf", args: [owner] },
      { address: HYPEREVM.KHYPE, abi: balanceOfAbi, functionName: "balanceOf", args: [owner] },
      { address: HYPEREVM.STAKING_ACCOUNTANT, abi: accountantAbi, functionName: "kHYPEToHYPE", args: [WAD] },
      { address: HYPEREVM.HYPURR, abi: balanceOfAbi, functionName: "balanceOf", args: [owner] },
      { address: HYPEREVM.KNTQ, abi: balanceOfAbi, functionName: "balanceOf", args: [owner] },
    ] as const;

    for (let attempt = 0; ; attempt++) {
      await this.limiter.take(1);
      try {
        const r = await this.#client.multicall({
          contracts,
          allowFailure: true,
          batchSize: 0, // never split: one eth_call per check
          multicallAddress: HYPEREVM.MULTICALL3,
          blockTag: "latest",
        });
        const value = (i: number) => {
          const x = r[i];
          return x?.status === "success" && typeof x.result === "bigint" ? x.result : null;
        };
        // With allowFailure, viem reports an RPC error as every call "failed" instead of throwing.
        // Multicall3.getBlockNumber cannot revert, so its failure means the batch never ran: retry,
        // never report "holds nothing" (an RPC outage would otherwise downgrade passports).
        const blockNumber = value(0);
        if (blockNumber === null) throw r[0]?.error ?? new Error("multicall batch did not run");
        const rate = value(4);
        const holdings: EvmHoldings = {
          blockNumber,
          nativeHype: value(1),
          whype: value(2),
          khype: value(3),
          khypeRate: rate !== null && rate >= KHYPE_RATE_BOUNDS.min && rate <= KHYPE_RATE_BOUNDS.max ? rate : null,
          hypurr: value(5),
          kntq: value(6),
          failed: [],
        };
        for (const key of ["nativeHype", "whype", "khype", "khypeRate", "hypurr", "kntq"] as const) {
          if (holdings[key] === null) holdings.failed.push(key);
        }
        return holdings;
      } catch (cause) {
        // Single-call reverts never land here (allowFailure): this is the RPC or the whole batch.
        const delay = this.#retryDelaysMs[attempt];
        if (delay === undefined) {
          throw new EvmError("UNAVAILABLE", `HyperEVM read gave up after ${attempt + 1} attempts`, { cause });
        }
        await this.#sleep(delay);
      }
    }
  }
}

/** kHYPE valued in HYPE (18 dp), rounding down; 0 when either read failed. */
export function khypeInHype(h: Pick<EvmHoldings, "khype" | "khypeRate">): bigint {
  return h.khype === null || h.khypeRate === null ? 0n : (h.khype * h.khypeRate) / WAD;
}

export function createHyperEvmReader(config: Config, opts: Partial<HyperEvmReaderOptions> = {}): HyperEvmReader {
  const client = createPublicClient({
    chain: hyperEvm,
    // Retries are ours, so every attempt passes the limiter.
    transport: http(config.hyperEvmRpc, { retryCount: 0, timeout: 10_000 }),
  });
  return new HyperEvmReader({ client, limiter: new WeightLimiter(config.evmReqPerMin), ...opts });
}
