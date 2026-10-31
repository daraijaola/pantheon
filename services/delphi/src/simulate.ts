// Dry runs on the explorer's node with eth_simulateV1: a list of calls run one after another in one
// pretend block on top of real chain state, nothing signed and nothing sent. With `validation: false`
// the node takes any `from` without a signature, nonce or gas money (checked live 2026-10-31: a
// transfer "from" a real KALOS holder ran and moved the tokens in the pretend block only).
import { decodeErrorResult, getAddress, isHex, parseAbi, toHex, type Address, type Hex } from "viem";
import { z } from "zod";
import type { BatchRpc } from "./rpc.ts";

export type SimCall = { from: Address; to: Address; data: Hex; value?: bigint };
export type SimLog = { address: Address; topics: Hex[]; data: Hex };
export type SimResult = { ok: boolean; returnData: Hex; logs: SimLog[]; revert: Revert | null; gasUsed: bigint };
/** Why a call failed: the raw revert data and, when it is a known error, its plain reading. */
export type Revert = { data: Hex | null; reason: string | null; message: string };

const hex = z.string().refine((v) => isHex(v)) as unknown as z.ZodType<Hex>;
const SimAnswer = z.array(
  z.object({
    calls: z.array(
      z.object({
        status: hex,
        returnData: hex.optional(),
        gasUsed: hex,
        logs: z.array(z.object({ address: hex, topics: z.array(hex), data: hex })).optional(),
        error: z.object({ code: z.number(), message: z.string(), data: hex.optional() }).optional(),
      }),
    ),
  }),
);

/** Errors seen on Elysium tokens, plus OpenZeppelin v5's ERC-20, Ownable, Pausable and AccessControl ones. */
const KNOWN_ERRORS = parseAbi([
  "error Error(string)",
  "error Panic(uint256)",
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
  "error ERC20InvalidSender(address sender)",
  "error ERC20InvalidReceiver(address receiver)",
  "error EnforcedPause()",
  "error OwnableUnauthorizedAccount(address account)",
  "error AccessControlUnauthorizedAccount(address account, bytes32 neededRole)",
]);

/** The revert data in plain words when it is a known error; null when it is not. */
export function revertReason(data: Hex | null | undefined): string | null {
  if (!data || data === "0x") return null;
  try {
    const e = decodeErrorResult({ abi: KNOWN_ERRORS, data });
    if (e.errorName === "Error") return String(e.args[0]);
    if (e.errorName === "Panic") return `Panic(${String(e.args[0])})`;
    return `${e.errorName}(${(e.args ?? []).map(String).join(", ")})`;
  } catch {
    return null;
  }
}

/**
 * Runs `calls` in order in one pretend block on top of `block`. `balances` gives pretend wallets
 * native HYPE to spend (only fresh test wallets: real holders' balances are never changed).
 */
export async function simulate(rpc: BatchRpc, block: Hex, calls: readonly SimCall[], balances: Record<Address, bigint> = {}): Promise<SimResult[]> {
  const stateOverrides = Object.fromEntries(Object.entries(balances).map(([a, wei]) => [a, { balance: toHex(wei) }]));
  const request = {
    blockStateCalls: [
      {
        ...(Object.keys(stateOverrides).length ? { stateOverrides } : {}),
        calls: calls.map((c) => ({ from: c.from, to: c.to, data: c.data, ...(c.value ? { value: toHex(c.value) } : {}) })),
      },
    ],
    validation: false,
  };
  const answer = SimAnswer.parse(await rpc.call("eth_simulateV1", [request, block]));
  const got = answer[0]?.calls ?? [];
  if (got.length !== calls.length) throw new Error(`eth_simulateV1 answered ${got.length} calls for ${calls.length}`);
  return got.map((c) => {
    const ok = BigInt(c.status) === 1n;
    return {
      ok,
      returnData: c.returnData ?? "0x",
      logs: (c.logs ?? []).map((l) => ({ address: getAddress(l.address), topics: l.topics, data: l.data })),
      revert: ok ? null : { data: c.error?.data ?? null, reason: revertReason(c.error?.data), message: c.error?.message ?? "reverted" },
      gasUsed: BigInt(c.gasUsed),
    };
  });
}
