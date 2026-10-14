import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PublicClient } from "viem";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.ts";
import { cleanSymbol, Indexer, loadSaved, save } from "../src/indexer.ts";
import { DEP, LIVE_LOGS } from "./fixtures.ts";

const cfg = loadConfig({ FROM_BLOCK: "9144000" }, () => JSON.stringify({ chainId: 99_801, ...DEP, passportRegistry: DEP.staking }));

/** A fake viem client serving the real Oct 14 logs and fixed current values; it records every call. */
function fakeClient(head: bigint) {
  const calls = { getLogs: [] as Array<{ fromBlock: bigint; toBlock: bigint }>, getBlock: 0 };
  const client = {
    getBlockNumber: async () => head,
    getLogs: async (q: { fromBlock: bigint; toBlock: bigint }) => {
      calls.getLogs.push(q);
      return LIVE_LOGS.filter((l) => l.blockNumber >= q.fromBlock && l.blockNumber <= q.toBlock);
    },
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => (calls.getBlock++, { timestamp: 1_792_000_000n + blockNumber }),
    multicall: async ({ contracts, allowFailure }: { contracts: Array<{ functionName: string }>; allowFailure: boolean }) => {
      const answer: Record<string, unknown> = {
        totalSupply: 10n ** 27n, balanceOf: 5n, totalStaked: 7n, totalWorking: 7n, rewardTokens: [DEP.usdc], activeId: 0n, proposalCount: 0n,
        symbol: "COIN‮\u0000", decimals: 18,
      };
      return contracts.map((c) => (allowFailure ? { status: "success", result: answer[c.functionName] } : answer[c.functionName]));
    },
  };
  return { client: client as unknown as PublicClient, calls };
}

describe("Indexer.poll", () => {
  it("reads every event once, with its block time, and moves its cursor", async () => {
    const { client, calls } = fakeClient(9_150_000n);
    const ix = new Indexer(client, cfg, loadSaved("/nonexistent/x.json", cfg.fromBlock));
    expect(await ix.poll()).toBe(7);
    expect(ix.saved.records.map((r) => r.kind)).toEqual(["proposed", "stake", "burn", "to-basket", "run", "reward", "stream"]);
    expect(ix.saved.records[0]!.at).toBe(1_792_000_000 + ix.saved.records[0]!.block);
    expect(ix.saved.cursor).toBe("9150001");
    expect(ix.live).toMatchObject({ block: "9150000", totalStaked: "7", burnSink: "5", proposals: [] });

    // Next poll: nothing new, no re-reading of old blocks, no duplicate records.
    const before = calls.getBlock;
    const logReads = calls.getLogs.length;
    expect(await ix.poll()).toBe(0);
    expect(calls.getLogs).toHaveLength(logReads); // no new blocks: no log request at all
    expect(ix.saved.records).toHaveLength(7);
    expect(calls.getBlock).toBe(before);
  });

  it("reads long ranges in chunks the RPC accepts", async () => {
    const { client, calls } = fakeClient(cfg.fromBlock + 1_200_000n);
    await new Indexer(client, cfg, loadSaved("/nonexistent/x.json", cfg.fromBlock)).poll();
    expect(calls.getLogs.map((q) => Number(q.toBlock - q.fromBlock + 1n))).toEqual([500_000, 500_000, 200_001]);
  });

  it("keeps coin symbols short and printable (creators choose them)", async () => {
    expect(cleanSymbol("COIN‮\u0000")).toBe("COIN");
    expect(cleanSymbol("x".repeat(40))).toHaveLength(16);
    expect(cleanSymbol("\u0007")).toBe("?");
  });
});

describe("saved state", () => {
  const dir = mkdtempSync(join(tmpdir(), "indexer-"));
  it("round-trips, and refuses a damaged file instead of starting over silently", () => {
    const p = join(dir, "sub", "index.json");
    const s = loadSaved(p, 5n);
    expect(s).toEqual({ version: 1, cursor: "5", records: [], blockTimes: {} });
    save(p, { ...s, cursor: "9" });
    expect(loadSaved(p, 0n).cursor).toBe("9");
    writeFileSync(p, JSON.stringify({ version: 2 }));
    expect(() => loadSaved(p, 0n)).toThrow(/damaged/);
  });
});

describe("loadConfig", () => {
  it("defaults to port 8789 (8787 is Passport, 8788 Micheal's dev Passport)", () => {
    expect(cfg).toMatchObject({ port: 8789, pollSec: 30 });
  });
  it("stops at start on a bad value", () => {
    expect(() => loadConfig({ PORT: "80" }, () => "{}")).toThrow(ConfigError);
    expect(() => loadConfig({}, () => JSON.stringify({ chainId: 1 }))).toThrow(/bad deployment file/);
  });
});
