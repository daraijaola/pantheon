// The staged wallet scan, with stand-ins for the readers: no network.
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/api.ts";
import { buildBag } from "../src/bag.ts";
import { NotReady, type Holdings } from "../src/holdings.ts";
import type { Elsewhere } from "../src/elsewhere.ts";
import { TooBig, type Footprint } from "../src/footprint.ts";
import type { FirstSeen, FirstTx, WalletNow } from "../src/history.ts";
import { scanStages, type ScanDeps, type StageEvent } from "../src/scan.ts";
import type { StandingFacts } from "../src/standing.ts";
import { Verdicts } from "../src/verdicts.ts";

const FIXTURE = new URL("./fixtures/scan.json", import.meta.url).pathname;
const WALLET = "0x79a320a02db0c1cbe7a5f2cd47210ea6f3b9f23a";
const PACT = "0x4faa6142168c6a1126df68cf400839126b3664db";

const HISTORY: WalletNow = { wallet: WALLET, network: "testnet", readAt: "2026-11-01T00:00:00.000Z", txsSent: 7, hype: "1", coinsLaunched: [] };
const FIRST_DAY: FirstSeen = { block: "5", time: "2026-10-08T02:07:50.000Z" };
const FIRST_TX: FirstTx = { block: "9", time: "2026-10-09T02:07:50.000Z", tx: "0xab", to: null };
const reads = (over: Partial<ScanDeps["history"]> = {}): ScanDeps["history"] => ({ quick: async () => HISTORY, firstDay: async () => FIRST_DAY, firstTx: async () => FIRST_TX, ...over });
const HOLDINGS: Holdings = {
  wallet: WALLET,
  network: "testnet",
  readAt: "2026-11-01T00:00:00.000Z",
  coinsChecked: 7,
  holdings: [{ token: PACT, symbol: "PACT", name: "TestPact", venue: "ascend", balance: "1", decimals: 18, amount: "0.000000000000000001" }],
  unread: [],
};
const STANDING: StandingFacts = {
  wallet: WALLET,
  network: "testnet",
  readAt: "2026-11-01T00:00:00.000Z",
  firstSeen: FIRST_DAY,
  staking: { now: { raw: "0", amount: "0" }, bonusSince: null, firstStaked: null },
  roundsVoted: [],
  coinsLaunched: { total: 0, byVerdict: {} },
  passport: { tier: 0, boost: 1 },
  complete: true,
};
const FOOTPRINT = { wallet: WALLET, tokens: [], unread: [], complete: true, totals: { tokensTouched: 2 } } as unknown as Footprint;
const verdicts = new Verdicts(FIXTURE);
verdicts.refresh();
const deps = (over: Partial<ScanDeps> = {}): ScanDeps => ({
  history: reads(),
  holdings: { read: async () => HOLDINGS },
  standing: { read: async () => STANDING },
  footprint: { read: async () => FOOTPRINT },
  bag: (h, f) => buildBag(h, (t) => verdicts.get(t), undefined, f),
  ...over,
});
const all = async (d: ScanDeps) => {
  const out: StageEvent[] = [];
  for await (const s of scanStages(WALLET, d)) out.push(s);
  return out;
};

describe("the wider stages", () => {
  it("gives the first transaction on its own, so a failure there costs only that", async () => {
    const stages = await all(deps({ history: reads({ firstTx: () => Promise.reject(new Error("no")) }) }));
    expect(stages.find((s) => s.stage === "firstDay")).toMatchObject({ ok: true });
    expect(stages.find((s) => s.stage === "firstTx")).toEqual({ stage: "firstTx", ok: false, error: "CHAIN_UNAVAILABLE" });
  });

  it("sends the bag again with the footprint, marked as the whole wallet", async () => {
    const stages = await all(deps());
    expect(stages.find((s) => s.stage === "verdicts")).toMatchObject({ data: { wholeWallet: false } });
    expect(stages.find((s) => s.stage === "wholeBag")).toMatchObject({ ok: true, data: { wholeWallet: true } });
  });

  it("says so if the footprint fails, and the first bag still stands", async () => {
    const stages = await all(deps({ footprint: { read: () => Promise.reject(new Error("no")) } }));
    expect(stages.find((s) => s.stage === "verdicts")).toMatchObject({ ok: true });
    expect(stages.find((s) => s.stage === "wholeBag")).toEqual({ stage: "wholeBag", ok: false, error: "CHAIN_UNAVAILABLE" });
  });

  it("gives the footprint longer than the other stages, because it's the slowest", async () => {
    const slow = { read: () => new Promise<Footprint>((r) => setTimeout(() => r(FOOTPRINT), 75)) };
    const stages = await all(deps({ footprint: slow, timeoutMs: 50 }));
    expect(stages.find((s) => s.stage === "footprint")).toMatchObject({ ok: true });
  });

  it("still gives up on a stuck footprint, so the reveal can't hang", async () => {
    const stages = await all(deps({ footprint: { read: () => new Promise(() => {}) }, timeoutMs: 10 }));
    expect(stages.find((s) => s.stage === "footprint")).toEqual({ stage: "footprint", ok: false, error: "TIMEOUT" });
    expect(stages.find((s) => s.stage === "wholeBag")).toEqual({ stage: "wholeBag", ok: false, error: "TIMEOUT" });
  });

  it("says a wallet is too big, and the first bag still stands", async () => {
    const stages = await all(deps({ footprint: { read: () => Promise.reject(new TooBig("x")) } }));
    expect(stages.find((s) => s.stage === "verdicts")).toMatchObject({ ok: true });
    expect(stages.find((s) => s.stage === "footprint")).toEqual({ stage: "footprint", ok: false, error: "TOO_BIG" });
    expect(stages.find((s) => s.stage === "wholeBag")).toEqual({ stage: "wholeBag", ok: false, error: "TOO_BIG" });
  });

  it("leaves other chains out unless they're turned on", async () => {
    expect((await all(deps())).some((s) => s.stage === "elsewhere")).toBe(false);
  });

  it("adds them last when they're on, and a failure costs only that stage", async () => {
    const data = { wallet: WALLET } as unknown as Elsewhere;
    expect((await all(deps({ elsewhere: { read: async () => data } }))).at(-1)).toEqual({ stage: "elsewhere", ok: true, data });
    expect((await all(deps({ elsewhere: { read: () => Promise.reject(new Error("no")) } }))).at(-1)).toEqual({ stage: "elsewhere", ok: false, error: "CHAIN_UNAVAILABLE" });
  });
});

describe("the stages", () => {
  it("come in order, each with its real data, and verdicts join holdings", async () => {
    const stages = await all(deps());
    expect(stages.map((s) => s.stage)).toEqual(["history", "holdings", "verdicts", "firstDay", "firstTx", "standing", "footprint", "wholeBag"]);
    expect(stages[0]).toEqual({ stage: "history", ok: true, data: HISTORY });
    expect(stages[3]).toEqual({ stage: "firstDay", ok: true, data: { firstSeen: FIRST_DAY } });
    expect(stages[1]).toEqual({ stage: "holdings", ok: true, data: HOLDINGS });
    expect(stages[2]).toMatchObject({ stage: "verdicts", ok: true, data: { coins: [{ token: PACT, verdict: "CLEAN" }] } });
  });

  it("carries the wallet's standing facts and whole footprint", async () => {
    const stages = await all(deps());
    expect(stages[5]).toEqual({ stage: "standing", ok: true, data: STANDING });
    expect(stages[6]).toEqual({ stage: "footprint", ok: true, data: FOOTPRINT });
  });

  it("still finishes if standing fails, and says so", async () => {
    const stages = await all(deps({ standing: { read: () => Promise.reject(new Error("down")) } }));
    expect(stages[5]).toEqual({ stage: "standing", ok: false, error: "CHAIN_UNAVAILABLE" });
    expect(stages.slice(0, 5).every((s) => s.ok)).toBe(true);
    expect(stages[6]).toMatchObject({ stage: "footprint", ok: true });
  });

  it("sends the first stage before the slower ones are done", async () => {
    let finish: (h: Holdings) => void = () => {};
    const slow = deps({ holdings: { read: () => new Promise((r) => (finish = r)) } });
    const it = scanStages(WALLET, slow);
    expect((await it.next()).value).toMatchObject({ stage: "history", ok: true });
    finish(HOLDINGS);
    expect((await it.next()).value).toMatchObject({ stage: "holdings", ok: true });
  });

  it("doesn't let a slow first day hold back the stages before it", async () => {
    let release: (f: FirstSeen) => void = () => {};
    const it = scanStages(WALLET, deps({ history: reads({ firstDay: () => new Promise((r) => (release = r)) }) }));
    expect((await it.next()).value).toMatchObject({ stage: "history", ok: true });
    expect((await it.next()).value).toMatchObject({ stage: "holdings", ok: true });
    expect((await it.next()).value).toMatchObject({ stage: "verdicts", ok: true });
    release(FIRST_DAY);
    expect((await it.next()).value).toMatchObject({ stage: "firstDay", ok: true });
  });

  it("starts everything together, so the scan takes as long as the slowest", async () => {
    let holdingsStarted = false;
    let dayStarted = false;
    let release: (h: WalletNow) => void = () => {};
    const run = all(
      deps({
        history: reads({ quick: () => new Promise((r) => (release = r)), firstDay: async () => ((dayStarted = true), FIRST_DAY) }),
        holdings: { read: async () => ((holdingsStarted = true), HOLDINGS) },
      }),
    );
    await new Promise((r) => setImmediate(r));
    expect([holdingsStarted, dayStarted]).toEqual([true, true]); // while history is still running
    release(HISTORY);
    await run;
  });
});

describe("when a stage fails", () => {
  it("says so, and the others still arrive", async () => {
    const logs: string[] = [];
    const stages = await all(deps({ history: reads({ quick: () => Promise.reject(new Error("node down\nstack")) }), log: (m) => logs.push(m) }));
    expect(stages[0]).toEqual({ stage: "history", ok: false, error: "CHAIN_UNAVAILABLE" });
    expect(stages[1]).toMatchObject({ stage: "holdings", ok: true });
    expect(stages[2]).toMatchObject({ stage: "verdicts", ok: true });
    expect(logs).toEqual(["scan stage failed: node down"]);
  });

  it("can't give verdicts without holdings, and doesn't pretend to", async () => {
    const stages = await all(deps({ holdings: { read: () => Promise.reject(new Error("down")) } }));
    expect(stages[0]).toMatchObject({ stage: "history", ok: true });
    expect(stages[1]).toEqual({ stage: "holdings", ok: false, error: "CHAIN_UNAVAILABLE" });
    expect(stages[2]).toEqual({ stage: "verdicts", ok: false, error: "CHAIN_UNAVAILABLE" });
    expect(stages[3]).toMatchObject({ stage: "firstDay", ok: true });
    expect(stages).toHaveLength(8);
  });

  it("says not ready before DELPHI's coins are loaded", async () => {
    const stages = await all(deps({ holdings: { read: () => Promise.reject(new NotReady("no coins")) } }));
    expect(stages[1]).toEqual({ stage: "holdings", ok: false, error: "NOT_READY" });
  });

  it("gives up on a stuck stage, so the reveal can't hang", async () => {
    const t0 = Date.now();
    const stages = await all(deps({ history: reads({ quick: () => new Promise(() => {}) }), timeoutMs: 30 }));
    expect(stages[0]).toEqual({ stage: "history", ok: false, error: "TIMEOUT" });
    expect(stages[1]).toMatchObject({ stage: "holdings", ok: true });
    expect(Date.now() - t0).toBeLessThan(2_000);
  });
});

describe("the stream", () => {
  type Sent = { event: string; data: { stage?: string; failed?: string[]; ok?: boolean } };
  const parse = (body: string): Sent[] =>
    body
      .trim()
      .split("\n\n")
      .map((block) => {
        const [e, d] = block.split("\n");
        return { event: e!.replace("event: ", ""), data: JSON.parse(d!.replace("data: ", "")) };
      });
  const app = (d = deps()) => buildApp(verdicts, { scan: (w) => scanStages(w, d) });

  it("sends one event per stage, then done, in a form that won't be held back on the way", async () => {
    const res = await app().inject({ url: `/wallets/${WALLET}/scan` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.headers["cache-control"]).toBe("no-cache, no-transform");
    const sent = parse(res.body);
    expect(sent.map((s) => s.event)).toEqual(["stage", "stage", "stage", "stage", "stage", "stage", "stage", "stage", "done"]);
    expect(sent.slice(0, 8).map((s) => s.data.stage)).toEqual(["history", "holdings", "verdicts", "firstDay", "firstTx", "standing", "footprint", "wholeBag"]);
  });

  it("says at the end which stages failed", async () => {
    const res = await app(deps({ holdings: { read: () => Promise.reject(new Error("rpc detail")) } })).inject({ url: `/wallets/${WALLET}/scan` });
    expect(parse(res.body).at(-1)).toEqual({ event: "done", data: { failed: ["holdings", "verdicts", "wholeBag"] } });
    expect(res.body).not.toContain("rpc detail");
  });

  it("treats an address the same however it's written", async () => {
    const seen: string[] = [];
    const a = buildApp(verdicts, { scan: (w) => (seen.push(w), scanStages(w, deps())) });
    await a.inject({ url: `/wallets/${WALLET.toUpperCase().replace("0X", "0x")}/scan` });
    expect(seen).toEqual([WALLET]);
  });

  it("refuses a bad address as plain JSON", async () => {
    const res = await app().inject({ url: "/wallets/nope/scan" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "INVALID_ADDRESS" });
  });

  it("ends the stream if the scan itself breaks", async () => {
    const broken = async function* (): AsyncGenerator<StageEvent> {
      yield { stage: "history", ok: false, error: "TIMEOUT" };
      throw new Error("boom");
    };
    const res = await buildApp(verdicts, { scan: broken }).inject({ url: `/wallets/${WALLET}/scan` });
    expect(parse(res.body).map((s) => s.event)).toEqual(["stage"]);
    expect(res.body).not.toContain("boom");
  });
});
