import { ContractFunctionExecutionError, ContractFunctionRevertedError, HttpRequestError, parseAbi, type BaseError } from "viem";
import { describe, expect, it } from "vitest";
import { isRevert, mapLimit, politeFetch } from "../src/chain.ts";
import { Store } from "../src/store.ts";

const log = (block: bigint, logIndex: number) => ({
  block,
  logIndex,
  tx: `0x${"ab".repeat(32)}` as const,
  address: "0xE2f6254508DEB93Da081837F545e0bAF7b00d8E9" as const,
  topics: [`0x${"01".repeat(32)}` as const],
  data: "0x" as const,
});

describe("Store", () => {
  it("resumes each stream where it stopped, and returns logs in chain order", () => {
    const s = new Store(":memory:");
    expect(s.cursor("swap", 100n)).toBe(100n);
    s.saveLogs("swap", [log(150n, 2), log(120n, 0), log(150n, 1)], 200n);
    expect(s.cursor("swap", 100n)).toBe(200n);
    expect(s.cursor("other", 7n)).toBe(7n);
    expect(s.logs("swap").map((l) => [l.block, l.logIndex])).toEqual([[120n, 0], [150n, 1], [150n, 2]]);
    s.saveLogs("swap", [log(150n, 1)], 300n); // a re-fetched log is not duplicated
    expect(s.logs("swap")).toHaveLength(3);
    s.close();
  });

  it("trims a moving window: drops old logs, and jumps a cursor that fell behind", () => {
    const s = new Store(":memory:");
    s.saveLogs("recent", [log(100n, 0), log(150n, 0), log(190n, 0)], 200n);
    expect(s.countLogs("recent")).toBe(3);
    s.trimLogs("recent", 150n);
    expect(s.logs("recent").map((l) => l.block)).toEqual([150n, 190n]);
    expect(s.cursor("recent", 0n)).toBe(200n); // still ahead: kept
    s.trimLogs("recent", 500n);
    expect(s.logs("recent")).toEqual([]);
    expect(s.cursor("recent", 0n)).toBe(500n); // the gap before 500 is never read
    expect(s.countLogs("recent")).toBe(0);
    s.trimLogs("fresh", 70n);
    expect(s.cursor("fresh", 0n)).toBe(70n);
    s.close();
  });

  it("remembers and recalls many answers at once", () => {
    const s = new Store(":memory:");
    const keys = Array.from({ length: 1_200 }, (_, i) => `0xAB${i}`);
    s.rememberMany("txfrom", keys.map((k, i) => [k, i] as const));
    const got = s.recallMany<number>("txfrom", [...keys, "0xnothing"]);
    expect(got.size).toBe(1_200);
    expect(got.get("0xab7")).toBe(7);
    expect(s.recall("txfrom", "0xAB1199")).toBe(1_199);
    s.close();
  });

  it("remembers answers, case-insensitively, and forgets them after their age limit", () => {
    const s = new Store(":memory:");
    s.remember("kind", "0xABC", { a: 1 }, 1_000_000);
    expect(s.recall("kind", "0xabc")).toEqual({ a: 1 });
    expect(s.recall("kind", "0xabc", 60, 1_000_000 + 59_000)).toEqual({ a: 1 });
    expect(s.recall("kind", "0xabc", 60, 1_000_000 + 61_000)).toBeUndefined();
    expect(s.recall("other", "0xabc")).toBeUndefined();
    s.close();
  });
});

describe("isRevert", () => {
  const abi = parseAbi(["function token0() view returns (address)"]);
  const wrap = (cause: BaseError) =>
    new ContractFunctionExecutionError(cause, { abi, functionName: "token0", contractAddress: "0x0000000000000000000000000000000000000001" });

  it("is true when the contract said no", () => {
    expect(isRevert(wrap(new ContractFunctionRevertedError({ abi, functionName: "token0" })))).toBe(true);
  });

  it("is false for an outage, so it is never remembered as an answer", () => {
    expect(isRevert(wrap(new HttpRequestError({ url: "https://rpc.test", status: 429 })))).toBe(false);
    expect(isRevert(new Error("socket hang up"))).toBe(false);
  });
});

describe("mapLimit", () => {
  it("keeps order and never runs more than the limit at once", async () => {
    let running = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 4, 2, 3], 2, async (n) => {
      peak = Math.max(peak, ++running);
      await new Promise((r) => setTimeout(r, n));
      running--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30]);
    expect(peak).toBe(2);
  });
});

describe("politeFetch", () => {
  const rpcError = (code: number) => JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code, message: "Rate Limit Exceeded. Please get an api key" } });

  it("waits and retries when the RPC says to slow down (Conduit's -32017), then passes the answer on", async () => {
    const answers = [rpcError(-32017), rpcError(-32017), JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" })];
    const waits: number[] = [];
    const f = politeFetch({ minGapMs: 0, fetch: async () => new Response(answers.shift()!), sleep: async () => {}, onWait: (ms) => waits.push(ms) });
    const res = await f("https://rpc.test", { method: "POST" });
    expect(await res.json()).toEqual({ jsonrpc: "2.0", id: 1, result: "0x1" });
    expect(waits).toEqual([2_000, 4_000]);
  });

  it("spots a rate limit inside a batch, and on HTTP 429", async () => {
    const answers = [
      new Response(JSON.stringify([{ id: 1, result: "0x1" }, { id: 2, error: { code: -32005, message: "limit" } }])),
      new Response("too many", { status: 429 }),
      new Response("[]"),
    ];
    let n = 0;
    const f = politeFetch({ minGapMs: 0, fetch: async () => (n++, answers.shift()!), sleep: async () => {} });
    await f("https://rpc.test");
    expect(n).toBe(3);
  });

  it("does not retry ordinary errors, and gives up after its retries", async () => {
    let n = 0;
    const revert = JSON.stringify({ id: 1, error: { code: 3, message: "execution reverted" } });
    const f = politeFetch({ minGapMs: 0, retries: 2, fetch: async () => (n++, new Response(n > 1 ? rpcError(-32017) : revert)), sleep: async () => {} });
    expect(await (await f("https://rpc.test")).text()).toBe(revert);
    n = 1;
    expect(await (await f("https://rpc.test")).text()).toContain("Rate Limit");
    expect(n).toBe(4);
  });
});
