// The current Trials round, with a stand-in for the Trials service: no network.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/api.ts";
import { describeRound, RoundReader, trialsCalls, type TrialsCalls } from "../src/trials.ts";
import { Verdicts } from "../src/verdicts.ts";

const FIXTURE = new URL("./fixtures/scan.json", import.meta.url).pathname;
const PACT = "0x4FAA6142168c6A1126df68CF400839126b3664db"; // CLEAN in the recorded scan
const KITTIQ = "0x34Cc866cC3a2afD5967334CB36d8E6629a6e5174"; // WATCH
const NEVER_READ = "0x1111111111111111111111111111111111111111";
const OPENS = 1_800_000_000;
const CLOSES = OPENS + 1_000;

const SCANNED = Date.parse(JSON.parse(readFileSync(FIXTURE, "utf8")).generatedAt);
const verdicts = () => {
  const v = new Verdicts(FIXTURE, { now: () => SCANNED });
  v.refresh();
  return v;
};
const candidate = (token: string, over: object = {}) => ({ token, symbol: "AAA", verdict: "CLEAN", launchedAt: 1_700_000_000, rank: 1, votes: 5, voters: 3, ...over });
const current = (over: object = {}) => ({
  round: 6,
  status: "open" as const,
  opensAt: OPENS,
  closesAt: CLOSES,
  seats: 3,
  method: "Wallets with PNTH staked",
  ballots: 9,
  leaders: [PACT],
  candidates: [candidate(PACT, { symbol: "PACT" }), candidate(KITTIQ, { symbol: "KITTIQ", votes: 1, rank: 2 })],
  ...over,
});

describe("the round", () => {
  it("gives the round's numbers and dates", () => {
    expect(describeRound(current(), verdicts(), OPENS + 10)).toMatchObject({ round: 6, seats: 3, ballots: 9, method: "Wallets with PNTH staked", opensAt: new Date(OPENS * 1000).toISOString(), closesAt: new Date(CLOSES * 1000).toISOString() });
  });

  it("counts down to the open, then the close, then stops at 0", () => {
    const at = (now: number) => {
      const r = describeRound(current(), verdicts(), now);
      return [r.status, r.secondsLeft];
    };
    expect(at(OPENS - 5)).toEqual(["upcoming", 5]);
    expect(at(OPENS)).toEqual(["open", 1_000]);
    expect(at(CLOSES - 1)).toEqual(["open", 1]);
    expect(at(CLOSES)).toEqual(["closed", 0]);
    expect(at(CLOSES + 99)).toEqual(["closed", 0]);
  });

  it("goes by the times, so a remembered answer can't say open after it closed", () => {
    expect(describeRound(current({ status: "open" }), verdicts(), CLOSES + 1).status).toBe("closed");
  });

  it("gives each candidate its votes and whether it would take a seat", () => {
    const [a, b] = describeRound(current(), verdicts(), OPENS).candidates;
    expect(a).toMatchObject({ token: PACT.toLowerCase(), symbol: "PACT", votes: 5, voters: 3, rank: 1, inSeat: true, launchedAt: new Date(1_700_000_000_000).toISOString() });
    expect(b).toMatchObject({ votes: 1, inSeat: false });
  });

  it("gives DELPHI's verdict now and the one from when the round was set", () => {
    const [a, b] = describeRound(current(), verdicts(), OPENS).candidates;
    expect(a).toMatchObject({ verdict: "CLEAN", verdictAtOpen: "CLEAN", verdictChanged: false, reason: "Clean so far: every check passed." });
    expect(b).toMatchObject({ verdict: "WATCH", verdictAtOpen: "CLEAN", verdictChanged: true });
    expect(a!.disputeUrl).toBe(`https://pantheonindex.com/delphi/dispute?token=${PACT.toLowerCase()}`);
    expect(a!.reportUrl).toBe(`https://pantheonindex.com/delphi/${PACT.toLowerCase()}`);
  });

  it("warns when a candidate's verdict is old", () => {
    const old = new Verdicts(FIXTURE, { now: () => Date.parse("2030-01-01T00:00:00.000Z") });
    old.refresh();
    expect(describeRound(current(), old, OPENS).candidates[0]!.stale).toBe(true);
    expect(describeRound(current(), verdicts(), OPENS).candidates[0]!.stale).toBe(false);
  });

  it("passes on round 6's rules: trading seats, the stake a vote needs, and coins already in", () => {
    const r = describeRound(current({ tradingSeats: 5, minStake: "1000", minHoldSec: 259_200, candidates: [candidate(PACT, { inByTrading: true }), candidate(KITTIQ)] }), verdicts(), OPENS);
    expect(r).toMatchObject({ tradingSeats: 5, minStake: "1000", minHoldSec: 259_200 });
    expect(r.candidates.map((c) => c.inByTrading)).toEqual([true, false]);
  });

  it("copes with rounds 1 to 5, which have none of those", () => {
    expect(describeRound(current(), verdicts(), OPENS)).toMatchObject({ tradingSeats: null, minStake: null, minHoldSec: null });
    expect(describeRound(current(), verdicts(), OPENS).candidates[0]!.inByTrading).toBe(false);
  });

  it("calls a coin DELPHI hasn't read unknown, not clean", () => {
    const r = describeRound(current({ candidates: [candidate(NEVER_READ)] }), verdicts(), OPENS);
    expect(r.candidates[0]).toMatchObject({ verdict: "UNKNOWN", verdictAtOpen: "CLEAN", verdictChanged: true, reportUrl: null, disputeUrl: null, stale: false });
  });

  it("matches seats however the addresses are written", () => {
    const r = describeRound(current({ leaders: [PACT.toLowerCase()] }), verdicts(), OPENS);
    expect(r.candidates[0]!.inSeat).toBe(true);
  });
});

describe("the reader", () => {
  it("remembers the round for 15 seconds, but keeps the clock and the verdicts live", async () => {
    let t = OPENS * 1000;
    let reads = 0;
    const r = new RoundReader(verdicts(), { current: async () => (reads++, current()) }, { now: () => t });
    expect((await r.read())!.secondsLeft).toBe(1_000);
    t += 10_000;
    expect((await r.read())!.secondsLeft).toBe(990);
    expect(reads).toBe(1);
    t += 5_000;
    await r.read();
    expect(reads).toBe(2);
  });

  it("says when there has never been a round", async () => {
    expect(await new RoundReader(verdicts(), { current: async () => null }).read()).toBeNull();
  });

  it("doesn't remember a failure", async () => {
    let down = true;
    const calls: TrialsCalls = { current: async () => (down ? Promise.reject(new Error("down")) : current()) };
    const r = new RoundReader(verdicts(), calls);
    await expect(r.read()).rejects.toThrow("down");
    down = false;
    expect((await r.read())!.round).toBe(6);
  });
});

describe("calling the Trials service", () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  it("reads the current round", async () => {
    let asked = "";
    const got = await trialsCalls("http://t", async (u) => ((asked = u), json(current()))).current();
    expect(asked).toBe("http://t/trials/current");
    expect(got?.round).toBe(6);
  });

  it("treats 404 as no round, and anything else as a failure", async () => {
    expect(await trialsCalls("http://t", async () => json({ error: "NO_ROUND" }, 404)).current()).toBeNull();
    await expect(trialsCalls("http://t", async () => json({}, 500)).current()).rejects.toThrow("500");
    await expect(trialsCalls("http://t", async () => json({ nope: 1 })).current()).rejects.toThrow();
  });
});

describe("asking the server", () => {
  const v = verdicts();

  it("answers with the round", async () => {
    const res = await buildApp(v, { round: new RoundReader(v, { current: async () => current() }, { now: () => OPENS * 1000 }) }).inject({ url: "/trials/round" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json()).toMatchObject({ round: 6, status: "open", secondsLeft: 1_000 });
  });

  it("answers 404 with no round, and 503 when Trials is down, without saying why", async () => {
    expect((await buildApp(v, { round: new RoundReader(v, { current: async () => null }) }).inject({ url: "/trials/round" })).json()).toEqual({ error: "NO_ROUND" });
    const res = await buildApp(v, { round: new RoundReader(v, { current: () => Promise.reject(new Error("detail")) }) }).inject({ url: "/trials/round" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "TRIALS_UNAVAILABLE" });
  });
});
