// Fake HyperEVM for tests: a viem transport that answers Multicall3 aggregate3 per wallet.
import { parseUnits, createPublicClient, custom, decodeFunctionData, encodeFunctionResult, multicall3Abi, parseAbi, type Address, type Hex } from "viem";
import { hyperEvm } from "viem/chains";
import { HYPEREVM } from "../src/config.ts";
import type { Fixture } from "./mockHl.ts";

export type Wallet = { native: bigint; whype: bigint; khype: bigint; hypurr: bigint; kntq: bigint };
export type Read = keyof Wallet | "block" | "rate";

/** kHYPE→HYPE on 2026-10-11 (spec §3), HYPE wei per 1e18 kHYPE. */
export const LIVE_RATE = 1_026_282_111_410_302_860n;
export const EMPTY_WALLET: Wallet = { native: 0n, whype: 0n, khype: 0n, hypurr: 0n, kntq: 0n };

const abi = parseAbi([
  "function getEthBalance(address) view returns (uint256)",
  "function getBlockNumber() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function kHYPEToHYPE(uint256) view returns (uint256)",
]);

type Call = { target: Address; callData: Hex };

export function mockHyperEvm(wallets: Record<string, Partial<Wallet>> = {}) {
  const state = {
    wallets: new Map(Object.entries(wallets).map(([a, w]) => [a.toLowerCase(), { ...EMPTY_WALLET, ...w }])),
    block: 48_215_210n,
    rate: LIVE_RATE,
    revert: new Set<Read>(),
    throwNext: 0,
    requests: [] as Array<{ method: string; params: unknown }>,
    calls: [] as Call[],
  };

  const answer = (c: Call): { success: boolean; returnData: Hex } => {
    const { functionName, args } = decodeFunctionData({ abi, data: c.callData });
    const owner = typeof args?.[0] === "string" ? args[0].toLowerCase() : "";
    const w = state.wallets.get(owner) ?? EMPTY_WALLET;
    const t = c.target.toLowerCase();
    const read: Read | undefined =
      t === HYPEREVM.MULTICALL3.toLowerCase() ? (functionName === "getBlockNumber" ? "block" : "native")
      : t === HYPEREVM.STAKING_ACCOUNTANT.toLowerCase() ? "rate"
      : t === HYPEREVM.WHYPE.toLowerCase() ? "whype"
      : t === HYPEREVM.KHYPE.toLowerCase() ? "khype"
      : t === HYPEREVM.HYPURR.toLowerCase() ? "hypurr"
      : t === HYPEREVM.KNTQ.toLowerCase() ? "kntq"
      : undefined;
    if (read === undefined || state.revert.has(read)) return { success: false, returnData: "0x" };
    const value = read === "block" ? state.block : read === "rate" ? state.rate : w[read];
    return { success: true, returnData: encodeFunctionResult({ abi, functionName, result: value }) };
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
  const client = createPublicClient({ chain: hyperEvm, transport: custom({ request }, { retryCount: 0 }) });
  return { state, client };
}

/** The kHYPE rate a fixture was captured at (khypeInHype / khype), or LIVE_RATE if it holds none. */
export function rateFromFixture(fx: Fixture): bigint {
  const { khype, khypeInHype } = fx.hyperevm as { khype: number; khypeInHype: number };
  return khype > 0 ? parseUnits((khypeInHype / khype).toFixed(15), 18) : LIVE_RATE;
}

/** The fixtures' HyperEVM numbers (floats, ~15 significant digits) as on-chain amounts. */
export function walletFromFixture(fx: Fixture): Partial<Wallet> {
  const e = fx.hyperevm as { evmHype: number; whype: number; khype: number; hypurr: number; kntqEvm: number };
  const wei = (x: number) => parseUnits(x.toFixed(12), 18);
  return { native: wei(e.evmHype), whype: wei(e.whype), khype: wei(e.khype), hypurr: BigInt(e.hypurr), kntq: wei(e.kntqEvm) };
}
