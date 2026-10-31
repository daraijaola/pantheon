import { readFileSync } from "node:fs";
import { toFunctionSelector, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { cloneTarget, codeSize, delegationTarget, dispatchSelectors, hasDelegatecall, pushedSelectors } from "../src/bytecode.ts";
import type { Tape } from "../src/tape.ts";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/safety/${name}.json`, import.meta.url), "utf8")) as Tape;
const codeOn = (tape: Tape, address: string) => tape.rpc.find((e) => e.method === "eth_getCode" && String(e.params[0]).toLowerCase() === address.toLowerCase())!.result as Hex;

/**
 * A tiny assembler: opcodes as numbers, { push: "hex" } for PUSHn (`mark` names the position of its
 * first data byte), { label } for a JUMPDEST and { to: label } for a PUSH2 of that label's position.
 * Enough to write dispatchers by hand.
 */
type Op = number | { push: string; mark?: string } | { label: string } | { to: string };
function assemble(ops: Op[]): Hex {
  const size = (o: Op) => (typeof o === "number" ? 1 : "push" in o ? 1 + o.push.length / 2 : "label" in o ? 1 : 3);
  const at = new Map<string, number>();
  let pc = 0;
  for (const o of ops) {
    if (typeof o === "object" && "label" in o) at.set(o.label, pc);
    if (typeof o === "object" && "push" in o && o.mark) at.set(o.mark, pc + 1);
    pc += size(o);
  }
  const hex = ops.map((o) => {
    if (typeof o === "number") return o.toString(16).padStart(2, "0");
    if ("push" in o) return (0x5f + o.push.length / 2).toString(16) + o.push;
    if ("label" in o) return "5b";
    return `61${at.get(o.to)!.toString(16).padStart(4, "0")}`;
  });
  return `0x${hex.join("")}`;
}
const [DUP1, DUP2, EQ, GT, XOR, SHL, MSTORE, JUMPI, STOP, CALLDATALOAD, SHR] = [0x80, 0x81, 0x14, 0x11, 0x18, 0x1b, 0x52, 0x57, 0x00, 0x35, 0x1c];
const s = (sig: string) => toFunctionSelector(sig).slice(2);

describe("dispatchSelectors", () => {
  const code = assemble([
    { push: "00" }, CALLDATALOAD, { push: "e0" }, SHR,
    // Real entries: solc's `DUP1 PUSH4 sel EQ PUSH2 dest JUMPI`, a selector with a leading zero byte
    // (PUSH3), and Vyper's "jump past it when it is not this one" (XOR).
    DUP1, { push: s("transfer(address,uint256)") }, EQ, { to: "transfer" }, JUMPI,
    DUP1, { push: "cfe24f" }, EQ, { to: "zeroLed" }, JUMPI,
    { push: s("balanceOf(address)") }, DUP2, XOR, { to: "notBalanceOf" }, JUMPI, STOP,
    { label: "notBalanceOf" },
    // Binary search pivot: splits the list, is not itself an entry.
    DUP1, { push: s("blacklist(address)") }, GT, { to: "transfer" }, JUMPI,
    // Fake 1: mint()'s selector pushed to call another contract (PUSH4 sel PUSH1 0xe0 SHL … MSTORE).
    { push: s("mint(address,uint256)") }, { push: "e0" }, SHL, { push: "00" }, MSTORE,
    // Fake 2: a dispatch-shaped test whose jump target is not a JUMPDEST.
    DUP1, { push: s("pause()") }, EQ, { push: "0001" }, JUMPI,
    // Fake 3: the jump lands on a 0x5b byte that is push data, not code.
    { push: "5b", mark: "insidePush" }, DUP1, { push: s("setFee(uint256)") }, EQ, { to: "insidePush" }, JUMPI,
    { label: "transfer" }, STOP,
    { label: "zeroLed" }, STOP,
  ]);

  it("finds the functions the dispatcher really tests, and only those", () => {
    expect([...dispatchSelectors(code)].sort()).toEqual([toFunctionSelector("balanceOf(address)"), toFunctionSelector("transfer(address,uint256)"), "0x00cfe24f"].sort());
  });

  it("ignores 4-byte constants that are not function entries", () => {
    const pushed = pushedSelectors(code);
    for (const fake of ["mint(address,uint256)", "pause()", "setFee(uint256)", "blacklist(address)"]) {
      expect(pushed.has(toFunctionSelector(fake))).toBe(true);
      expect(dispatchSelectors(code).has(toFunctionSelector(fake))).toBe(false);
    }
  });

  it("reads KALOS's real code as the nine plain ERC-20 functions", () => {
    const kalos = codeOn(fixture("kalos"), "0x8a2201953AF29e8BE7700bcB53dA3ce5caD18726");
    const erc20 = ["name()", "symbol()", "decimals()", "totalSupply()", "balanceOf(address)", "transfer(address,uint256)", "transferFrom(address,address,uint256)", "approve(address,uint256)", "allowance(address,address)"];
    expect([...dispatchSelectors(kalos)].sort()).toEqual(erc20.map((f) => toFunctionSelector(f)).sort());
    expect(pushedSelectors(kalos).size).toBeGreaterThan(9); // error selectors and the like, correctly left out
  });

  it("does not take a contract that calls transfer() on tokens for a token (a real liquidity helper)", () => {
    const { code: helper } = JSON.parse(readFileSync(new URL("./fixtures/safety/helper-code.json", import.meta.url), "utf8")) as { code: Hex };
    const transfer = toFunctionSelector("transfer(address,uint256)");
    expect(pushedSelectors(helper).has(transfer)).toBe(true);
    expect(dispatchSelectors(helper)).toEqual(new Set(["0x0989f3b9", "0x481c6a75", "0x91dd7346"]));
  });
});

describe("proxies and wallets in code", () => {
  it("reads where an EIP-1167 clone forwards (NFALC, live)", () => {
    const code = codeOn(fixture("nfalc"), "0xCF52DE746CA0b5b8fCC2cC674A69C9B8B8768779");
    expect(codeSize(code)).toBe(45);
    expect(cloneTarget(code)).toBe("0xd82516B3307Bafa36AB956FF193d773608BB8bE9");
    expect(hasDelegatecall(code)).toBe(true);
    expect(cloneTarget(codeOn(fixture("kalos"), "0x8a2201953AF29e8BE7700bcB53dA3ce5caD18726"))).toBeNull();
  });

  it("knows an EIP-7702 wallet delegation is a wallet", () => {
    expect(delegationTarget("0xef0100cd57f65c2b0e5881cfc2e609f7cd53b746e1f234")).toBe("0xCD57F65c2B0e5881CFC2E609F7CD53b746E1F234");
    expect(delegationTarget("0x6080")).toBeNull();
  });
});
