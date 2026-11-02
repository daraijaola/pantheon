// A wallet's voting record and ballot status, with stand-ins for the Trials service: no network.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/api.ts";
import { ballotStatus, RecordReader, roundsCalls, type RoundResult, type RoundsCalls } from "../src/record.ts";
import { Verdicts } from "../src/verdicts.ts";

const FIXTURE = new URL("./fixtures/scan.json", import.meta.url).pathname;
const scan = JSON.parse(readFileSync(FIXTURE, "utf8"));
const SCANNED = Date.parse(scan.generatedAt);
const WALLET = "0x79a320a02db0c1cbe7a5f2cd47210ea6f3b9f23a";
const OTHER = "0x7a988b8fa5d66de4950ee5f94c55c7820b6e562f";
const PACT = "0x4faa6142168c6a1126df68cf400839126b3664db";
const KITTIQ = "0x34cc866cc3a2afd5967334cb36d8e6629a6e5174";
const CLOSES = 1_790_000_000;
const AFTER = (CLOSES + 1_000) * 1000;
const DAY = Math.floor(CLOSES / 86_400);

const ballot = (voter: string, coins: string[], weight = 1) => ({ voter, coins, weight, receivedAt: CLOSES - 100 });
const round = (n: number, ballots: RoundResult["ballotList"], over: Partial<RoundResult> = {}): RoundResult => ({
  round: n,
  status: "closed",
  closesAt: CLOSES,
  seats: 3,
  leaders: [PACT.toUpperCase().replace("0X", "0x")],
  candidates: [{ token: PACT, symbol: "PACT" }, { token: KITTIQ, symbol: "KITTIQ" }],
  ballotList: ballots,
  ...over,
});
function verdicts(prices?: Record<string, Array<[number, number]>>) {
  const v = new Verdicts(FIXTURE, { now: () => SCANNED });
  v.refresh();
  if (prices) v.applyFresh(JSON.stringify({ ...scan, generatedAt: new Date(SCANNED + 1000).toISOString(), dailyPrices: prices }));
  return v;
}
const calls = (rounds: RoundResult[], over: Partial<RoundsCalls> = {}): RoundsCalls => ({ rounds: async () => rounds, you: async () => null, ...over });
const inBasket = async () => new Set([PACT]);
const reader = (rounds: RoundResult[], opts: { prices?: Record<string, Array<[number, number]>>; basket?: () => Promise<Set<string>>; now?: number } = {}) =>
  new RecordReader(verdicts(opts.prices), calls(rounds), opts.basket ?? inBasket, { now: () => opts.now ?? AFTER });

describe("a wallet's record", () => {
  it("gives each round's picks: seat, basket, verdict and how it did", async () => {
    const got = await reader([round(4, [ballot(WALLET, [PACT, KITTIQ], 3)])], { prices: { [PACT]: [[DAY - 1, 1], [DAY, 2], [DAY + 5, 3]] } }).read(WALLET);
    expect(got).toMatchObject({ wallet: WALLET, network: "testnet", totals: { rounds: 1, picks: 2, seatsWon: 1 }, complete: true });
    expect(got.rounds[0]).toMatchObject({ round: 4, closed: true, votes: 3, closedAt: new Date(CLOSES * 1000).toISOString() });
    expect(got.rounds[0]!.picks).toEqual([
      { token: PACT, symbol: "PACT", wonSeat: true, inBasketNow: true, verdictNow: "CLEAN", changePct: 50 },
      { token: KITTIQ, symbol: "KITTIQ", wonSeat: false, inBasketNow: false, verdictNow: "WATCH", changePct: null },
    ]);
  });

  it("shows only this wallet's own ballot, newest round first", async () => {
    const got = await reader([round(3, [ballot(WALLET, [PACT])]), round(4, [ballot(OTHER, [KITTIQ])]), round(5, [ballot(WALLET, [KITTIQ])])]).read(WALLET);
    expect(got.rounds.map((r) => r.round)).toEqual([5, 3]);
    expect(JSON.stringify(got)).not.toContain(OTHER);
  });

  it("finds a wallet however its address is written", async () => {
    const got = await reader([round(3, [ballot(WALLET.toUpperCase().replace("0X", "0x"), [PACT])])]).read(WALLET.toUpperCase().replace("0X", "0x"));
    expect(got.totals.rounds).toBe(1);
    expect(got.wallet).toBe(WALLET);
  });

  it("is plainly empty for a wallet that has never voted", async () => {
    expect(await reader([round(3, [])]).read(WALLET)).toMatchObject({ rounds: [], totals: { rounds: 0, picks: 0, seatsWon: 0 }, complete: true });
  });

  it("calls no seat won while a round is open: the leaders can still change", async () => {
    const prices: Record<string, Array<[number, number]>> = { [PACT]: [[DAY - 1, 1], [DAY + 5, 3]] };
    const got = await reader([round(6, [ballot(WALLET, [PACT])], { status: "open", closesAt: CLOSES + 99_999 })], { prices }).read(WALLET);
    expect(got.rounds[0]).toMatchObject({ closed: false });
    expect(got.rounds[0]!.picks[0]).toMatchObject({ wonSeat: false, changePct: null });
    expect(got.totals.seatsWon).toBe(0);
  });

  it("says basket status is unknown when the basket can't be read, not out of it", async () => {
    const got = await reader([round(3, [ballot(WALLET, [PACT])])], { basket: () => Promise.reject(new Error("down")) }).read(WALLET);
    expect(got.rounds[0]!.picks[0]!.inBasketNow).toBeNull();
    expect(got.complete).toBe(false);
  });

  it("fails out loud when the Trials service fails", async () => {
    const r = new RecordReader(verdicts(), calls([], { rounds: () => Promise.reject(new Error("down")) }), inBasket);
    await expect(r.read(WALLET)).rejects.toThrow("down");
  });

  it("remembers the rounds for a minute", async () => {
    let t = AFTER;
    let reads = 0;
    const r = new RecordReader(verdicts(), calls([], { rounds: async () => (reads++, []) }), inBasket, { now: () => t });
    await r.read(WALLET);
    await r.read(OTHER);
    expect(reads).toBe(1);
    t += 60_000;
    await r.read(WALLET);
    expect(reads).toBe(2);
  });
});

describe("how a coin did", () => {
  const P = "0x4FAA6142168c6A1126df68CF400839126b3664db";

  it("compares the last price by that day with the latest, one decimal", () => {
    expect(verdicts({ [PACT]: [[100, 2], [101, 3]] }).priceChange(P, 100 * 86_400)).toBe(50);
    expect(verdicts({ [PACT]: [[100, 3], [101, 2]] }).priceChange(P, 100 * 86_400)).toBe(-33.3);
  });

  it("uses the last trade before a quiet day", () => {
    expect(verdicts({ [PACT]: [[90, 2], [110, 4]] }).priceChange(P, 100 * 86_400)).toBe(100);
  });

  it("says unknown with no fresh read, no price, no earlier trade, or a zero price", () => {
    expect(verdicts().priceChange(P, 100 * 86_400)).toBeNull();
    expect(verdicts({}).priceChange(P, 100 * 86_400)).toBeNull();
    expect(verdicts({ [PACT]: [[200, 2]] }).priceChange(P, 100 * 86_400)).toBeNull();
    expect(verdicts({ [PACT]: [[100, 0], [101, 2]] }).priceChange(P, 100 * 86_400)).toBeNull();
  });
});

describe("whether a wallet can vote", () => {
  const you = (over: object = {}, y: object = {}) => ({ round: 6, status: "open" as const, closesAt: CLOSES, seats: 3, you: { weight: 2, ballot: null, ...y }, ...over });
  const NOW = CLOSES - 10;

  it("says yes with its votes and how many it can pick", () => {
    expect(ballotStatus(WALLET, you(), NOW)).toEqual({ wallet: WALLET, round: 6, canVote: true, whyNot: null, votes: 2, stakeVote: null, stakeCountsFrom: null, maxPicks: 3, picks: [], closesAt: new Date(CLOSES * 1000).toISOString() });
  });

  it("shows what it already picked", () => {
    expect(ballotStatus(WALLET, you({}, { ballot: { coins: [PACT.toUpperCase().replace("0X", "0x")], weight: 2 } }), NOW).picks).toEqual([PACT]);
  });

  it("says why not", () => {
    expect(ballotStatus(WALLET, null, NOW)).toMatchObject({ canVote: false, whyNot: "NO_ROUND", round: null });
    expect(ballotStatus(WALLET, you({ status: "upcoming" }), NOW).whyNot).toBe("NOT_OPEN");
    expect(ballotStatus(WALLET, you(), CLOSES).whyNot).toBe("CLOSED");
    expect(ballotStatus(WALLET, you({ status: "closed" }), CLOSES + 1).whyNot).toBe("CLOSED");
    expect(ballotStatus(WALLET, you({}, { weight: 0 }), NOW)).toMatchObject({ canVote: false, whyNot: "NO_VOTES", votes: 0 });
  });

  it("says when a stake doesn't count yet, and from when it will", () => {
    const got = ballotStatus(WALLET, you({}, { weight: 0, stakeVote: "too_new", stakeVoteFrom: CLOSES + 500 }), NOW);
    expect(got).toMatchObject({ canVote: false, whyNot: "NO_VOTES", stakeVote: "too_new", stakeCountsFrom: new Date((CLOSES + 500) * 1000).toISOString() });
    expect(ballotStatus(WALLET, you(), NOW)).toMatchObject({ stakeVote: null, stakeCountsFrom: null });
  });

  it("says unknown when the chain didn't answer, not that it has no votes", () => {
    expect(ballotStatus(WALLET, you({}, { weight: null }), NOW)).toMatchObject({ canVote: false, whyNot: "UNKNOWN", votes: null });
  });

  it("is always read fresh", async () => {
    let reads = 0;
    const r = new RecordReader(verdicts(), calls([], { you: async () => (reads++, null) }), inBasket);
    await r.ballot(WALLET);
    await r.ballot(WALLET);
    expect(reads).toBe(2);
  });
});

describe("calling the Trials service", () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const page = (n: number, status: string) => ({ ...round(n, []), status });

  it("reads every round and skips ones that don't exist", async () => {
    const f = async (u: string) => {
      const p = new URL(u).pathname;
      if (p === "/health") return json({ round: 3 });
      if (p === "/trials/rounds/1") return json({ error: "NO_ROUND" }, 404);
      return json(page(Number(p.at(-1)), "closed"));
    };
    expect((await roundsCalls("http://t", f).rounds()).map((r) => r.round)).toEqual([2, 3]);
  });

  it("skips an open round, which lists no ballots, instead of failing for every wallet", async () => {
    const f = async (u: string) => {
      const p = new URL(u).pathname;
      if (p === "/health") return json({ round: 2 });
      if (p.endsWith("/2")) {
        const { ballotList: _hidden, ...open } = page(2, "open");
        return json(open);
      }
      return json(page(1, "closed"));
    };
    expect((await roundsCalls("http://t", f).rounds()).map((r) => r.round)).toEqual([1]);
  });

  it("reads a closed round once, and an open one every time", async () => {
    const asked: string[] = [];
    const f = async (u: string) => {
      const p = new URL(u).pathname;
      asked.push(p);
      if (p === "/health") return json({ round: 2 });
      const { ballotList: _hidden, ...open } = page(2, "open");
      return json(p.endsWith("2") ? open : page(1, "closed"));
    };
    const c = roundsCalls("http://t", f);
    await c.rounds();
    await c.rounds();
    expect(asked.filter((p) => p.endsWith("/rounds/1"))).toHaveLength(1);
    expect(asked.filter((p) => p.endsWith("/rounds/2"))).toHaveLength(2);
  });

  it("asks for a wallet's view, treats 404 as no round, and fails on anything else", async () => {
    let asked = "";
    const body = { round: 6, status: "open", closesAt: 5, seats: 3, you: { weight: 1, ballot: null } };
    await roundsCalls("http://t", async (u) => ((asked = u), json(body))).you(WALLET);
    expect(asked).toBe(`http://t/trials/current?voter=${WALLET}`);
    expect(await roundsCalls("http://t", async () => json({}, 404)).you(WALLET)).toBeNull();
    await expect(roundsCalls("http://t", async () => json({}, 500)).you(WALLET)).rejects.toThrow("500");
    await expect(roundsCalls("http://t", async () => json({ nope: 1 })).you(WALLET)).rejects.toThrow();
  });

  it("copes with no rounds at all", async () => {
    expect(await roundsCalls("http://t", async () => json({ round: null })).rounds()).toEqual([]);
  });
});

describe("asking the server", () => {
  const v = verdicts();

  it("answers with the record and the ballot status", async () => {
    const r = new RecordReader(v, calls([round(3, [ballot(WALLET, [PACT])])]), inBasket, { now: () => AFTER });
    const app = buildApp(v, { record: r });
    expect((await app.inject({ url: `/wallets/${WALLET}/record` })).json()).toMatchObject({ totals: { picks: 1 } });
    expect((await app.inject({ url: `/wallets/${WALLET}/ballot` })).json()).toMatchObject({ canVote: false, whyNot: "NO_ROUND" });
  });

  it("refuses a bad address, and answers 503 when Trials is down, without saying why", async () => {
    const down = () => Promise.reject(new Error("detail"));
    const app = buildApp(v, { record: new RecordReader(v, calls([], { rounds: down, you: down }), inBasket) });
    expect((await app.inject({ url: "/wallets/nope/record" })).statusCode).toBe(400);
    for (const path of ["record", "ballot"]) {
      const res = await app.inject({ url: `/wallets/${WALLET}/${path}` });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: "TRIALS_UNAVAILABLE" });
    }
  });
});
