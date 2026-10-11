import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeFunctionResult,
  multicall3Abi,
  parseAbi,
  toFunctionSelector,
  type Address,
  type Hex,
} from "viem";
import { hyperEvm } from "viem/chains";
import { beforeEach, describe, expect, it } from "vitest";
import { HYPEREVM } from "../src/config.ts";
import { EvmError, HyperEvmReader, KHYPE_RATE_BOUNDS, khypeInHype } from "../src/evm/hyperevm.ts";
import { WeightLimiter } from "../src/ratelimit.ts";

const WHALE = "0xcf2115a890a19b706582692ce3513b61a507ad7c" as Address; // khype_whale fixture
const E18 = 10n ** 18n;

// Live values for the whale on 2026-10-11 (spec §3), in wei.
const live = {
  block: 48_215_210n,
  native: 3_240_004_234_594_851_000n,
  whype: 0n,
  khype: 5_247_248_323_436_139_000_000n,
  rate: 1_026_282_111_410_302_860n,
  hypurr: 0n,
  kntq: 0n,
};

const abi = parseAbi([
  "function getEthBalance(address) view returns (uint256)",
  "function getBlockNumber() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function kHYPEToHYPE(uint256) view returns (uint256)",
]);
const sel = (sig: string) => toFunctionSelector(sig);

type Call = { target: Address; callData: Hex };

/** A viem transport that answers aggregate3 like HyperEVM, from `values`; records every request. */
function mockChain() {
  const state = {
    values: { ...live } as Record<keyof typeof live, bigint>,
    revert: new Set<keyof typeof live>(),
    throwNext: 0,
    requests: [] as Array<{ method: string; params: unknown }>,
    calls: [] as Call[],
  };

  const answer = (c: Call): { success: boolean; returnData: Hex } => {
    const key = ((): keyof typeof live | undefined => {
      const s = c.callData.slice(0, 10);
      const t = c.target.toLowerCase();
      if (t === HYPEREVM.MULTICALL3.toLowerCase()) return s === sel("getBlockNumber()") ? "block" : "native";
      if (t === HYPEREVM.STAKING_ACCOUNTANT.toLowerCase()) return "rate";
      if (t === HYPEREVM.WHYPE.toLowerCase()) return "whype";
      if (t === HYPEREVM.KHYPE.toLowerCase()) return "khype";
      if (t === HYPEREVM.HYPURR.toLowerCase()) return "hypurr";
      if (t === HYPEREVM.KNTQ.toLowerCase()) return "kntq";
      return undefined;
    })();
    if (key === undefined || state.revert.has(key)) return { success: false, returnData: "0x" };
    const fn = decodeFunctionData({ abi, data: c.callData }).functionName;
    return { success: true, returnData: encodeFunctionResult({ abi, functionName: fn, result: state.values[key] }) };
  };

  const request = async ({ method, params }: { method: string; params: unknown }) => {
    state.requests.push({ method, params });
    if (state.throwNext > 0) {
      state.throwNext--;
      throw new Error("HTTP 429 Too Many Requests");
    }
    if (method !== "eth_call") throw new Error(`unexpected ${method}`);
    const [tx] = params as [{ to: Address; data: Hex }, string];
    const { args } = decodeFunctionData({ abi: multicall3Abi, data: tx.data });
    const calls = (args[0] as readonly Call[]).map((c) => ({ target: c.target, callData: c.callData }));
    state.calls.push(...calls);
    return encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: calls.map(answer) });
  };
  // Like production: retries are the reader's, so each one passes the limiter.
  const transport = custom({ request }, { retryCount: 0 });
  return { state, client: createPublicClient({ chain: hyperEvm, transport }) };
}

let chain: ReturnType<typeof mockChain>;
let slept: number[];
const reader = (limiter = new WeightLimiter(60)) =>
  new HyperEvmReader({ client: chain.client, limiter, sleep: async (ms) => void slept.push(ms) });

beforeEach(() => {
  chain = mockChain();
  slept = [];
});

describe("HyperEvmReader", () => {
  it("reads all holdings of an address in ONE eth_call at the latest block", async () => {
    const h = await reader().holdings(WHALE);
    expect(h).toEqual({
      blockNumber: live.block,
      nativeHype: live.native,
      whype: 0n,
      khype: live.khype,
      khypeRate: live.rate,
      hypurr: 0n,
      kntq: 0n,
      failed: [],
    });
    expect(chain.state.requests).toHaveLength(1);
    const [tx, tag] = chain.state.requests[0]!.params as [{ to: string }, string];
    expect(tx.to.toLowerCase()).toBe(HYPEREVM.MULTICALL3.toLowerCase());
    expect(tag).toBe("latest");
    expect(chain.state.calls.map((c) => c.target)).toEqual([
      HYPEREVM.MULTICALL3,
      HYPEREVM.MULTICALL3,
      HYPEREVM.WHYPE,
      HYPEREVM.KHYPE,
      HYPEREVM.STAKING_ACCOUNTANT,
      HYPEREVM.HYPURR,
      HYPEREVM.KNTQ,
    ]);
  });

  it("values kHYPE in HYPE with the live rate (≈ 5385 HYPE for the whale)", async () => {
    const h = await reader().holdings(WHALE);
    const hype = khypeInHype(h);
    expect(hype / E18).toBe(5385n);
    expect(hype).toBe((live.khype * live.rate) / E18);
  });

  it("keeps the other reads when one call reverts", async () => {
    chain.state.revert.add("hypurr");
    const h = await reader().holdings(WHALE);
    expect(h.hypurr).toBeNull();
    expect(h.khype).toBe(live.khype);
    expect(h.failed).toEqual(["hypurr"]);
  });

  it.each([
    ["too low", KHYPE_RATE_BOUNDS.min - 1n],
    ["too high", KHYPE_RATE_BOUNDS.max + 1n],
    ["zero", 0n],
  ])("treats a kHYPE rate that is %s as unread", async (_label, rate) => {
    chain.state.values.rate = rate;
    const h = await reader().holdings(WHALE);
    expect(h.khypeRate).toBeNull();
    expect(h.failed).toContain("khypeRate");
    expect(khypeInHype(h)).toBe(0n);
  });

  it("retries a failing RPC with 5/10/20 s backoff, charging every attempt", async () => {
    const limiter = new WeightLimiter(60);
    chain.state.throwNext = 3;
    await expect(reader(limiter).holdings(WHALE)).resolves.toMatchObject({ khype: live.khype });
    expect(slept).toEqual([5_000, 10_000, 20_000]);
    expect(60 - limiter.available()).toBe(4);
  });

  it("never reports an RPC outage as an empty wallet", async () => {
    // viem turns a failed batch into per-call failures; the block-number canary catches it.
    chain.state.throwNext = 1;
    const h = await reader().holdings(WHALE);
    expect(h.failed).toEqual([]);
    expect(slept).toEqual([5_000]);
    chain.state.revert.add("block");
    await expect(reader().holdings(WHALE)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("gives up with a typed UNAVAILABLE error", async () => {
    chain.state.throwNext = 4;
    const err = await reader().holdings(WHALE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EvmError);
    expect(err).toMatchObject({ code: "UNAVAILABLE" });
  });

  it("refuses a malformed address without calling the RPC", async () => {
    await expect(reader().holdings("0x1234" as Address)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(chain.state.requests).toHaveLength(0);
  });
});
