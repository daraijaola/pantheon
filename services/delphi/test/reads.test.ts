import { readFileSync } from "node:fs";
import { getAddress, numberToHex, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { findCreation, kindsOf, scanStreams, sendersOf } from "../src/reads.ts";
import { BatchRpc } from "../src/rpc.ts";
import { Store } from "../src/store.ts";

type Req = { id: number; method: string; params: unknown[] };
const quiet = { sleep: async () => {}, gapMs: 0 };
const TOPIC = `0x${"ee".repeat(32)}`;
const ADDR = "0x00000000000000000000000000000000000000aa";

/** A fake node with one log at each of `blocks`; it refuses a range holding more than `limit` logs, as the explorer's node does. */
function logNode(blocks: number[], limit = 10) {
  const ranges: Array<[number, number]> = [];
  const fetch = async (_url: string, init?: RequestInit) => {
    const calls = JSON.parse(String(init!.body)) as Req[];
    const out = calls.map((c) => {
      const q = c.params[0] as { fromBlock: string; toBlock: string };
      const [from, to] = [Number(q.fromBlock), Number(q.toBlock)];
      ranges.push([from, to]);
      const hit = blocks.filter((b) => b >= from && b <= to);
      if (hit.length > limit) return { jsonrpc: "2.0", id: c.id, error: { code: -32005, message: `logs count limit exceeded (${limit}) consider refine/narrow down your query` } };
      return {
        jsonrpc: "2.0",
        id: c.id,
        result: hit.map((b) => ({ blockNumber: numberToHex(b), logIndex: "0x0", transactionHash: `0x${b.toString(16).padStart(64, "0")}`, address: ADDR, topics: [TOPIC], data: "0x", blockTimestamp: numberToHex(1_000 + b) })),
      };
    });
    return new Response(JSON.stringify(out), { status: 200 });
  };
  return { fetch, ranges };
}

describe("scanStreams", () => {
  const blocks = [...Array.from({ length: 40 }, (_, i) => 100 + i), 5_000, 9_999];
  const spec = { stream: "s", address: ADDR as `0x${string}`, topics: [TOPIC as `0x${string}`], from: 0n, to: 10_000n, times: true };

  it("reads every log once, in order, narrowing ranges the node refuses", async () => {
    const node = logNode(blocks);
    const store = new Store(":memory:");
    const got = await scanStreams(new BatchRpc("http://node", { ...quiet, fetch: node.fetch }), store, [spec]);
    expect(got.get("s")).toEqual({ found: blocks.length, capped: false });
    expect(store.logs("s").map((l) => Number(l.block))).toEqual(blocks);
    expect(store.cursor("s", 0n)).toBe(10_001n);
    expect(store.recall("blocktime", "5000")).toBe(6_000);
    // A later run asks only for what is new.
    const later = logNode([...blocks, 10_500]);
    await scanStreams(new BatchRpc("http://node", { ...quiet, fetch: later.fetch }), store, [{ ...spec, to: 11_000n }]);
    expect(later.ranges.every(([from]) => from >= 10_001)).toBe(true);
    expect(store.logs("s")).toHaveLength(blocks.length + 1);
  });

  it("stops a stream that turns out far busier than expected", async () => {
    const store = new Store(":memory:");
    const got = await scanStreams(new BatchRpc("http://node", { ...quiet, fetch: logNode(blocks).fetch }), store, [{ ...spec, maxLogs: 20 }]);
    expect(got.get("s")!.capped).toBe(true);
    expect(store.cursor("s", 0n)).toBeLessThan(10_001n);
  });
});

describe("sendersOf and kindsOf", () => {
  const W = "0x00000000000000000000000000000000000000b1";
  const C = "0x00000000000000000000000000000000000000c1";
  const P = "0x00000000000000000000000000000000000000d1";
  const D = "0x00000000000000000000000000000000000000e1"; // EIP-7702 delegated wallet
  const node = (seen: string[]) => async (_url: string, init?: RequestInit) => {
    const calls = JSON.parse(String(init!.body)) as Req[];
    seen.push(...calls.map((c) => c.method));
    const answer = (c: Req) => {
      if (c.method === "eth_getTransactionByHash") return { result: { from: W } };
      if (c.method === "eth_getCode") return { result: { [W]: "0x", [C]: "0x6080", [P]: "0x6080", [D]: `0xef0100${"11".repeat(20)}` }[c.params[0] as string] };
      const to = (c.params[0] as { to: string }).to;
      return to === P ? { result: `0x${"00".repeat(12)}${"22".repeat(20)}` } : { error: { code: 3, message: "execution reverted" } };
    };
    return new Response(JSON.stringify(calls.map((c) => ({ jsonrpc: "2.0", id: c.id, ...answer(c) }))), { status: 200 });
  };

  it("asks the node once, then answers from the cache", async () => {
    const seen: string[] = [];
    const store = new Store(":memory:");
    const rpc = new BatchRpc("http://node", { ...quiet, fetch: node(seen) });
    const tx = `0x${"ab".repeat(32)}`;
    expect((await sendersOf(rpc, store, [tx])).get(tx)).toBe(getAddress(W));
    const kinds = await kindsOf(rpc, store, [W, C, P, D]);
    expect(Object.fromEntries(kinds)).toEqual({ [W]: "wallet", [C]: "contract", [P]: "pool", [D]: "wallet" });
    const before = seen.length;
    await sendersOf(rpc, store, [tx]);
    await kindsOf(rpc, store, [W, C, P, D]);
    expect(seen.length).toBe(before);
  });
});

describe("hybrid sender reads", () => {
  const hashes = [1, 2, 3, 4].map((n) => numberToHex(n, { size: 32 }));
  const wallets = hashes.map((_, i) => numberToHex(100 + i, { size: 20 }));
  const blocks = new Map([[hashes[0]!, 10n], [hashes[1]!, 10n], [hashes[2]!, 11n]]);
  type Mode = "ok" | "missing" | "null" | "malformed" | "denied" | "network" | "wrong-block" | "wrong-tx-block" | "duplicate" | "direct-error";
  function senderNode(mode: Mode = "ok") {
    const seen: Req[] = [];
    const fetch = async (_url: string, init?: RequestInit) => {
      const calls = JSON.parse(String(init!.body)) as Req[];
      seen.push(...calls);
      if (mode === "network" && calls.some((c) => c.method === "eth_getBlockByNumber")) throw new Error("temporary block endpoint failure");
      return new Response(JSON.stringify(calls.map((c) => {
        if (c.method === "eth_getTransactionByHash") {
          const index = hashes.indexOf(c.params[0] as Hex);
          return { id: c.id, result: mode === "direct-error" ? null : { from: wallets[index] } };
        }
        if (mode === "denied") return { id: c.id, error: { code: -32601, message: "method not allowed" } };
        if (mode === "null" || mode === "direct-error") return { id: c.id, result: null };
        let transactions: unknown[] = hashes.slice(0, mode === "missing" ? 1 : 2).map((hash, i) => ({ hash, from: wallets[i], blockNumber: mode === "wrong-tx-block" ? "0xc" : "0xa" }));
        if (mode === "malformed") transactions = [hashes[0], { hash: hashes[1], from: "not-an-address" }];
        if (mode === "duplicate") transactions.push({ hash: hashes[0], from: wallets[3] });
        return { id: c.id, result: { number: mode === "wrong-block" ? "0xc" : "0xa", transactions } };
      })));
    };
    return { seen, rpc: new BatchRpc(`http://hybrid-${mode}`, { ...quiet, retries: 0, fetch }) };
  }
  it("uses full blocks only for multiple needed hashes and preserves deduplication/order", async () => {
    const n = senderNode(), progress: Array<[number, number]> = [];
    const store = new Store(":memory:");
    const out = await sendersOf(n.rpc, store, [...hashes, hashes[0]!.toUpperCase().replace("0X", "0x")], (d, t) => progress.push([d, t]), blocks);
    expect([...out]).toEqual(hashes.map((h, i) => [h, getAddress(wallets[i]!)]));
    expect(n.seen.map((r) => r.method)).toEqual(["eth_getBlockByNumber", "eth_getTransactionByHash", "eth_getTransactionByHash"]);
    expect(n.seen[0]!.params).toEqual(["0xa", true]);
    expect(progress).toEqual([[4, 4]]);
    const before = n.seen.length;
    await sendersOf(n.rpc, store, hashes, undefined, blocks);
    expect(n.seen).toHaveLength(before);
    store.close();
  });
  it("counts only cache misses when deciding whether a full block saves requests", async () => {
    const store = new Store(":memory:"), n = senderNode();
    store.remember("txfrom", hashes[0]!, getAddress(wallets[0]!));
    await sendersOf(n.rpc, store, hashes.slice(0, 2), undefined, blocks);
    expect(n.seen.map((r) => r.method)).toEqual(["eth_getTransactionByHash"]);
    store.close();
  });
  it.each(["missing", "null", "malformed", "denied", "network", "wrong-block", "wrong-tx-block", "duplicate"] as const)("falls back to per-tx reads on %s", async (mode) => {
    const n = senderNode(mode), store = new Store(":memory:");
    expect([...await sendersOf(n.rpc, store, hashes, undefined, blocks)]).toEqual(hashes.map((h, i) => [h, getAddress(wallets[i]!)]));
    expect(n.seen.some((r) => r.method === "eth_getTransactionByHash" && r.params[0] === hashes[1])).toBe(mode !== "duplicate");
    store.close();
  });
  it("does not cache a partial chunk if direct fallback fails; empty input is offline", async () => {
    const n = senderNode("direct-error"), store = new Store(":memory:");
    expect(await sendersOf(n.rpc, store, [], undefined, blocks)).toEqual(new Map());
    expect(n.seen).toEqual([]);
    await expect(sendersOf(n.rpc, store, hashes, undefined, blocks)).rejects.toThrow("eth_getTransactionByHash");
    expect(store.recallMany("txfrom", hashes).size).toBe(0);
    store.close();
  });
});

describe("findCreation", () => {
  // The block in which a factory created ANEMOS (recorded live): the explorer's API named no sender.
  const fx = JSON.parse(readFileSync(new URL("./fixtures/kalos/creation-trace.json", import.meta.url), "utf8")) as { trace: Parameters<typeof findCreation>[0] };

  it("finds who sent the transaction and which factory made the contract", () => {
    expect(findCreation(fx.trace, "0x141A784764d69EC29d9AFa8a75B6ffD92fBA8A9f")).toEqual({
      tx: "0x07433249d597dadd429778d6dac9bee63c4599d93aebc135f35b9df7e2b81338",
      deployer: getAddress("0xf2cb6f16267d00118c9d3e850270a5c8af3f136b"),
      factory: getAddress("0x3b505d4d4b88a6ea03bc4209a241d6636f62e41b"),
    });
    expect(findCreation(fx.trace, "0x0000000000000000000000000000000000000001")).toBeNull();
  });
});
