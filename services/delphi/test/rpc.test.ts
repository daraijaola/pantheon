import { afterEach, describe, expect, it, vi } from "vitest";
import { BatchRpc, PUBLIC_RPC, RpcError } from "../src/rpc.ts";

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
afterEach(() => vi.unstubAllEnvs());

describe("BatchRpc", () => {
  it("does not send empty batches", async () => {
    const node = fakeNode(() => ({ result: null }));
    expect(await new BatchRpc("http://empty", { ...quiet, fetch: node.fetch }).many([])).toEqual([]);
    expect(node.seen).toEqual([]);
  });
  it("uses the configured heavy endpoint for every default reader, falling back to the public RPC", () => {
    vi.stubEnv("DELPHI_HEAVY_RPC", "");
    vi.stubEnv("ELYSIUM_RPC", "");
    expect(new BatchRpc().url).toBe(PUBLIC_RPC);
    vi.stubEnv("ELYSIUM_RPC", "https://public.example/rpc");
    expect(new BatchRpc().url).toBe("https://public.example/rpc");
    vi.stubEnv("DELPHI_HEAVY_RPC", "https://archive.example/rpc");
    expect(new BatchRpc().url).toBe("https://archive.example/rpc");
    expect(new BatchRpc("https://explicit.example/rpc").url).toBe("https://explicit.example/rpc");
  });

  it("limits default batches to ten metered calls", async () => {
    const node = fakeNode(() => ({ result: "ok" }));
    await new BatchRpc("http://batch-size", { ...quiet, fetch: node.fetch }).many(Array.from({ length: 21 }, () => ({ method: "eth_blockNumber", params: [] })));
    expect(node.seen.map((r) => r.length)).toEqual([10, 10, 1]);
  });

  it("shares pacing across heavy consumers using the same endpoint", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    try {
      const sleep = vi.fn(async () => {});
      const fetch = fakeNode(() => ({ result: "ok" })).fetch;
      await new BatchRpc("http://shared-pacing", { fetch, sleep }).call("eth_blockNumber", []);
      await new BatchRpc("http://shared-pacing", { fetch, sleep }).call("eth_blockNumber", []);
      expect(sleep).toHaveBeenCalledWith(1000);
    } finally { vi.restoreAllMocks(); }
  });

  it("preserves provider errors on HTTP failures, including non-JSON errors", async () => {
    const message = "Method not allowed: eth_getLogs";
    const rpc = new BatchRpc("http://denied", { ...quiet, fetch: async () => new Response(JSON.stringify({ error: { code: -32601, message } }), { status: 403 }) });
    await expect(rpc.call("eth_getLogs", [{}])).rejects.toMatchObject({ code: -32601, message: expect.stringContaining(message) });
    const text = new BatchRpc("http://bad-gateway", { ...quiet, retries: 0, fetch: async () => new Response("upstream\nfailed", { status: 502 }) });
    await expect(text.call("eth_blockNumber", [])).rejects.toThrow("HTTP 502: upstream failed");
  });

  it("honors Retry-After and retries transient HTTP errors", async () => {
    let sent = 0;
    const node = fakeNode(() => ({ result: "ok" }));
    const sleep = vi.fn(async () => {});
    const rpc = new BatchRpc("http://retry-after", { ...quiet, sleep, fetch: async (url, init) => sent++ === 0 ? new Response("rate limited", { status: 429, headers: { "retry-after": "7" } }) : node.fetch(url, init) });
    expect(await rpc.call("eth_blockNumber", [])).toBe("ok");
    expect(sleep).toHaveBeenCalledWith(7000);
  });
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

  it("asks again when a lagging node hasn't seen the latest block (seen live)", async () => {
    const node = fakeNode((_c, n) => (n === 0 ? { error: { code: -32000, message: "header not found" } } : { result: "0x" }));
    const rpc = new BatchRpc("http://node", { ...quiet, fetch: node.fetch });
    expect(await rpc.call("eth_getCode", ["0x01", "latest"])).toBe("0x");
  });

  it("returns other errors in place, and call() throws them", async () => {
    const node = fakeNode((c) => (c.params[0] === 1 ? { error: { code: -32000, message: "execution reverted" } } : { result: 7 }));
    const rpc = new BatchRpc("http://node", { ...quiet, fetch: node.fetch });
    const got = await rpc.many([0, 1].map((i) => ({ method: "eth_call", params: [i] })));
    expect(got[0]!.result).toBe(7);
    expect(got[1]!.error?.message).toBe("execution reverted");
    await expect(rpc.call("eth_call", [1])).rejects.toBeInstanceOf(RpcError);
  });

  it("asks again when the connection breaks while the answer is being read", async () => {
    let sent = 0;
    const fetch = async (_url: string, init?: RequestInit) => {
      const calls = JSON.parse(String(init!.body)) as Req[];
      if (sent++ === 0) {
        // The headers arrive, then the stream is reset (seen live: NGHTTP2_INTERNAL_ERROR).
        const broken = new ReadableStream({ pull: (c) => c.error(new TypeError("terminated")) });
        return new Response(broken, { status: 200 });
      }
      return new Response(JSON.stringify(calls.map((c) => ({ jsonrpc: "2.0", id: c.id, result: "ok" }))), { status: 200 });
    };
    const rpc = new BatchRpc("http://node", { ...quiet, fetch });
    expect(await rpc.call("eth_blockNumber", [])).toBe("ok");
    expect(sent).toBe(2);
  });

  it("refuses anything that is not a read", async () => {
    const rpc = new BatchRpc("http://node", { ...quiet, fetch: fakeNode(() => ({ result: null })).fetch });
    await expect(rpc.many([{ method: "eth_sendRawTransaction", params: ["0x"] }])).rejects.toThrow(/not a read method/);
  });
});
