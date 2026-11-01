import { getAddress, type Address } from "viem";
import { describe, expect, it } from "vitest";
import { dustFloorOf, type Network } from "../src/config.ts";
import { ChainFunding, fundingCache } from "../src/funding.ts";
import { analyze } from "../src/report.ts";
import { BatchRpc } from "../src/rpc.ts";
import { Store } from "../src/store.ts";
import { scenario } from "./scenario.ts";

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

type World = {
  balance: (w: string, b: number) => bigint;
  nonce: (w: string, b: number) => number;
  blocks: Record<number, unknown>;
  traces: Record<number, unknown>;
};

/**
 * A tiny chain: A is paid by FUNDER in block 1000 (a plain transfer); B is paid by a multi-send
 * contract in block 2000, in a call SENDER made; D is paid in block 2500, spends everything in block
 * 3000 (balance back to 0, nonce 1); C never holds anything. Amounts are a few wei.
 */
const TINY: World = {
  balance: (w, b) => (w === A ? (b >= 1000 ? 5n : 0n) : w === B ? (b >= 2000 ? 7n : 0n) : w === D ? (b >= 2500 && b < 3000 ? 9n : 0n) : 0n),
  nonce: (w, b) => (w === D && b >= 3000 ? 1 : 0),
  blocks: {
    1000: { number: hex(1000), timestamp: hex(1_700_000_000), transactions: [{ hash: TX(1), from: FUNDER, to: A, value: hex(5) }] },
    2000: { number: hex(2000), timestamp: hex(1_700_001_000), transactions: [{ hash: TX(2), from: SENDER, to: MULTISEND, value: hex(7) }] },
    2500: { number: hex(2500), timestamp: hex(1_700_002_000), transactions: [{ hash: TX(3), from: FUNDER, to: D, value: hex(9) }] },
  },
  traces: {
    2000: [{ txHash: TX(2), result: { from: SENDER, to: MULTISEND, value: hex(7), type: "CALL", calls: [{ from: MULTISEND, to: B, value: hex(7), type: "CALL" }] } }],
  },
};

/**
 * ChainFunding over a fake node answering from `world`. No `dustFloor`: built exactly as before the floor
 * existed. `calls` records every read, in order.
 */
function node(world: World, opts: { brokenBlock?: number; dustFloor?: bigint; calls?: string[] } = {}) {
  const { balance, nonce, blocks, traces } = world;
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
    opts.calls?.push(...calls.map((c) => `${c.method} ${JSON.stringify(c.params)}`));
    const out = calls.map((c) => {
      try {
        return { jsonrpc: "2.0", id: c.id, result: answer(c.method, c.params) };
      } catch (err) {
        return { jsonrpc: "2.0", id: c.id, error: { code: -32000, message: (err as Error).message } };
      }
    });
    return new Response(JSON.stringify(out), { status: 200 });
  };
  const rpc = new BatchRpc("http://node", { fetch, sleep: async () => {}, gapMs: 0 });
  return opts.dustFloor === undefined ? new ChainFunding(rpc) : new ChainFunding(rpc, { dustFloor: opts.dustFloor });
}
const fakeChain = (opts: { brokenBlock?: number; dustFloor?: bigint; calls?: string[] } = {}) => node(TINY, opts);

// Mainnet, day one: every wallet starts empty, and a griefer dusts known wallets before their owners fund them.
const HYPE = 10n ** 18n;
const DUST = 10n ** 14n; // 0.0001 HYPE
const GRIEFER = "0x00000000000000000000000000000000000000d5";
const OWNER1 = "0x00000000000000000000000000000000000001e1";
const OWNER2 = "0x00000000000000000000000000000000000001e2";
const FARM = "0x0000000000000000000000000000000000000fa1";
const V1 = "0x0000000000000000000000000000000000000101";
const V2 = "0x0000000000000000000000000000000000000102";
const IDLE = "0x0000000000000000000000000000000000000103";
const RUN = "0x0000000000000000000000000000000000000104";
const SAME = "0x0000000000000000000000000000000000000105";
const ROUTER = "0x00000000000000000000000000000000000000aa";
const at = (n: number) => 1_700_000_000 + n;
const block = (n: number, txs: Array<[hash: string, from: string, to: string, value: bigint]>) => ({
  number: hex(n),
  timestamp: hex(at(n)),
  transactions: txs.map(([h, from, to, value]) => ({ hash: h, from, to, value: hex(value) })),
});
/**
 * Block 100: the griefer dusts V1, V2 and IDLE. 300: a farm sends RUN 0.005 HYPE (under the floor), which
 * RUN spends gas from in block 700, its first transaction. 500 and 600: V1's and V2's owners fund them.
 * 900: dust and SAME's real funding land in the same block, dust first. IDLE is never funded or used.
 */
const DUSTED: World = {
  balance: (w, b) =>
    w === V1 ? (b >= 500 ? DUST + HYPE : b >= 100 ? DUST : 0n)
    : w === V2 ? (b >= 600 ? DUST + 2n * HYPE : b >= 100 ? DUST : 0n)
    : w === IDLE ? (b >= 100 ? DUST : 0n)
    : w === RUN ? (b >= 700 ? 4n * 10n ** 15n : b >= 300 ? 5n * 10n ** 15n : 0n)
    : w === SAME ? (b >= 900 ? DUST + HYPE : 0n)
    : 0n,
  nonce: (w, b) => (w === RUN && b >= 700 ? 1 : 0),
  blocks: {
    100: block(100, [[TX(11), GRIEFER, V1, DUST], [TX(12), GRIEFER, V2, DUST], [TX(13), GRIEFER, IDLE, DUST]]),
    300: block(300, [[TX(14), FARM, RUN, 5n * 10n ** 15n]]),
    500: block(500, [[TX(15), OWNER1, V1, HYPE]]),
    600: block(600, [[TX(16), OWNER2, V2, 2n * HYPE]]),
    700: block(700, [[TX(17), RUN, ROUTER, 0n]]),
    900: block(900, [[TX(18), GRIEFER, SAME, DUST], [TX(19), OWNER1, SAME, HYPE]]),
  },
  traces: {},
};
const ALL: Address[] = [V1, V2, IDLE, RUN, SAME];
const funder = (got: Map<string, Array<{ from: string; tx: string }>>, w: string) => got.get(w)?.map((f) => [f.from.toLowerCase(), f.tx]);

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

describe("the dust floor (rules v0.6, mainnet)", () => {
  it("skips a first funding below the floor: the funder is whoever brought the wallet up to it", async () => {
    expect(dustFloorOf("mainnet")).toBe(10n ** 16n); // 0.01 HYPE
    const got = await node(DUSTED, { dustFloor: dustFloorOf("mainnet") }).fundingsMany(ALL);
    expect(got.get(V1)).toEqual([{ wallet: getAddress(V1), from: getAddress(OWNER1), via: "tx", value: HYPE, tx: TX(15), time: at(500) }]);
    expect(funder(got, V2)).toEqual([[OWNER2, TX(16)]]);
    // dusted, never funded and never used: no funding that counts, so it links no one
    expect(got.get(IDLE)).toEqual([]);
    // it ran on 0.005 HYPE before ever reaching the floor, so that money counts: a farm paying gas money still links
    expect(funder(got, RUN)).toEqual([[FARM, TX(14)]]);
    // dust and the real payment in the same block: the real one
    expect(funder(got, SAME)).toEqual([[OWNER1, TX(19)]]);
  });

  it("is the search from before on testnet: floor 0, the same reads, the same answers", async () => {
    expect(dustFloorOf("testnet")).toBe(0n);
    expect(ChainFunding.forNetwork("testnet").dustFloor).toBe(0n);
    for (const world of [TINY, DUSTED]) {
      const before: string[] = [];
      const after: string[] = [];
      const wallets: Address[] = world === TINY ? [A, B, C, D] : ALL;
      const plain = await node(world, { calls: before }).fundingsMany(wallets); // built as before the floor existed
      const testnet = await node(world, { calls: after, dustFloor: dustFloorOf("testnet") }).fundingsMany(wallets);
      expect(testnet).toEqual(plain);
      expect(after).toEqual(before);
    }
    // so on testnet the first HYPE is the funding, dust or not, and the first payment in a block wins
    const got = await node(DUSTED, { dustFloor: dustFloorOf("testnet") }).fundingsMany(ALL);
    expect([V1, V2, IDLE].map((w) => funder(got, w))).toEqual([[[GRIEFER, TX(11)]], [[GRIEFER, TX(12)]], [[GRIEFER, TX(13)]]]);
    expect(funder(got, RUN)).toEqual([[FARM, TX(14)]]);
    expect(funder(got, SAME)).toEqual([[GRIEFER, TX(18)]]);
  });

  it("keeps a griefer's dust from making a launch bundle on mainnet", async () => {
    // V1 and V2 buy 4% each within 30 s of launch
    const coin = async (network: Network) => {
      const got = await node(DUSTED, { dustFloor: dustFloorOf(network) }).fundingsMany([V1, V2]);
      const s = scenario().buy(getAddress(V1), 40, 5).buy(getAddress(V2), 40, 12);
      for (const [w, fs] of got) for (const f of fs) s.fundings.push({ wallet: getAddress(w), funder: f.from, value: f.value, tx: f.tx, time: f.time, kind: "transfer" });
      return analyze({ ...s.build(new Map(), [], { network }), network }, { explorerWeb: "https://explorer.test" });
    };
    const testnet = await coin("testnet");
    expect(testnet.findings).toMatchObject([{ detector: "bundle", severity: "watch", summary: expect.stringContaining("2 linked wallets") }]);
    expect(testnet.rules).toBe("delphi-v0.5");
    const mainnet = await coin("mainnet");
    expect(mainnet.checks.bundle).toBe("clear");
    expect(mainnet.findings).toEqual([]);
    expect(mainnet.rules).toBe("delphi-v0.6");
  });

  it("reads a funding cached on testnet as it always did, and keeps mainnet's apart", async () => {
    const store = new Store(":memory:");
    const saved = [{ from: getAddress(FUNDER), via: "tx", value: "5", tx: TX(1), time: 1_700_000_000 }]; // as collect() saves it
    store.remember("funding", A, saved);
    // where collect(), the workspace, the X bot and the review look on testnet: the same kind as always
    expect(fundingCache("testnet")).toBe("funding");
    expect(fundingCache("testnet", ChainFunding.forNetwork("testnet"))).toBe("funding");
    const calls: string[] = [];
    const testnet = fakeChain({ calls, dustFloor: dustFloorOf("testnet") });
    expect(testnet.cacheKind).toBe("funding");
    expect(await testnet.firstFundingFn(store)(getAddress(A))).toEqual({ wallet: getAddress(A), funder: getAddress(FUNDER), via: "tx", value: 5n, tx: TX(1), block: 0n, time: 1_700_000_000 });
    expect(calls).toEqual([]); // straight from the cache: not one chain read
    // mainnet's search keeps its own kind: it never takes testnet's entry, and never overwrites it
    const mainnet = fakeChain({ calls, dustFloor: dustFloorOf("mainnet") });
    expect(mainnet.cacheKind).toBe("funding-floor-10000000000000000");
    expect(fundingCache("mainnet", ChainFunding.forNetwork("mainnet"))).toBe(mainnet.cacheKind);
    expect(await mainnet.firstFundingFn(store)(getAddress(A))).toBeNull(); // 5 wei, never a transaction: under the floor
    expect(calls.length).toBeGreaterThan(0);
    expect(store.recall("funding", A)).toEqual(saved);
    expect(store.recall(mainnet.cacheKind, A)).toEqual([]);
    // a search built for the other network is refused before it can save under the wrong name
    expect(() => fundingCache("mainnet", new ChainFunding())).toThrow(/dust floor of 0 wei, but the mainnet rules say 10000000000000000/);
    expect(() => fundingCache("testnet", ChainFunding.forNetwork("mainnet"))).toThrow(/dust floor/);
    store.close();
  });
});
