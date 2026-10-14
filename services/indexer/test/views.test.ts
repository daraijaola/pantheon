import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import { toRec, type Rec } from "../src/chain.ts";
import { basket, GRACE_SEC, proposalStatus, receipts, stats } from "../src/views.ts";
import { COIN, CONTRACTS, ctx, DEP, LIVE_LOGS, liveRecords } from "./fixtures.ts";

const tx = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const rec = (n: number, r: Record<string, unknown>) => ({ tx: tx(n), block: 100 + n, logIndex: 0, at: 1_000 + n, ...r }) as Rec;

describe("decoding the real Oct 14 transactions", () => {
  it("finds the proposal, the stake, the fee run's burn and basket payment, and the stream", () => {
    const kinds = liveRecords().map((r) => r.kind);
    expect(kinds).toEqual(["proposed", "stake", "burn", "to-basket", "run", "reward", "stream"]);
  });

  it("ignores logs from anyone else (Ascend, the pool manager, the tokens)", () => {
    const foreign = LIVE_LOGS.filter((l) => !Object.values(CONTRACTS).some((c) => c.toLowerCase() === l.address.toLowerCase()));
    expect(foreign.length).toBeGreaterThan(20);
    expect(foreign.map((l) => toRec(l, CONTRACTS)).every((r) => r === null)).toBe(true);
  });
});

describe("stats", () => {
  it("matches the chain on Oct 14: 50,000 PNTH burned, 5 USDC to the basket and on to stakers", () => {
    const s = stats(ctx(liveRecords()));
    expect(s.pnth.burned.value).toBe("49999.999999999999999999");
    expect(s.pnth.burnedFromFees).toMatchObject({ raw: "49999999999999999999999", symbol: "PNTH" });
    expect(s.pnth.burns).toBe(1);
    expect(s.pnth.lastBurn?.url).toBe(`https://elysium.kinetiq.xyz/testnet-explorer/tx/${s.pnth.lastBurn?.tx}`);
    expect(s.basket.received.value).toBe("4.999999");
    expect(s.basket.streamedAsUsdc.value).toBe("4.999999");
    expect(s.basket.spent.value).toBe("0");
    expect(s.staking).toMatchObject({ stakers: 1, rewards: [{ symbol: "USDC", value: "4.999999", streams: 1 }] });
    expect(s.feeRuns).toBe(1);
    expect(s.consistent).toEqual({ stakedTotal: true, burnedFromFeesNotAboveBurnSink: true });
  });

  it("flags a mismatch between the events and the contract's own totals", () => {
    const s = stats(ctx(liveRecords(), { totalStaked: "1" }));
    expect(s.consistent.stakedTotal).toBe(false);
  });

  it("follows stakes through unstake and cancel", () => {
    const A = "0x00000000000000000000000000000000000000a1";
    const B = "0x00000000000000000000000000000000000000b2";
    const records = [
      rec(1, { kind: "stake", account: A, amount: "100" }),
      rec(2, { kind: "stake", account: B, amount: "50" }),
      rec(3, { kind: "unstake", account: B, amount: "50", coolEnd: 9 }),
      rec(4, { kind: "unstake", account: A, amount: "40", coolEnd: 9 }),
      rec(5, { kind: "cancel-unstake", account: A, amount: "40" }),
    ];
    const s = stats(ctx(records, { totalStaked: "100" }));
    expect(s.staking.stakers).toBe(1);
    expect(s.consistent.stakedTotal).toBe(true);
  });
});

describe("proposalStatus (the registry's own rules)", () => {
  const p = { id: 0, eta: 1_000, vetoed: false, executed: false, scoreRoot: tx(0), methodologyURI: "", list: [] };
  it("waits for its 24 hours, then is ready, then lapses after the grace week", () => {
    expect(proposalStatus(p, 0, 999)).toBe("waiting");
    expect(proposalStatus(p, 0, 1_000)).toBe("ready");
    expect(proposalStatus(p, 0, 1_000 + GRACE_SEC)).toBe("ready");
    expect(proposalStatus(p, 0, 1_001 + GRACE_SEC)).toBe("lapsed");
  });
  it("is active once started, replaced by a newer list, or vetoed", () => {
    expect(proposalStatus({ ...p, executed: true }, 1, 2_000)).toBe("active");
    expect(proposalStatus({ ...p, executed: true }, 2, 2_000)).toBe("replaced");
    expect(proposalStatus(p, 2, 2_000)).toBe("replaced"); // never started, and a newer one is active
    expect(proposalStatus({ ...p, vetoed: true }, 0, 2_000)).toBe("vetoed");
  });
});

describe("basket", () => {
  const list = [{ poolId: tx(7), token: COIN, weightBps: 2_000, perRunCap: "100000000" }];
  const proposal = { id: 0, eta: 1_792_095_681, vetoed: false, executed: false, scoreRoot: tx(9), methodologyURI: "ipfs://x", list };

  it("shows the waiting proposal 0 with its coins and its proposal transaction", () => {
    const b = basket(ctx(liveRecords(), { proposals: [proposal] }));
    expect(b.active).toBeNull();
    expect(b.proposals[0]).toMatchObject({ id: 0, status: "waiting", startsAt: 1_792_095_681, coins: [{ symbol: "FGK", weightPct: 20, buys: 0 }] });
    expect(b.proposals[0]!.coins[0]!.perRunCap.value).toBe("100");
    expect(b.proposals[0]!.proposed?.url).toMatch(/\/tx\/0x8be9d374/);
  });

  it("totals each coin's buys once the basket is active", () => {
    const records = [
      rec(1, { kind: "buy", token: COIN, quoteIn: "1500000", tokensOut: (12n * 10n ** 18n).toString() }),
      rec(2, { kind: "skip", token: COIN, reason: "STALE_AVERAGE" }),
      rec(3, { kind: "buy", token: COIN, quoteIn: "500000", tokensOut: (3n * 10n ** 18n).toString() }),
    ];
    const b = basket(ctx(records, { activeId: 1, proposals: [{ ...proposal, executed: true }] }));
    expect(b.active?.coins[0]).toMatchObject({ buys: 2, bought: { value: "15", symbol: "FGK" }, spent: { value: "2" } });
    expect(b.active?.coins[0]?.lastSkip).toMatchObject({ kind: "skip", reason: "STALE_AVERAGE" });
    expect(b.active?.coins[0]?.lastBuy?.tx).toBe(tx(3));
  });
});

describe("receipts", () => {
  const A = "0x00000000000000000000000000000000000000a1";
  const records = Array.from({ length: 7 }, (_, i) => rec(i, i % 2 ? { kind: "stake", account: A, amount: "1" } : { kind: "burn", runId: "1", amount: "5" }));

  it("lists newest first, a page at a time, with a cursor to the next page", () => {
    const c = ctx(records);
    const p1 = receipts(c, { limit: 3 });
    expect(p1.items.map((r) => r.tx)).toEqual([tx(6), tx(5), tx(4)]);
    expect(p1.next).toBe("104-0");
    const p2 = receipts(c, { limit: 3, before: { block: 104, logIndex: 0 } });
    expect(p2.items.map((r) => r.tx)).toEqual([tx(3), tx(2), tx(1)]);
    const p3 = receipts(c, { limit: 3, before: { block: 101, logIndex: 0 } });
    expect(p3.items.map((r) => r.tx)).toEqual([tx(0)]);
    expect(p3.next).toBeNull();
  });

  it("filters by kind and by account", () => {
    const c = ctx(records);
    expect(receipts(c, { limit: 50, kinds: ["burn"] }).items).toHaveLength(4);
    expect(receipts(c, { limit: 50, account: A.toUpperCase().replace("0X", "0x") }).items).toHaveLength(3);
    expect(receipts(c, { limit: 50, token: DEP.usdc }).items).toHaveLength(0);
  });

  it("gives every receipt its explorer link and readable amounts", () => {
    const [r] = receipts(ctx(records), { limit: 1 }).items;
    expect(r).toMatchObject({ kind: "burn", url: `https://elysium.kinetiq.xyz/testnet-explorer/tx/${tx(6)}`, at: 1_006, amount: { value: "0.000000000000000005", symbol: "PNTH" } });
  });
});
