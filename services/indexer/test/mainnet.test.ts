import { encodeAbiParameters, encodeEventTopics, parseAbi, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { toRec, vaultAbi } from "../src/chain.ts";

const addr = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}`;
const contracts = { seat: addr(1), vault: addr(2), registry: addr(3), staking: addr(4) };
const base = { transactionHash: `0x${"ab".repeat(32)}` as Hex, blockNumber: 1n, logIndex: 0 };
const seatAbi = parseAbi(["event PayeeClaimed(uint256 indexed slot, address indexed account, bool tokenSide, uint256 amount)"]);

describe("V5 fee indexing", () => {
  it("indexes the vault receipt, not both copies of the same 85% payment", () => {
    const seatLog = { ...base, address: contracts.seat, topics: encodeEventTopics({ abi: seatAbi, eventName: "PayeeClaimed", args: { slot: 1n, account: contracts.vault } }) as Hex[], data: encodeAbiParameters([{ type: "bool" }, { type: "uint256" }], [false, 85n]) };
    const vaultLog = { ...base, logIndex: 1, address: contracts.vault, topics: encodeEventTopics({ abi: vaultAbi, eventName: "FeesClaimed" }) as Hex[], data: encodeAbiParameters([{ type: "uint256" }], [85n]) };
    expect(toRec(seatLog, contracts)).toBeNull();
    expect(toRec(vaultLog, contracts)).toMatchObject({ kind: "to-basket", amount: "85" });
    expect(toRec({ ...vaultLog, data: encodeAbiParameters([{ type: "uint256" }], [0n]) }, contracts)).toBeNull();
    expect(toRec({ ...vaultLog, address: addr(9) }, contracts)).toBeNull();
    expect(toRec({ ...vaultLog, data: "0x" }, contracts)).toBeNull();
  });

  it("indexes only the quote-side team claim as a PAY leg", () => {
    const log = { ...base, address: contracts.seat, topics: encodeEventTopics({ abi: seatAbi, eventName: "PayeeClaimed", args: { slot: 0n, account: addr(5) } }) as Hex[], data: encodeAbiParameters([{ type: "bool" }, { type: "uint256" }], [false, 15n]) };
    expect(toRec(log, contracts)).toMatchObject({ kind: "leg", side: "quote", job: "PAY", amount: "15", to: addr(5) });
    expect(toRec({ ...log, data: encodeAbiParameters([{ type: "bool" }, { type: "uint256" }], [true, 15n]) }, contracts)).toBeNull();
  });
});
