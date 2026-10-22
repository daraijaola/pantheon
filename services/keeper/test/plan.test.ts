import { describe as group, expect, it } from "vitest";
import { MAX_CALL_GAS, TX_GAS_LIMIT, withMargin } from "../src/keeper.ts";
import { batches, describe, useful, type Simulated } from "../src/plan.ts";
import { addr, DEP, none } from "./fakes.ts";

const COIN = addr(0xc0);
const sim = (kind: Simulated["kind"], e: Partial<ReturnType<typeof none>>): Simulated => ({ kind, ok: true, gasUsed: 1n, effects: { ...none(), ...e } });
const names = { usdc: DEP.usdc, pnth: DEP.pnth, symbols: new Map([[COIN.toLowerCase(), "FGK"]]) };

group("describe", () => {
  it("says what the basket would buy and why it skips a coin, in plain words", () => {
    const s = sim("rebalance", {
      buys: [{ token: COIN, quoteIn: 1_500_000n, tokensOut: 12_345_678n * 10n ** 18n }],
      skips: [{ token: addr(0xc1), reason: "STALE_AVERAGE" }],
    });
    expect(describe(s, names)).toEqual([
      "basket buys 12,345,678 FGK for 1.5 USDC",
      "basket skips 0x0000…00c1: its price average is too old (nobody traded it lately), so the price can't be trusted",
    ]);
    expect(useful(s)).toBe(true);
  });

  it("does not count a rebalance that only skips as worth sending", () => {
    expect(useful(sim("rebalance", { skips: [{ token: COIN, reason: "PRICE_OUT_OF_BAND" }] }))).toBe(false);
    expect(useful(sim("run", { deferred: [{ side: "quote", amount: 5n }] }))).toBe(false);
  });

  it("names the burn and the basket payment of a run", () => {
    const s = sim("run", {
      legs: [
        { side: "token", job: "BURN", to: DEP.burnSink, amount: 50_000n * 10n ** 18n },
        { side: "quote", job: "INDEX", to: DEP.indexVault, amount: 4_999_999n },
      ],
    });
    expect(describe(s, names)).toEqual(["burn 50,000 PNTH from PNTH's fees", "send 4.9999 USDC of PNTH's fees to the basket"]);
  });
});

group("batches", () => {
  it("splits into groups of at most n", () => {
    expect(batches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(batches([], 2)).toEqual([]);
  });
});

group("withMargin", () => {
  it("adds 50%: enough for the unstake that ran out of gas on the fork (estimated 104,476, re-estimated 136,040)", () => {
    expect(withMargin(104_476n)).toBe(156_714n);
    expect(withMargin(104_476n)).toBeGreaterThan(136_040n);
  });

  it("never asks for more than Elysium's 32M gas per transaction (the node would refuse it)", () => {
    expect(withMargin(MAX_CALL_GAS)).toBe(15_000_000n);
    expect(withMargin(22_120_137n)).toBe(TX_GAS_LIMIT); // a batch of 50 refreshes on Oct 22: 33.2M with the margin
  });
});
