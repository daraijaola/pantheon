import { decodeFunctionResult, encodeFunctionData, isHex, keccak256, numberToHex, parseAbi, type Address, type Hex } from "viem";
import { delegationTarget, hasDelegatecall } from "./bytecode.ts";
import { rpcSetting, type BatchRpc } from "./rpc.ts";

export const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";
export const MULTICALL3_CODE_HASH: Hex = "0xd5c15df687b16f2ff992fc8d767b4216323184a2bbc6ee2f9c398c318e770891";
export const APPROVED_VIEW_CODE_HASHES: ReadonlySet<Hex> = new Set([
  "0x400afd838d4b8888b195f8231b65b87f326adf2cf0205dcbe71f2703ca1161fe", // Verified TestUSDC: storage/constant getters only.
  "0xfd581a067231878993acf06be55d9499fcd0b0f428041685933715be8ccb1546", // Verified EridanosToken: unmodified OpenZeppelin getters.
]);
export const AGGREGATE3 = parseAbi(["function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)"]);

type Call = { to: Address; data: Hex; block?: bigint };
export type MulticallPolicy = { codeHashes: ReadonlySet<Hex>; batchSize?: number; multicallCodeHash?: Hex };
const LENGTHS: Record<string, number> = { "0x70a08231": 74, "0x18160ddd": 10, "0x313ce567": 10 };

export function multicallPolicy(): MulticallPolicy | false {
  if (process.env.DELPHI_MULTICALL === "0") return false;
  const hashes = (process.env.DELPHI_MULTICALL_CODE_HASHES ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (hashes.some((h) => !/^0x[\da-f]{64}$/.test(h))) throw new Error("invalid DELPHI_MULTICALL_CODE_HASHES: expected audited runtime hashes");
  return { codeHashes: new Set([...APPROVED_VIEW_CODE_HASHES, ...hashes] as Hex[]), batchSize: rpcSetting("DELPHI_MULTICALL_BATCH_SIZE", 128, 8, 512) };
}

/** Only audited, immutable getters are eligible: parity alone cannot prove arbitrary bytecode safe. */
export async function multicallViews(rpc: BatchRpc, calls: readonly Call[], block: bigint | "latest", policy: MulticallPolicy): Promise<Map<number, Hex>> {
  const out = new Map<number, Hex>();
  const groups = new Map<string, Array<{ index: number; call: Call; block: bigint }>>();
  const batchSize = policy.batchSize ?? 128;
  if (!Number.isSafeInteger(batchSize) || batchSize < 8 || batchSize > 512) throw new Error("invalid Multicall batch size");
  for (const [index, call] of calls.entries()) {
    const at = call.block ?? block;
    if (at === "latest" || call.data.length !== LENGTHS[call.data.slice(0, 10).toLowerCase()]) continue;
    const key = `${call.to.toLowerCase()}:${at}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push({ index, call, block: at });
  }
  const deployments = new Map<string, boolean>();
  for (const group of groups.values()) {
    if (group.length < 8 || !policy.codeHashes.size) continue;
    const tag = numberToHex(group[0]!.block);
    const accepted = new Map<number, Hex>();
    try {
      if (!deployments.has(tag)) {
        const code = await rpc.call<Hex>("eth_getCode", [MULTICALL3, tag]);
        deployments.set(tag, isHex(code) && keccak256(code) === (policy.multicallCodeHash ?? MULTICALL3_CODE_HASH));
      }
      if (!deployments.get(tag)) continue;
      const code = await rpc.call<Hex>("eth_getCode", [group[0]!.call.to, tag]);
      if (!isHex(code) || !policy.codeHashes.has(keccak256(code)) || delegationTarget(code) || hasDelegatecall(code)) continue;
      let mismatch = false;
      for (let i = 0; i < group.length; i += batchSize) {
        const part = group.slice(i, i + batchSize);
        const checks = [part[0]!, part.at(-1)!];
        const data = encodeFunctionData({ abi: AGGREGATE3, functionName: "aggregate3", args: [part.map(({ call }) => ({ target: call.to, allowFailure: true, callData: call.data }))] });
        const answers = await rpc.many<Hex>([
          { method: "eth_call", params: [{ to: MULTICALL3, data }, tag] },
          ...checks.map(({ call }) => ({ method: "eth_call", params: [{ to: call.to, data: call.data }, tag] })),
        ]);
        if (answers[0]!.error || !isHex(answers[0]!.result)) { mismatch = true; break; }
        const results = decodeFunctionResult({ abi: AGGREGATE3, functionName: "aggregate3", data: answers[0]!.result });
        if (results.length !== part.length) { mismatch = true; break; }
        for (const [j, position] of [0, part.length - 1].entries()) {
          const direct = answers[j + 1]!;
          const result = results[position]!;
          if (direct.error || !result.success || typeof direct.result !== "string" || direct.result.toLowerCase() !== result.returnData.toLowerCase()) mismatch = true;
        }
        if (mismatch) break;
        results.forEach((result, j) => {
          if (result.success && /^0x[\da-f]{64}$/i.test(result.returnData)) accepted.set(part[j]!.index, result.returnData);
        });
      }
      if (!mismatch) for (const [index, value] of accepted) out.set(index, value);
    } catch { /* Every unproven answer is read directly by viewsAt. */ }
  }
  return out;
}
