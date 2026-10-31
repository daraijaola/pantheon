import { describe, expect, it } from "vitest";
import { ChainFunding } from "../src/funding.ts";
import { BatchRpc } from "../src/rpc.ts";

const A = "0x00000000000000000000000000000000000000a1";
const B = "0x00000000000000000000000000000000000000b2";
const C = "0x00000000000000000000000000000000000000c3";
const D = "0x00000000000000000000000000000000000000d4";
const FUNDER = "0x00000000000000000000000000000000000000f1";
const SENDER = "0x00000000000000000000000000000000000000f2";
const MULTISEND = "0x00000000000000000000000000000000000000ee";
const TX = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const hex = (n: number | bigint) => `0x${n.toString(16)}`;
const HEAD = 1_000_000;

/**
 * A tiny chain: A is paid by FUNDER in block 1000 (a plain transfer); B is paid by a multi-send
 * contract in block 2000, in a call SENDER made; D is paid in block 2500, spends everything in block
 * 3000 (balance back to 0, nonce 1); C never holds anything.
 */
function fakeChain(opts: { brokenBlock?: number } = {}) {
  const balance = (w: string, b: number) =>
    w === A ? (b >= 1000 ? 5n : 0n) : w === B ? (b >= 2000 ? 7n : 0n) : w === D ? (b >= 2500 && b < 3000 ? 9n : 0n) : 0n;
  const nonce = (w: string, b: number) => (w === D && b >= 3000 ? 1 : 0);
  const blocks: Record<number, unknown> = {
    1000: { number: hex(1000), timestamp: hex(1_700_000_000), transactions: [{ hash: TX(1), from: FUNDER, to: A, value: hex(5) }] },
    2000: { number: hex(2000), timestamp: hex(1_700_001_000), transactions: [{ hash: TX(2), from: SENDER, to: MULTISEND, value: hex(7) }] },
    2500: { number: hex(2500), timestamp: hex(1_700_002_000), transactions: [{ hash: TX(3), from: FUNDER, to: D, value: hex(9) }] },
  };
  const traces: Record<number, unknown> = {
    2000: [{ txHash: TX(2), result: { from: SENDER, to: MULTISEND, value: hex(7), type: "CALL", calls: [{ from: MULTISEND, to: B, value: hex(7), type: "CALL" }] } }],
  };
  const answer = (method: string, params: unknown[]): unknown => {
    const at = (p: unknown) => (p === "latest" ? HEAD : Number(BigInt(p as string)));
    if (method === "eth_blockNumber") return hex(HEAD);
    if (method === "eth_getBalance") return hex(balance(params[0] as string, at(params[1])));
    if (method === "eth_getTransactionCount") return hex(nonce(params[0] as string, at(params[1])));
    const n = at(params[0]);
    if (n === opts.brokenBlock) throw new Error("missing trie node");
    if (method === "eth_getBlockByNumber") return blocks[n] ?? { number: hex(n), timestamp: hex(0), transactions: [] };
    if (method === "debug_traceBlockByNumber") return traces[n] ?? [];
    throw new Error(`unexpected ${method}`);
  };
  const fetch = async (_url: string, init?: RequestInit) => {
    const calls = JSON.parse(String(init!.body)) as Array<{ id: number; method: string; params: unknown[] }>;
    const out = calls.map((c) => {
      try {
        return { jsonrpc: "2.0", id: c.id, result: answer(c.method, c.params) };
      } catch (err) {
        return { jsonrpc: "2.0", id: c.id, error: { code: -32000, message: (err as Error).message } };
      }
    });
    return new Response(JSON.stringify(out), { status: 200 });
  };
  return new ChainFunding(new BatchRpc("http://node", { fetch, sleep: async () => {}, gapMs: 0 }));
}

describe("ChainFunding", () => {
  it("finds the first block each wallet held or spent anything", async () => {
    const got = await fakeChain().firstBlocks([A, B, C, D], BigInt(HEAD));
    expect(got.get(A)).toBe(1000n);
    expect(got.get(B)).toBe(2000n);
    expect(got.get(C)).toBeNull();
    // Drained back to zero later: the nonce keeps the search honest.
    expect(got.get(D)).toBe(2500n);
  });

  it("names who paid: a plain transfer, or a contract paying inside someone's call", async () => {
    const got = await fakeChain().fundingsMany([A, B, C, D]);
    expect(got.get(A)).toEqual([{ wallet: expect.stringMatching(/a1$/i), from: expect.stringMatching(/f1$/i), via: "tx", value: 5n, tx: TX(1), time: 1_700_000_000 }]);
    expect(got.get(B)![0]).toMatchObject({ from: expect.stringMatching(/ee$/i), via: "internal", value: 7n, tx: TX(2) });
    expect(got.get(C)).toEqual([]);
    expect(got.get(D)![0]).toMatchObject({ via: "tx", tx: TX(3) });
  });

  it("leaves out wallets whose funding block could not be read", async () => {
    const got = await fakeChain({ brokenBlock: 2000 }).fundingsMany([A, B]);
    expect(got.has(A.toLowerCase())).toBe(true);
    expect(got.has(B.toLowerCase())).toBe(false);
  });

  it("counts sent transactions", async () => {
    const got = await fakeChain().txCounts([D, A]);
    expect(got.get(D)).toBe(1);
    expect(got.get(A)).toBe(0);
  });
});
