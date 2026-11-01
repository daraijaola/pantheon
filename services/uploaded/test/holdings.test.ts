// The holdings reader, with stand-ins for the chain: no network.
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/api.ts";
import { chainBalances, HoldingsReader, NotReady, type BalanceCalls } from "../src/holdings.ts";
import { Verdicts, type Coin } from "../src/verdicts.ts";

const FIXTURE = new URL("./fixtures/scan.json", import.meta.url).pathname;
const WALLET = "0x79a320a02db0c1cbe7a5f2cd47210ea6f3b9f23a";
const WALLET2 = "0x7a988b8fa5d66de4950ee5f94c55c7820b6e562f";
const A: Coin = { token: "0x" + "a".repeat(40), symbol: "AAA", name: "Aye", venue: "ascend" };
const K: Coin = { token: "0x" + "b".repeat(40), symbol: "KKK", name: "Kay", venue: "kalos" };
const P: Coin = { token: "0x" + "c".repeat(40), symbol: "PPP", name: null, venue: "perpme" };
const COINS = [A, K, P];
const known = () => ({ network: "testnet" as const, coins: COINS });

/** A chain that holds these balances, and counts how often it's asked. */
function chain(balances: Record<string, bigint | null>, decimals: Record<string, number | null> = {}) {
  const asked = { balances: 0, decimals: [] as string[][] };
  const calls: BalanceCalls = {
    balances: async (_w, tokens) => {
      asked.balances += 1;
      return tokens.map((t) => (t in balances ? balances[t]! : 0n));
    },
    decimals: async (tokens) => {
      asked.decimals.push([...tokens]);
      return tokens.map((t) => (t in decimals ? decimals[t]! : 18));
    },
  };
  return { calls, asked };
}

describe("reading a wallet", () => {
  it("lists only the coins it holds, with the amount a person reads, and where each lives", async () => {
    const { calls } = chain({ [A.token]: 1_500_000_000_000_000_000n, [P.token]: 7n });
    const got = await new HoldingsReader(known, calls).read(WALLET);
    expect(got).toMatchObject({ wallet: WALLET, network: "testnet", coinsChecked: 3, unread: [] });
    expect(got.holdings).toEqual([
      { ...A, balance: "1500000000000000000", decimals: 18, amount: "1.5" },
      { ...P, balance: "7", decimals: 18, amount: "0.000000000000000007" },
    ]);
  });

  it("uses each coin's own decimals (stKALOS has 24)", async () => {
    const { calls } = chain({ [K.token]: 2_000_000_000_000_000_000_000_000n }, { [K.token]: 24 });
    expect((await new HoldingsReader(known, calls).read(WALLET)).holdings[0]).toMatchObject({ decimals: 24, amount: "2" });
  });

  it("gives an empty list only when every coin was read and none is held", async () => {
    const got = await new HoldingsReader(known, chain({}).calls).read(WALLET);
    expect(got).toMatchObject({ holdings: [], unread: [], coinsChecked: 3 });
  });

  it("says a coin couldn't be read, instead of calling it not held", async () => {
    const got = await new HoldingsReader(known, chain({ [A.token]: null, [K.token]: 5n }).calls).read(WALLET);
    expect(got.unread).toEqual([A.token]);
    expect(got.holdings.map((h) => h.token)).toEqual([K.token]);
  });

  it("puts a held coin with unreadable decimals in unread, not a made-up amount", async () => {
    const got = await new HoldingsReader(known, chain({ [K.token]: 5n }, { [K.token]: null }).calls).read(WALLET);
    expect(got.holdings).toEqual([]);
    expect(got.unread).toEqual([K.token]);
  });

  it("refuses to answer before DELPHI's coins are loaded, and asks the chain nothing", async () => {
    const { calls, asked } = chain({});
    await expect(new HoldingsReader(() => null, calls).read(WALLET)).rejects.toThrow(NotReady);
    expect(asked.balances).toBe(0);
  });
});

describe("going easy on the chain", () => {
  it("remembers a wallet for 30 seconds, however its address is written", async () => {
    let t = 0;
    const { calls, asked } = chain({});
    const r = new HoldingsReader(known, calls, { now: () => t });
    await r.read(WALLET);
    await r.read(WALLET.toUpperCase().replace("0X", "0x"));
    t = 29_999;
    await r.read(WALLET);
    expect(asked.balances).toBe(1);
    t = 30_000;
    await r.read(WALLET);
    expect(asked.balances).toBe(2);
  });

  it("does one read when the same wallet is asked twice at once", async () => {
    const { calls, asked } = chain({});
    const r = new HoldingsReader(known, calls);
    const [a, b] = await Promise.all([r.read(WALLET), r.read(WALLET)]);
    expect(a).toEqual(b);
    expect(asked.balances).toBe(1);
  });

  it("reads one wallet at a time", async () => {
    let running = 0;
    let most = 0;
    const calls: BalanceCalls = {
      balances: async (_w, tokens) => {
        most = Math.max(most, ++running);
        await new Promise((res) => setTimeout(res, 5));
        running -= 1;
        return tokens.map(() => 0n);
      },
      decimals: async (t) => t.map(() => 18),
    };
    const r = new HoldingsReader(known, calls);
    await Promise.all([r.read(WALLET), r.read(WALLET2), r.read(A.token)]);
    expect(most).toBe(1);
  });

  it("asks a coin's decimals once, ever", async () => {
    const { calls, asked } = chain({ [A.token]: 5n, [K.token]: 5n });
    const r = new HoldingsReader(known, calls);
    await r.read(WALLET);
    await r.read(WALLET2);
    expect(asked.decimals).toEqual([[A.token, K.token]]);
  });

  it("doesn't remember a failure, and one wallet failing doesn't stop the next", async () => {
    let fail = true;
    const { calls } = chain({ [A.token]: 5n });
    const flaky: BalanceCalls = {
      ...calls,
      balances: (w, t) => (fail ? Promise.reject(new Error("node down")) : calls.balances(w, t)),
    };
    const r = new HoldingsReader(known, flaky);
    await expect(r.read(WALLET)).rejects.toThrow("node down");
    fail = false;
    expect((await r.read(WALLET2)).holdings).toHaveLength(1);
    expect((await r.read(WALLET)).holdings).toHaveLength(1);
  });
});

describe("the bundled chain reads", () => {
  const tokens = Array.from({ length: 1_250 }, (_, i) => `0x${String(i).padStart(40, "0")}`);

  it("splits a long list, keeps the order, and passes the wallet", async () => {
    const sizes: number[] = [];
    const client = {
      multicall: async ({ contracts, batchSize }: { contracts: Array<{ address: string; functionName: string; args?: unknown[] }>; batchSize: number }) => {
        sizes.push(contracts.length);
        expect(batchSize).toBe(0); // or viem splits each bundle into many small requests
        expect(contracts[0]).toMatchObject({ functionName: "balanceOf", args: [WALLET] });
        return contracts.map((c) => ({ status: "success", result: BigInt(c.address) }));
      },
    };
    const got = await chainBalances(client as never).balances(WALLET, tokens);
    expect(sizes).toEqual([500, 500, 250]);
    expect(got).toEqual(tokens.map((t) => BigInt(t)));
  });

  it("turns one coin's failure into null, and asks decimals with no wallet", async () => {
    const client = {
      multicall: async ({ contracts }: { contracts: Array<{ functionName: string; args?: unknown[] }> }) => {
        expect(contracts[0]).toMatchObject({ functionName: "decimals" });
        expect(contracts[0]!.args).toBeUndefined();
        return [{ status: "failure", error: new Error("reverted") }, { status: "success", result: 24 }];
      },
    };
    expect(await chainBalances(client as never).decimals([A.token, K.token])).toEqual([null, 24]);
  });

  it("lets a failed request throw, so it can't look like an empty wallet", async () => {
    const client = { multicall: () => Promise.reject(new Error("node down")) };
    await expect(chainBalances(client as never).balances(WALLET, [A.token])).rejects.toThrow("node down");
  });
});

describe("asking the server", () => {
  function app(calls: BalanceCalls, coins: () => ReturnType<typeof known> | null = known) {
    const v = new Verdicts(FIXTURE);
    v.refresh();
    return buildApp(v, { holdings: new HoldingsReader(coins, calls) });
  }

  it("answers with the wallet's coins", async () => {
    const res = await app(chain({ [A.token]: 10n ** 18n }).calls).inject({ url: `/wallets/${WALLET}/holdings` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json().holdings[0]).toMatchObject({ symbol: "AAA", amount: "1" });
  });

  it("refuses anything that isn't an address", async () => {
    const res = await app(chain({}).calls).inject({ url: "/wallets/nope/holdings" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "INVALID_ADDRESS" });
  });

  it("answers 503 when the chain fails, never an empty list, and doesn't say why", async () => {
    const down: BalanceCalls = { balances: () => Promise.reject(new Error("rpc secret detail")), decimals: async () => [] };
    const res = await app(down).inject({ url: `/wallets/${WALLET}/holdings` });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "CHAIN_UNAVAILABLE" });
  });

  it("answers 503 until DELPHI's coins are loaded", async () => {
    const res = await app(chain({}).calls, () => null).inject({ url: `/wallets/${WALLET}/holdings` });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "NOT_READY" });
  });
});
