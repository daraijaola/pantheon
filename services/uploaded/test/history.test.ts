// A wallet's history, with stand-ins for the chain: no network.
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/api.ts";
import { chainHistory, firstActiveBlock, HistoryReader, type HistoryCalls } from "../src/history.ts";
import { Verdicts } from "../src/verdicts.ts";

const FIXTURE = new URL("./fixtures/scan.json", import.meta.url).pathname;
const WALLET = "0x79a320a02db0c1cbe7a5f2cd47210ea6f3b9f23a";

/** A chain where the wallet became active at this block (null: never). */
function chain(firstActive: bigint | null, now = { hype: 0n, txsSent: 0 }, head = 20_000_000n) {
  const asked = { rounds: 0, blocks: 0, heads: 0 };
  const calls: HistoryCalls = {
    head: async () => (asked.heads++, head),
    activeAt: async (_w, blocks) => {
      asked.rounds += 1;
      asked.blocks += blocks.length;
      return blocks.map((b) => firstActive !== null && b >= firstActive);
    },
    blockTime: async (b) => 1_700_000_000 + Number(b),
    now: async () => now,
  };
  return { calls, asked };
}
function loaded() {
  const v = new Verdicts(FIXTURE);
  v.refresh();
  return v;
}

describe("finding a wallet's first block", () => {
  it("lands on the exact block, wherever it is", async () => {
    const head = 20_000_000n;
    const cases = [0n, 1n, 2n, 16n, 17n, 18n, 1_234_567n, head - 2n, head - 1n, head];
    for (let i = 0; i < 40; i++) cases.push(BigInt(Math.floor(Math.random() * 20_000_000)));
    for (const first of cases) expect(await firstActiveBlock(chain(first).calls, WALLET, head), String(first)).toBe(first);
  });

  it("works on a very short chain", async () => {
    expect(await firstActiveBlock(chain(0n).calls, WALLET, 0n)).toBe(0n);
    expect(await firstActiveBlock(chain(0n).calls, WALLET, 1n)).toBe(0n);
    expect(await firstActiveBlock(chain(1n).calls, WALLET, 1n)).toBe(1n);
    expect(await firstActiveBlock(chain(3n).calls, WALLET, 5n)).toBe(3n);
  });

  it("takes few requests: 20 million blocks in about 6 rounds", async () => {
    const { calls, asked } = chain(12_345_678n);
    await firstActiveBlock(calls, WALLET, 20_000_000n);
    expect(asked.rounds).toBeLessThanOrEqual(7);
    expect(asked.blocks).toBeLessThanOrEqual(7 * 16);
  });
});

describe("reading a wallet's history", () => {
  it("gives its first day, its activity, and that it's testnet", async () => {
    const { calls } = chain(5_000n, { hype: 1_500_000_000_000_000_000n, txsSent: 42 });
    const got = await new HistoryReader(loaded(), calls).read(WALLET);
    expect(got).toMatchObject({ wallet: WALLET, network: "testnet", txsSent: 42, hype: "1.5", firstSeen: { block: "5000", time: new Date((1_700_000_000 + 5_000) * 1000).toISOString() } });
  });

  it("has no first day for a wallet that never did anything, and doesn't search for one", async () => {
    const { calls, asked } = chain(null);
    const got = await new HistoryReader(loaded(), calls).read(WALLET);
    expect(got.firstSeen).toBeNull();
    expect(asked.rounds).toBe(0);
  });

  it("finds a wallet that has only sent, with no HYPE left", async () => {
    const got = await new HistoryReader(loaded(), chain(9n, { hype: 0n, txsSent: 3 }).calls).read(WALLET);
    expect(got.firstSeen?.block).toBe("9");
  });

  it("lists the coins it launched with their verdicts, and a creator's address in any case works", async () => {
    const v = loaded();
    const pact = v.coins()!.coins.find((c) => c.symbol === "PACT")!;
    const creator = (v.get(pact.token) as { creator: string }).creator;
    const got = await new HistoryReader(v, chain(1n, { hype: 1n, txsSent: 1 }).calls).read(creator.toUpperCase().replace("0X", "0x"));
    expect(got.coinsLaunched).toEqual([{ token: pact.token, symbol: "PACT", venue: "ascend", verdict: "CLEAN", reason: "Clean so far: every check passed.", disputeUrl: `https://pantheonindex.com/delphi/dispute?token=${pact.token}` }]);
  });

  it("gives no funder, on purpose", async () => {
    const got = await new HistoryReader(loaded(), chain(5n, { hype: 1n, txsSent: 1 }).calls).read(WALLET);
    expect(JSON.stringify(got)).not.toMatch(/fund/i);
  });

  it("refuses to answer before DELPHI's coins are loaded, so coins launched can't look empty", async () => {
    const { calls, asked } = chain(1n);
    await expect(new HistoryReader(new Verdicts("/nowhere"), calls).read(WALLET)).rejects.toThrow("no coins loaded");
    expect(asked.heads).toBe(0);
  });

  it("searches once ever for a first day, but keeps its activity up to date", async () => {
    let t = 0;
    let txsSent = 1;
    const base = chain(7n);
    const calls: HistoryCalls = { ...base.calls, now: async () => ({ hype: 1n, txsSent }) };
    const r = new HistoryReader(loaded(), calls, { now: () => t });
    await r.read(WALLET);
    const rounds = base.asked.rounds;
    txsSent = 2;
    expect((await r.read(WALLET)).txsSent).toBe(1); // remembered for a minute
    t = 60_000;
    const later = await r.read(WALLET);
    expect(later.txsSent).toBe(2);
    expect(later.firstSeen?.block).toBe("7");
    expect(base.asked.rounds).toBe(rounds);
  });

  it("looks again for a wallet that had no first day: it may have started since", async () => {
    let t = 0;
    let now = { hype: 0n, txsSent: 0 };
    const base = chain(11n);
    const calls: HistoryCalls = { ...base.calls, now: async () => now };
    const r = new HistoryReader(loaded(), calls, { now: () => t });
    expect((await r.read(WALLET)).firstSeen).toBeNull();
    now = { hype: 5n, txsSent: 0 };
    t = 60_000;
    expect((await r.read(WALLET)).firstSeen?.block).toBe("11");
  });

  it("fails out loud when the chain fails, and remembers nothing", async () => {
    let down = true;
    const { calls } = chain(3n, { hype: 1n, txsSent: 1 });
    const flaky: HistoryCalls = { ...calls, activeAt: (w, b) => (down ? Promise.reject(new Error("no archive")) : calls.activeAt(w, b)) };
    const r = new HistoryReader(loaded(), flaky);
    await expect(r.read(WALLET)).rejects.toThrow("no archive");
    down = false;
    expect((await r.read(WALLET)).firstSeen?.block).toBe("3");
  });
});

describe("the chain reads", () => {
  it("counts a wallet as active by its HYPE or by what it sent, at each block asked", async () => {
    const client = {
      getBalance: async ({ blockNumber }: { blockNumber: bigint }) => (blockNumber >= 10n ? 1n : 0n),
      getTransactionCount: async ({ blockNumber }: { blockNumber: bigint }) => (blockNumber === 5n ? 1 : 0),
    };
    expect(await chainHistory(client as never).activeAt(WALLET, [1n, 5n, 10n])).toEqual([false, true, true]);
  });
});

describe("asking the server", () => {
  const app = (calls: HistoryCalls) => buildApp(loaded(), { history: new HistoryReader(loaded(), calls) });

  it("answers with the wallet's history", async () => {
    const res = await app(chain(5n, { hype: 1n, txsSent: 2 }).calls).inject({ url: `/wallets/${WALLET}/history` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ txsSent: 2, firstSeen: { block: "5" } });
  });

  it("refuses a bad address, and answers 503 when the chain fails", async () => {
    const { calls } = chain(5n);
    expect((await app(calls).inject({ url: "/wallets/nope/history" })).statusCode).toBe(400);
    const down = await app({ ...calls, now: () => Promise.reject(new Error("rpc detail")) }).inject({ url: `/wallets/${WALLET}/history` });
    expect(down.statusCode).toBe(503);
    expect(down.json()).toEqual({ error: "CHAIN_UNAVAILABLE" });
  });
});
