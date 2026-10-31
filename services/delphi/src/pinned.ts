// Small building blocks for reading contracts through BatchRpc, every read pinned to one block so a
// report describes one moment of the chain (and a recorded test replays exactly).
import { decodeAbiParameters, encodeFunctionData, getAddress, hexToString, parseAbi, type Address, type Hex } from "viem";
import { RpcError, type RpcAnswer, type RpcCall } from "./rpc.ts";

export const ZERO: Address = "0x0000000000000000000000000000000000000000";
export const DEAD: Address = "0x000000000000000000000000000000000000dEaD";

export const ERC20 = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

export const getCode = (a: Address, block: Hex): RpcCall => ({ method: "eth_getCode", params: [a, block] });
export const getSlot = (a: Address, slot: Hex, block: Hex): RpcCall => ({ method: "eth_getStorageAt", params: [a, slot, block] });
export const ethCall = (to: Address, data: Hex, block: Hex | "latest", from?: Address): RpcCall => ({
  method: "eth_call",
  params: [{ ...(from ? { from } : {}), to, data }, block],
});

/** `balanceOf(who)` on `token`. */
export const balanceOfData = (who: Address) => encodeFunctionData({ abi: ERC20, functionName: "balanceOf", args: [who] });

/** What an eth_call did: returned data, or failed inside the contract. A node outage throws instead. */
export type Outcome = { ok: true; data: Hex } | { ok: false; message: string };

export function outcome(a: RpcAnswer): Outcome {
  if (!a.error) return { ok: true, data: (typeof a.result === "string" ? a.result : "0x") as Hex };
  // Code 3 is a revert; -32000 covers other failures inside the call (invalid opcode, out of gas).
  if (a.error.code === 3 || a.error.code === -32000 || /revert|invalid opcode|out of gas|execution/i.test(a.error.message)) {
    return { ok: false, message: a.error.message };
  }
  throw new RpcError(a.error.message, a.error.code);
}

/** A 32-byte word that holds an address (top 12 bytes zero), or null. */
export function wordAddress(data: Hex | null | undefined): Address | null {
  if (!data || !/^0x0{24}[0-9a-f]{40}$/i.test(data)) return null;
  return getAddress(`0x${data.slice(26)}`);
}

/** The first 32-byte word as a number, or null. */
export function wordUint(data: Hex | null | undefined): bigint | null {
  if (!data || data.length < 66) return null;
  return BigInt(data.slice(0, 66));
}

/** A string answer (or an old-style bytes32 one), or null. */
export function decodeText(data: Hex | null | undefined): string | null {
  if (!data || data === "0x") return null;
  try {
    return decodeAbiParameters([{ type: "string" }], data)[0];
  } catch {
    if (data.length !== 66) return null;
    const s = hexToString(data).replace(/\0+$/, "");
    return s || null;
  }
}

export const answerData = (a: RpcAnswer | undefined): Hex | null => {
  if (!a) return null;
  const o = outcome(a);
  return o.ok && o.data !== "0x" ? o.data : null;
};

/** Owners nobody holds a key for: control was given up ("renounced"). */
export const RENOUNCED: readonly Address[] = [ZERO, DEAD];
export const isRenounced = (a: Address | null): boolean => a !== null && RENOUNCED.some((r) => r.toLowerCase() === a.toLowerCase());

/** 0x7D29d8…b2 style, for sentences; reports always carry the full address beside it. */
export const short = (a: string) => `${a.slice(0, 8)}…${a.slice(-4)}`;

/** Percentage of `part` in `whole`, to 4 decimal places. */
export const pctOf = (part: bigint, whole: bigint): number => (whole === 0n ? 0 : Number((part * 1_000_000n) / whole) / 10_000);

/** "1.5%" or "0.01%": no trailing zeros. */
export const pctText = (p: number) => `${Number(p.toFixed(p < 0.1 ? 4 : 2))}%`;
