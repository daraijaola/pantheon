import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeFunctionData, encodeFunctionResult, keccak256, numberToHex, parseAbi, type Address, type Hex } from "viem";
import { AGGREGATE3, MULTICALL3, multicallPolicy } from "../src/multicall.ts";
import { viewsAt } from "../src/reads.ts";
import { BatchRpc } from "../src/rpc.ts";

const TARGET: Address = "0x0000000000000000000000000000000000000011";
const CODE: Hex = "0x600160005260206000f3";
const MC_CODE: Hex = "0x6002";
const ABI = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const policy = { codeHashes: new Set([keccak256(CODE)]), multicallCodeHash: keccak256(MC_CODE), batchSize: 8 };
const calls = Array.from({ length: 16 }, (_, i) => ({ to: TARGET, data: encodeFunctionData({ abi: ABI, functionName: "balanceOf", args: [numberToHex(i, { size: 20 })] }) }));
type Req = { id: number; method: string; params: unknown[] };
type Mode = "ok" | "revert" | "malformed" | "inner-revert" | "inner-malformed" | "mismatch" | "late-mismatch" | "wrong-code" | "proxy";

function node(mode: Mode = "ok") {
  const seen: Req[] = [];
  let aggregates = 0;
  const value = (data: Hex) => numberToHex(BigInt(decodeFunctionData({ abi: ABI, data }).args[0]) + 100n, { size: 32 });
  const fetch = async (_url: string, init?: RequestInit) => {
    const requests = JSON.parse(String(init!.body)) as Req[];
    seen.push(...requests);
    const responses = requests.map((r) => {
      if (r.method === "eth_getCode") return { id: r.id, result: r.params[0] === MULTICALL3 ? MC_CODE : mode === "wrong-code" ? "0x6000" : mode === "proxy" ? "0x6000f4" : CODE };
      const { to, data } = r.params[0] as { to: string; data: Hex };
      if (to !== MULTICALL3) return { id: r.id, result: value(data) };
      aggregates++;
      if (mode === "revert") return { id: r.id, error: { code: 3, message: "execution reverted" } };
      if (mode === "malformed") return { id: r.id, result: "0x1234" };
      const inputs = decodeFunctionData({ abi: AGGREGATE3, data }).args[0];
      const results = inputs.map((c, i) => ({
        success: !(mode === "inner-revert" && i === 3),
        returnData: i === 3 && (mode === "inner-revert" || mode === "inner-malformed") ? "0x" as Hex : i === 0 && (mode === "mismatch" || (mode === "late-mismatch" && aggregates === 2)) ? numberToHex(999n, { size: 32 }) : value(c.callData),
      }));
      return { id: r.id, result: encodeFunctionResult({ abi: AGGREGATE3, functionName: "aggregate3", result: results }) };
    });
    return new Response(JSON.stringify(responses));
  };
  return { seen, rpc: new BatchRpc(`http://mc-${mode}`, { gapMs: 0, retries: 0, fetch }) };
}
afterEach(() => vi.unstubAllEnvs());

describe("audited Multicall views", () => {
  it("preserves exact results, order and pinned blocks with fewer metered requests", async () => {
    const direct = node(), batched = node();
    const expected = await viewsAt(direct.rpc, calls, 123n, false);
    expect(await viewsAt(batched.rpc, calls, 123n, policy)).toEqual(expected);
    expect(batched.seen.filter((r) => r.method === "eth_call")).toHaveLength(6);
    expect(batched.seen.every((r) => r.params[1] === "0x7b")).toBe(true);
  });
  it.each(["revert", "malformed", "inner-revert", "inner-malformed", "mismatch", "late-mismatch", "wrong-code", "proxy"] as const)("falls back to original reads on %s", async (mode) => {
    const baseline = node(), candidate = node(mode);
    const approved = mode === "proxy" ? { ...policy, codeHashes: new Set([keccak256("0x6000f4")]) } : policy;
    expect(await viewsAt(candidate.rpc, calls, 123n, approved)).toEqual(await viewsAt(baseline.rpc, calls, 123n, false));
    if (mode.startsWith("inner-")) expect(candidate.seen.filter((r) => r.method === "eth_call" && (r.params[0] as { to: string }).to !== MULTICALL3)).toHaveLength(6);
  });
  it("never batches unaudited implementations, unknown selectors, small groups or latest", async () => {
    for (const [inputs, block, allow] of [[calls, "latest", policy], [calls.slice(0, 7), 123n, policy], [calls, 123n, { ...policy, codeHashes: new Set<Hex>() }], [calls.map((c) => ({ ...c, data: "0x12345678" as Hex })), 123n, policy]] as const) {
      const n = node();
      if (inputs[0]?.data === "0x12345678") {
        await expect(viewsAt(n.rpc, inputs, block, allow)).rejects.toThrow();
      } else await viewsAt(n.rpc, inputs, block, allow);
      expect(n.seen.every((r) => r.method === "eth_call" && (r.params[0] as { to: string }).to !== MULTICALL3)).toBe(true);
    }
  });
  it("falls back if Multicall3's deployment hash does not match", async () => {
    const n = node();
    expect(await viewsAt(n.rpc, calls, 123n, { ...policy, multicallCodeHash: keccak256("0x1234") })).toEqual(await viewsAt(node().rpc, calls, 123n, false));
    expect(n.seen.filter((r) => r.method === "eth_getCode")).toHaveLength(1);
  });
  it("handles empty input without RPC and rejects invalid configuration without echoing it", async () => {
    const n = node();
    expect(await viewsAt(n.rpc, [], 123n, policy)).toEqual([]);
    expect(n.seen).toEqual([]);
    vi.stubEnv("DELPHI_MULTICALL_CODE_HASHES", "not-an-audited-hash");
    expect(multicallPolicy).toThrow("invalid DELPHI_MULTICALL_CODE_HASHES");
    vi.stubEnv("DELPHI_MULTICALL", "0");
    expect(multicallPolicy()).toBe(false);
  });
});
