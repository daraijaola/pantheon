import { describe, expect, it } from "vitest";
import { BatchRpc, RpcError } from "../src/rpc.ts";

type Req = { id: number; method: string; params: unknown[] };

/** A fake node: answers each call with `answer(call, attempt)`; records every request it got. */
function fakeNode(answer: (c: Req, attempt: number) => { result?: unknown; error?: { code: number; message: string } }) {
  const seen: Req[][] = [];
  const tries = new Map<string, number>();
  const fetch = async (_url: string, init?: RequestInit) => {
    const calls = JSON.parse(String(init!.body)) as Req[];
    seen.push(calls);
    const out = calls.map((c) => {
      const key = JSON.stringify([c.method, c.params]);
      const n = tries.get(key) ?? 0;
      tries.set(key, n + 1);
      return { jsonrpc: "2.0", id: c.id, ...answer(c, n) };
    });
    return new Response(JSON.stringify(out.reverse()), { status: 200 });
  };
  return { fetch, seen };
}

const quiet = { sleep: async () => {}, gapMs: 0 };

describe("BatchRpc", () => {
  it("splits calls into batches and keeps answers in order", async () => {
    const node = fakeNode((c) => ({ result: c.params[0] }));
    const rpc = new BatchRpc("http://node", { ...quiet, batchSize: 3, fetch: node.fetch });
    const got = await rpc.many(Array.from({ length: 7 }, (_, i) => ({ method: "eth_getBalance", params: [i] })));
    expect(got.map((a) => a.result)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(node.seen.map((b) => b.length)).toEqual([3, 3, 1]);
  });

  it("retries only the calls the node asked to slow down", async () => {
    const node = fakeNode((c, n) => (c.params[0] === 1 && n === 0 ? { error: { code: -32017, message: "Rate Limit Exceeded" } } : { result: "ok" }));
    const rpc = new BatchRpc("http://node", { ...quiet, fetch: node.fetch });
    const got = await rpc.many([0, 1, 2].map((i) => ({ method: "eth_getBalance", params: [i] })));
    expect(got.every((a) => a.result === "ok")).toBe(true);
    expect(node.seen.map((b) => b.length)).toEqual([3, 1]);
  });

  it("returns a too-many-logs answer at once instead of waiting (same code as slow down, seen live)", async () => {
    const tooMany = { code: -32005, message: "logs count limit exceeded (10000) consider refine/narrow down your query" };
    const node = fakeNode(() => ({ error: tooMany }));
    const rpc = new BatchRpc("http://node", { ...quiet, fetch: node.fetch });
    const [a] = await rpc.many([{ method: "eth_getLogs", params: [{}] }]);
    expect(a!.error).toEqual(tooMany);
    expect(node.seen).toHaveLength(1);
  });

  it("returns other errors in place, and call() throws them", async () => {
    const node = fakeNode((c) => (c.params[0] === 1 ? { error: { code: -32000, message: "execution reverted" } } : { result: 7 }));
    const rpc = new BatchRpc("http://node", { ...quiet, fetch: node.fetch });
    const got = await rpc.many([0, 1].map((i) => ({ method: "eth_call", params: [i] })));
    expect(got[0]!.result).toBe(7);
    expect(got[1]!.error?.message).toBe("execution reverted");
    await expect(rpc.call("eth_call", [1])).rejects.toBeInstanceOf(RpcError);
  });

  it("refuses anything that is not a read", async () => {
    const rpc = new BatchRpc("http://node", { ...quiet, fetch: fakeNode(() => ({ result: null })).fetch });
    await expect(rpc.many([{ method: "eth_sendRawTransaction", params: ["0x"] }])).rejects.toThrow(/not a read method/);
  });
});
