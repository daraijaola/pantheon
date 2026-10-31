// Reads a contract's runtime bytecode without its source: which functions it really answers to (its
// dispatcher), whether it is a minimal proxy or a wallet's EIP-7702 delegation, and whether it can
// hand its calls to other code (DELEGATECALL). Pure functions over bytes; nothing here touches the chain.
import { getAddress, hexToBytes, type Address, type Hex } from "viem";

const OP = {
  EQ: 0x14,
  ISZERO: 0x15,
  XOR: 0x18,
  JUMPI: 0x57,
  JUMPDEST: 0x5b,
  PUSH1: 0x60,
  PUSH3: 0x62,
  PUSH4: 0x63,
  PUSH32: 0x7f,
  DUP1: 0x80,
  DUP16: 0x8f,
  DELEGATECALL: 0xf4,
} as const;

/** One instruction: where it is, its opcode, and the bytes it pushes (PUSH1..PUSH32 only). */
export type Instruction = { pc: number; op: number; push?: Uint8Array };

/** Walks the code one instruction at a time, skipping the data bytes after each PUSH. */
export function instructions(code: Uint8Array): Instruction[] {
  const out: Instruction[] = [];
  for (let pc = 0; pc < code.length; ) {
    const op = code[pc]!;
    if (op >= OP.PUSH1 && op <= OP.PUSH32) {
      const n = op - OP.PUSH1 + 1;
      out.push({ pc, op, push: code.subarray(pc + 1, pc + 1 + n) });
      pc += 1 + n;
    } else {
      out.push({ pc, op });
      pc += 1;
    }
  }
  return out;
}

const toInt = (b: Uint8Array) => b.reduce((n, x) => n * 256 + x, 0);
const isDup = (op: number) => op >= OP.DUP1 && op <= OP.DUP16;
const isSmallPush = (i: Instruction | undefined, max: number) => !!i?.push && i.push.length <= max;

/**
 * The 4-byte selectors the contract's dispatcher compares the call against: its real public functions.
 *
 * A PUSH4 alone proves nothing: contracts also push 4-byte constants to build calls to other contracts
 * (`PUSH4 sel PUSH1 0xe0 SHL`), to revert with custom errors, or as plain numbers. A selector counts only
 * when it sits in a dispatch test that jumps to real code:
 *
 *   PUSH1..4 sel  [DUPn]  EQ           PUSH1..3 dest  JUMPI    (solc, legacy and via-IR: jump into the function)
 *   PUSH1..4 sel  [DUPn]  XOR | EQ ISZERO  PUSH1..3 dest  JUMPI (jump past it when it is not this function)
 *
 * and `dest` must be a real JUMPDEST (an instruction, not a byte inside push data). solc pushes a selector
 * with a leading zero byte as PUSH3 (0xcfe24f for 0x00cfe24f), so PUSH3 counts too and is padded back
 * to 4 bytes; shorter pushes are small numbers (enum switches, the receive check), not functions. The binary
 * search solc uses for big contracts (`sel GT … JUMPI`) only splits the list; each function is still
 * matched by its own EQ. Dispatchers this does not recognise (Vyper's hash tables, hand-written code)
 * yield few or no selectors; callers must treat "no transfer() found" as "could not read". A contract
 * that carries another contract's code (a factory with `new Pool()`) can show a stray function of the
 * child's: seen once in Kalos's factory (`ticks(int24)` of the pool), never in a token.
 */
export function dispatchSelectors(code: Hex | Uint8Array): Set<Hex> {
  const bytes = typeof code === "string" ? hexToBytes(code) : code;
  const ins = instructions(bytes);
  const jumpdests = new Set(ins.filter((i) => i.op === OP.JUMPDEST).map((i) => i.pc));
  const out = new Set<Hex>();
  for (let i = 0; i < ins.length; i++) {
    const sel = ins[i]!;
    if (sel.op !== OP.PUSH3 && sel.op !== OP.PUSH4) continue;
    let j = i + 1;
    if (ins[j] && isDup(ins[j]!.op)) j++;
    let cmp = ins[j]?.op;
    if (cmp === OP.EQ && ins[j + 1]?.op === OP.ISZERO) {
      cmp = OP.ISZERO;
      j++;
    }
    if (cmp !== OP.EQ && cmp !== OP.XOR && cmp !== OP.ISZERO) continue;
    const dest = ins[j + 1];
    if (!isSmallPush(dest, 3) || ins[j + 2]?.op !== OP.JUMPI) continue;
    if (!jumpdests.has(toInt(dest!.push!))) continue;
    out.add(`0x${Buffer.from(sel.push!).toString("hex").padStart(8, "0")}`);
  }
  return out;
}

/** Every 4-byte value pushed anywhere in the code (for comparison only: most are not functions). */
export function pushedSelectors(code: Hex | Uint8Array): Set<Hex> {
  const bytes = typeof code === "string" ? hexToBytes(code) : code;
  const out = new Set<Hex>();
  for (const i of instructions(bytes)) if (i.op === OP.PUSH4) out.add(`0x${Buffer.from(i.push!).toString("hex")}`);
  return out;
}

/** The code can run other contracts' code as its own (a proxy, or a library user). */
export function hasDelegatecall(code: Hex | Uint8Array): boolean {
  const bytes = typeof code === "string" ? hexToBytes(code) : code;
  return instructions(bytes).some((i) => i.op === OP.DELEGATECALL);
}

/** EIP-1167 minimal proxy ("clone"): 45 bytes that forward every call to one fixed contract. */
const CLONE = /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/i;

/** The contract an EIP-1167 clone forwards to, or null. A clone can never be pointed elsewhere. */
export function cloneTarget(code: Hex): Address | null {
  const m = CLONE.exec(code);
  return m ? getAddress(`0x${m[1]}`) : null;
}

/** EIP-7702: a wallet that delegates to code (`0xef0100` + address) is still a wallet, not a contract. */
export function delegationTarget(code: Hex): Address | null {
  const m = /^0xef0100([0-9a-f]{40})$/i.exec(code);
  return m ? getAddress(`0x${m[1]}`) : null;
}

/** Runtime size in bytes. */
export const codeSize = (code: Hex) => (code.length - 2) / 2;
