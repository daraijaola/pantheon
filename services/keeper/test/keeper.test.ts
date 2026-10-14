import { describe, expect, it } from "vitest";
import { MIN_GAS_BALANCE, passportFeed, SWEEP, tick } from "../src/keeper.ts";
import type { State } from "../src/state.ts";
import { addr, cfg, DEP, fakeChain, none } from "./fakes.ts";

const fresh = (): State => ({ stakedCursor: "100", stakers: [], sweep: 0, pokesSince: 0 });
const noFeed = async (since: number) => ({ accounts: [], until: since + 300 });
const fees = { ...none(), legs: [{ side: "quote" as const, job: "INDEX" as const, to: DEP.indexVault, amount: 5_000_000n }] };
const stream = { ...none(), streamed: [{ token: DEP.usdc, amount: 5_000_000n }] };

describe("a practice round", () => {
  it("simulates the full bundle in order and sends nothing", async () => {
    const { chain, log } = fakeChain({ effects: { run: fees, rebalance: stream } });
    const r = await tick({ cfg: cfg(), chain, pokes: noFeed, state: fresh() });
    expect(log.simulated.map((c) => c.kind)).toEqual(["run", "rebalance"]);
    expect(log.sent).toEqual([]);
    expect(r.calls.map((c) => [c.kind, c.worthSending])).toEqual([["run", true], ["rebalance", true]]);
    expect(r.calls[0]!.lines).toEqual(["send 5 USDC of PNTH's fees to the basket"]);
    expect(r.calls[1]!.lines).toEqual(["stream 5 USDC to stakers over a day"]);
    expect(r.cost).toBe("0.000020 HYPE"); // 200k gas at 0.1 gwei
  });

  it("marks calls with nothing to do (or that would fail) as not worth sending", async () => {
    const { chain } = fakeChain({ failing: ["rebalance"] });
    const r = await tick({ cfg: cfg(), chain, pokes: noFeed, state: fresh() });
    expect(r.calls.map((c) => c.worthSending)).toEqual([false, false]);
    expect(r.calls[0]!.lines).toEqual(["no new fees to route"]);
    expect(r.calls[1]!.lines[0]).toMatch(/would fail \(reverted\), not sent/);
    expect(r.cost).toBe("0.000000 HYPE");
  });
});

describe("stakers and boosts", () => {
  it("learns new stakers once, and moves its cursors forward", async () => {
    const state = fresh();
    const { chain, log } = fakeChain({ head: 5_000n, staked: [addr(1), addr(2), addr(1)] });
    await tick({ cfg: cfg(), chain, pokes: noFeed, state });
    expect(state.stakers).toEqual([addr(1), addr(2)]);
    expect(state.stakedCursor).toBe("5001");
    expect(state.pokesSince).toBe(300);
    await tick({ cfg: cfg(), chain, pokes: noFeed, state }); // no new blocks since: nothing to search
    expect(log.stakedFrom).toEqual([100n]);
    expect(state.stakers).toHaveLength(2);
  });

  it("refreshes a falling boost at once, a rising one only past the threshold, in batches", async () => {
    const stakers = [
      { account: addr(1), staked: 100n, working: 125n, next: 100n }, // Passport lapsed: must fall now
      { account: addr(2), staked: 100n, working: 100n, next: 101n }, // +1%: not worth gas yet
      { account: addr(3), staked: 100n, working: 100n, next: 103n }, // +3%: refresh
      { account: addr(4), staked: 100n, working: 0n, next: 100n }, // never synced: refresh
      { account: addr(5), staked: 100n, working: 100n, next: 100n }, // unchanged
    ];
    const state = { ...fresh(), stakers: stakers.map((s) => s.account) };
    const { chain, log } = fakeChain({ stakers });
    const r = await tick({ cfg: cfg({ pokeBatch: 2 }), chain, pokes: noFeed, state });
    const pokes = log.simulated.filter((c) => c.kind === "poke").map((c) => c.args[0]);
    expect(pokes).toEqual([[addr(1), addr(3)], [addr(4)]]);
    expect(r.calls.filter((c) => c.kind === "poke").every((c) => c.worthSending)).toBe(true);
  });

  it("checks accounts the Passport service flagged even before it has seen them stake", async () => {
    const flagged = addr(9);
    const { chain, log } = fakeChain({ stakers: [{ account: flagged, staked: 50n, working: 60n, next: 50n }] });
    await tick({ cfg: cfg(), chain, pokes: async () => ({ accounts: [flagged], until: 42 }), state: fresh() });
    expect(log.read[0]).toEqual([flagged]);
    expect(log.simulated.find((c) => c.kind === "poke")?.args[0]).toEqual([flagged]);
  });

  it("keeps working, by rotation only, when the Passport service is down", async () => {
    const state = { ...fresh(), stakers: [addr(1)], pokesSince: 7 };
    const { chain } = fakeChain({});
    const r = await tick({ cfg: cfg(), chain, pokes: async () => Promise.reject(new Error("connect ECONNREFUSED")), state });
    expect(r.notes[0]).toMatch(/Passport feed unavailable/);
    expect(state.pokesSince).toBe(7); // not skipped past: next round asks again
    expect(r.calls.length).toBeGreaterThan(0);
  });

  it("checks a rotating slice when there are many stakers", async () => {
    const many = Array.from({ length: SWEEP + 50 }, (_, i) => addr(i + 1));
    const state = { ...fresh(), stakers: many };
    const { chain, log } = fakeChain({});
    await tick({ cfg: cfg(), chain, pokes: noFeed, state });
    await tick({ cfg: cfg(), chain, pokes: noFeed, state });
    expect(log.read[0]).toHaveLength(SWEEP);
    expect(log.read[1]![0]).toBe(many[SWEEP]); // the second round starts where the first stopped
    expect(new Set([...log.read[0]!, ...log.read[1]!]).size).toBe(many.length);
  });
});

describe("live mode", () => {
  it("sends only the calls worth sending, in order", async () => {
    const { chain, log } = fakeChain({ effects: { rebalance: stream } });
    const r = await tick({ cfg: cfg({ mode: "live" }), chain, pokes: noFeed, state: fresh(), sender: addr(0xee) });
    expect(log.sent.map((c) => c.kind)).toEqual(["rebalance"]);
    expect(r.sent).toEqual([{ kind: "rebalance", tx: `0x${"ab".repeat(32)}`, ok: true }]);
  });

  it("sends nothing when its wallet is nearly out of gas, and says so", async () => {
    const { chain, log } = fakeChain({ effects: { run: fees }, balance: MIN_GAS_BALANCE - 1n });
    const r = await tick({ cfg: cfg({ mode: "live" }), chain, pokes: noFeed, state: fresh(), sender: addr(0xee) });
    expect(log.sent).toEqual([]);
    expect(r.notes.join(" ")).toMatch(/below .*nothing sent/);
  });
});

describe("passportFeed", () => {
  it("reads the Passport service's feed and checks it", async () => {
    const fetchFn = (async (url: string) => {
      expect(url).toBe("http://127.0.0.1:8787/passport/pokes?since=10");
      return new Response(JSON.stringify({ accounts: ["0x00000000000000000000000000000000000000aa"], until: 99 }));
    }) as typeof fetch;
    expect(await passportFeed("http://127.0.0.1:8787", fetchFn)(10)).toEqual({ accounts: ["0x00000000000000000000000000000000000000AA"], until: 99 });
    const bad = (async () => new Response(JSON.stringify({ accounts: ["nope"], until: 1 }))) as unknown as typeof fetch;
    await expect(passportFeed("http://x", bad)(0)).rejects.toThrow();
  });
});
