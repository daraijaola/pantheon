import { readFileSync } from "node:fs";
import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";
import { effectsOf, politeFetch } from "../src/chain.ts";
import { DEP } from "./fakes.ts";

// Micheal's first real keep on Elysium testnet (Oct 14): the router's run, then the basket's rebalance.
type Fx = { txs: Record<"run" | "rebalance", { hash: Hex; logs: Array<{ address: Address; topics: Hex[]; data: Hex }> }> };
const fx = JSON.parse(readFileSync(new URL("./fixtures/first-keep.json", import.meta.url), "utf8")) as Fx;
const ours = { router: DEP.pnthRouter, vault: DEP.indexVault, staking: DEP.staking };

describe("effectsOf on real receipts", () => {
  it("reads the run: PNTH's fee half burned, its USDC half sent to the basket", () => {
    const e = effectsOf(fx.txs.run.logs, ours);
    expect(e.run).toEqual({ newToken: 49_999_999_999_999_999_999_999n, newQuote: 4_999_999n });
    expect(e.legs).toEqual([
      { side: "token", job: "BURN", to: DEP.burnSink, amount: 49_999_999_999_999_999_999_999n },
      { side: "quote", job: "INDEX", to: DEP.indexVault, amount: 4_999_999n },
    ]);
    expect(e.deferred).toEqual([]);
  });

  it("reads the rebalance: no basket list yet, so the USDC streams to stakers", () => {
    const e = effectsOf(fx.txs.rebalance.logs, ours);
    expect(e.streamed).toEqual([{ token: DEP.usdc, amount: 4_999_999n }]);
    expect(e.buys).toEqual([]);
  });

  it("ignores Ascend's, the pool manager's and the tokens' own events", () => {
    const e = effectsOf(fx.txs.run.logs, { router: "0x0000000000000000000000000000000000000001", vault: DEP.indexVault, staking: DEP.staking });
    expect(e.legs).toEqual([]);
    expect(e.run).toBeUndefined();
  });
});

describe("politeFetch", () => {
  it("waits and retries on the public RPC's rate limit (-32017), then passes the answer on", async () => {
    const limited = JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32017, message: "Rate Limit Exceeded" } });
    const answers = [limited, JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" })];
    const waits: number[] = [];
    const f = politeFetch({ minGapMs: 0, fetch: async () => new Response(answers.shift()!), sleep: async (ms) => void waits.push(ms) });
    expect(await (await f("https://rpc.test")).json()).toMatchObject({ result: "0x1" });
    expect(waits).toEqual([2_000]);
  });

  it("does not retry an ordinary error", async () => {
    let n = 0;
    const revert = JSON.stringify({ id: 1, error: { code: 3, message: "execution reverted" } });
    const f = politeFetch({ minGapMs: 0, fetch: async () => (n++, new Response(revert)), sleep: async () => {} });
    expect(await (await f("https://rpc.test")).text()).toBe(revert);
    expect(n).toBe(1);
  });
});
