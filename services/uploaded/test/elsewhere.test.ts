// Where else a wallet has been, on stand-ins shaped like the real answers: no network.
import { describe, expect, it } from "vitest";
import { ElsewhereReader, publicCalls, type ChainInfo, type ElsewhereCalls } from "../src/elsewhere.ts";

const WALLET = "0x79a320a02db0c1cbe7a5f2cd47210ea6f3b9f23a";
const CHAINS: ChainInfo[] = [
  { chain: "Alpha", chainId: 1, symbol: "A", rpc: "http://alpha" },
  { chain: "Beta", chainId: 2, symbol: "B", rpc: "http://beta" },
];
// The fields we drop are in here on purpose, as Hyperliquid really sends them.
const HL: Record<string, unknown> = {
  clearinghouseState: {
    marginSummary: { accountValue: "90210.5", totalNtlPos: "1000", totalRawUsd: "1", totalMarginUsed: "2" },
    withdrawable: "777",
    assetPositions: [
      { type: "oneWay", position: { coin: "BTC", szi: "-0.5", leverage: { type: "cross", value: 20 }, entryPx: "60000", positionValue: "30000", unrealizedPnl: "-1234.5", returnOnEquity: "-0.1" } },
      { type: "oneWay", position: { coin: "ETH", szi: "2", entryPx: "3000", unrealizedPnl: "55" } },
      { type: "oneWay", position: { coin: "SOL", szi: "0.0" } },
    ],
  },
  spotClearinghouseState: { balances: [{ coin: "HYPE", token: 150, total: "12.5", hold: "0", entryNtl: "300" }, { coin: "USDC", token: 0, total: "0.0", hold: "0", entryNtl: "0" }] },
  delegatorSummary: { delegated: "100.0", undelegated: "0.0", totalPendingWithdrawal: "5.0", nPendingWithdrawals: 1 },
  userFills: [
    { coin: "BTC", px: "60000", sz: "0.5", side: "A", time: 1_760_000_000_000, closedPnl: "999", hash: "0x1", fee: "1" },
    { coin: "ETH", px: "3000", sz: "1", side: "B", time: 1_750_000_000_000, closedPnl: "-9", hash: "0x2", fee: "1" },
    { coin: "BTC", px: "60000", sz: "0.1", side: "A", time: 1_755_000_000_000, closedPnl: "0", hash: "0x3", fee: "1" },
  ],
};

function calls(over: Partial<ElsewhereCalls> = {}): ElsewhereCalls {
  return {
    hyperliquid: async (type) => HL[type],
    rpc: async (_url, method) => (method === "eth_getBalance" ? "0xde0b6b3a7640000" : "0x7"),
    ensName: async () => "someone.eth",
    ...over,
  };
}
const read = (c = calls()) => new ElsewhereReader(c, { chains: CHAINS }).read(WALLET);

describe("Hyperliquid", () => {
  it("gives the facts: positions, spot coins, stake and trades", async () => {
    const { hyperliquid } = await read();
    expect(hyperliquid).toEqual({
      network: "mainnet",
      openPositions: [
        { coin: "BTC", side: "short", size: "0.5", leverage: 20 },
        { coin: "ETH", side: "long", size: "2", leverage: null },
      ],
      spot: [{ coin: "HYPE", amount: "12.5" }],
      staked: { delegated: "100.0", undelegated: "0.0", pendingWithdrawal: "5.0" },
      trades: { count: 3, capped: false, coins: ["BTC", "ETH"], first: new Date(1_750_000_000_000).toISOString(), last: new Date(1_760_000_000_000).toISOString() },
    });
  });

  it("never lets a dollar value or a profit through, anywhere in the answer", async () => {
    const text = JSON.stringify(await read());
    for (const word of ["accountValue", "Pnl", "entryPx", "positionValue", "withdrawable", "entryNtl", "90210", "1234.5", "60000", "777"]) expect(text).not.toContain(word);
  });

  it("says when Hyperliquid stopped at its limit, so the first trade isn't taken as the very first", async () => {
    const fills = Array.from({ length: 2000 }, (_, i) => ({ coin: "BTC", time: 1_750_000_000_000 + i }));
    const { hyperliquid } = await read(calls({ hyperliquid: async (type) => (type === "userFills" ? fills : HL[type]) }));
    expect(hyperliquid?.trades).toMatchObject({ count: 2000, capped: true });
  });

  it("gives an empty answer for a wallet that never used it", async () => {
    const empty: Record<string, unknown> = { clearinghouseState: { assetPositions: [] }, spotClearinghouseState: { balances: [] }, delegatorSummary: { delegated: "0.0", undelegated: "0.0", totalPendingWithdrawal: "0.0" }, userFills: [] };
    const { hyperliquid, complete } = await read(calls({ hyperliquid: async (type) => empty[type] }));
    expect(hyperliquid).toMatchObject({ openPositions: [], spot: [], trades: { count: 0, first: null, last: null } });
    expect(complete).toBe(true);
  });

  it("is unread, never empty, if it fails or answers in a shape we don't know", async () => {
    for (const hyperliquid of [() => Promise.reject(new Error("down")), async () => ({ surprise: true })]) {
      const got = await read(calls({ hyperliquid }));
      expect(got.hyperliquid).toBeNull();
      expect(got.unread).toEqual(["Hyperliquid"]);
      expect(got.complete).toBe(false);
    }
  });
});

describe("other chains", () => {
  it("gives each chain's coin and transactions, marked as mainnet", async () => {
    const { chains } = await read();
    expect(chains).toEqual([
      { chain: "Alpha", chainId: 1, network: "mainnet", symbol: "A", balance: "1", txsSent: 7 },
      { chain: "Beta", chainId: 2, network: "mainnet", symbol: "B", balance: "1", txsSent: 7 },
    ]);
  });

  it("a chain that fails is unread, and the rest still come", async () => {
    const got = await read(calls({ rpc: async (url, method) => { if (url === "http://beta") throw new Error("down"); return method === "eth_getBalance" ? "0x0" : "0x0"; } }));
    expect(got.chains.map((c) => c.chain)).toEqual(["Alpha"]);
    expect(got.unread).toEqual(["Beta"]);
    expect(got.hyperliquid).not.toBeNull();
  });
});

describe("the ENS name", () => {
  it("gives the name it set, cleaned", async () => {
    expect((await read(calls({ ensName: async () => "a‮b.eth" }))).ensName).toBe("a b.eth");
  });

  it("no name isn't a failure", async () => {
    const got = await read(calls({ ensName: async () => null }));
    expect(got).toMatchObject({ ensName: null, complete: true, unread: [] });
  });

  it("a failed lookup is unread, not 'no name'", async () => {
    const got = await read(calls({ ensName: () => Promise.reject(new Error("down")) }));
    expect(got).toMatchObject({ ensName: null, complete: false, unread: ["ENS"] });
  });
});

describe("the sources", () => {
  it("every source down is an answer that says so, not a crash", async () => {
    const down = () => Promise.reject(new Error("down"));
    const logs: string[] = [];
    const got = await new ElsewhereReader({ hyperliquid: down, rpc: down, ensName: down }, { chains: CHAINS, log: (m) => logs.push(m) }).read(WALLET);
    expect(got).toMatchObject({ hyperliquid: null, chains: [], ensName: null, complete: false });
    expect(got.unread.sort()).toEqual(["Alpha", "Beta", "ENS", "Hyperliquid"]);
    expect(logs).toHaveLength(4);
  });

  it("is asked once for a burst of reads", async () => {
    let asked = 0;
    const r = new ElsewhereReader(calls({ ensName: async () => (asked++, null) }), { chains: CHAINS });
    await Promise.all([r.read(WALLET), r.read(WALLET)]);
    expect(asked).toBe(1);
  });

  it("the real sources can be set up without a key", () => {
    expect(Object.keys(publicCalls()).sort()).toEqual(["ensName", "hyperliquid", "rpc"]);
  });
});
