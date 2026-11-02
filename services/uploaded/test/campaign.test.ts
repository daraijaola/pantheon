// Campaigns, with made-up rounds: no network. The vote maths is checked against a recount of its own.
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/api.ts";
import { CampaignReader, campaignOf, votesNeeded } from "../src/campaign.ts";
import type { Candidate, RoundNow } from "../src/trials.ts";
import { Verdicts } from "../src/verdicts.ts";

const FIXTURE = new URL("./fixtures/scan.json", import.meta.url).pathname;
type C = { token: string; votes: number; rank: number };
const c = (token: string, votes: number, rank: number): C => ({ token, votes, rank });
const need = (token: string, all: C[], seats = 3) => votesNeeded(all.find((x) => x.token === token)!, all, seats);

/** The Trials service's rule, written out separately: the top seats with at least one vote. */
const seatsOf = (all: C[], seats: number) =>
  [...all]
    .sort((a, b) => b.votes - a.votes || a.rank - b.rank)
    .filter((x) => x.votes > 0)
    .slice(0, seats)
    .map((x) => x.token);

describe("votes needed for a seat", () => {
  const all = [c("a", 10, 4), c("b", 8, 2), c("c", 6, 3), c("d", 4, 1), c("e", 4, 5), c("f", 0, 6)];

  it("is 0 for a coin in a seat", () => {
    for (const t of ["a", "b", "c"]) expect(need(t, all)).toBe(0);
  });

  it("is the gap to the last seat, plus one to pass it", () => {
    expect(need("e", all)).toBe(3); // 4 to 7, past c's 6
    expect(need("f", all)).toBe(7);
  });

  it("needs one less when equal votes would go its way", () => {
    expect(need("d", all)).toBe(2); // 4 to 6 ties c, and d's rank is better
  });

  it("wins a tie for free if its rank is better", () => {
    const tied = [c("x", 5, 1), c("y", 5, 2)];
    expect(need("x", tied, 1)).toBe(0);
    expect(need("y", tied, 1)).toBe(1);
  });

  it("needs just one vote for a free seat, and none if it already has votes", () => {
    const few = [c("a", 5, 1), c("b", 0, 2), c("c", 0, 3)];
    expect(need("a", few)).toBe(0);
    expect(need("b", few)).toBe(1);
    expect(need("c", few)).toBe(1);
  });

  it("works with nobody voting yet", () => {
    expect(need("a", [c("a", 0, 1), c("b", 0, 2)])).toBe(1);
  });

  it("leaves coins in by trading out of the vote (from round 6)", () => {
    const t = (token: string, votes: number, rank: number) => ({ ...c(token, votes, rank), inByTrading: true });
    const all = [t("t1", 50, 1), t("t2", 0, 2), c("a", 6, 3), c("b", 4, 4), c("d", 1, 5)];
    expect(need("t1", all, 2)).toBe(0);
    expect(need("t2", all, 2)).toBe(0);
    expect(need("a", all, 2)).toBe(0); // the coin in by trading takes no vote seat
    expect(need("b", all, 2)).toBe(0);
    expect(need("d", all, 2)).toBe(4); // 1 to 5, past b's 4
  });

  it("is exact on 3,000 random rounds: that many takes the seat, one less doesn't", () => {
    const rand = (n: number) => Math.floor(Math.random() * n);
    for (let i = 0; i < 3_000; i++) {
      const size = 2 + rand(12);
      const ranks = Array.from({ length: size }, (_, k) => k + 1).sort(() => Math.random() - 0.5);
      const round = ranks.map((rank, k) => c(`t${k}`, rand(4) === 0 ? 0 : rand(12), rank));
      const seats = 1 + rand(4);
      for (const coin of round) {
        const n = votesNeeded(coin, round, seats);
        const add = (extra: number) => seatsOf(round.map((x) => (x === coin ? { ...x, votes: x.votes + extra } : x)), seats);
        expect(add(n), JSON.stringify({ round, seats, coin, n })).toContain(coin.token);
        if (n > 0) expect(add(n - 1), JSON.stringify({ round, seats, coin, n })).not.toContain(coin.token);
      }
    }
  });
});

const TOKEN = "0x" + "a".repeat(40);
const candidate = (over: Partial<Candidate> = {}): Candidate => ({
  token: TOKEN,
  symbol: "AAA",
  votes: 4,
  voters: 3,
  rank: 2,
  inSeat: false,
  inByTrading: false,
  launchedAt: "2026-10-01T00:00:00.000Z",
  verdict: "CLEAN",
  verdictAtOpen: "CLEAN",
  verdictChanged: false,
  reason: "Clean so far: every check passed.",
  reportUrl: "https://pantheonindex.com/delphi/x",
  disputeUrl: "https://pantheonindex.com/delphi/dispute?token=x",
  stale: false,
  ...over,
});
const round = (candidates: Candidate[], over: Partial<RoundNow> = {}): RoundNow => ({
  round: 6,
  status: "open",
  opensAt: "2026-11-02T00:00:00.000Z",
  closesAt: "2026-11-05T00:00:00.000Z",
  secondsLeft: 100,
  seats: 1,
  tradingSeats: null,
  minStake: null,
  minHoldSec: null,
  ballots: 5,
  method: "m",
  candidates,
  ...over,
});
const leader = candidate({ token: "0x" + "b".repeat(40), symbol: "BBB", votes: 9, rank: 1, inSeat: true });

describe("a campaign", () => {
  it("gives the numbers for the page", () => {
    const got = campaignOf(round([leader, candidate()]), candidate());
    expect(got).toMatchObject({ round: 6, token: TOKEN, symbol: "AAA", status: "open", secondsLeft: 100, seats: 1, votes: 4, voters: 3, inSeat: false, votesNeeded: 6, verdict: "CLEAN", disputeUrl: "https://pantheonindex.com/delphi/dispute?token=x" });
  });

  it("writes a card for a coin chasing a seat", () => {
    expect(campaignOf(round([leader, candidate()]), candidate()).share).toEqual({
      title: "AAA needs 6 more votes for a seat in Trials round 6",
      lines: ["4 votes from 3 wallets", "DELPHI: CLEAN", "Clean so far: every check passed."],
      url: "https://pantheonindex.com/trials",
    });
  });

  it("gets the words right for one vote, one wallet, and no name", () => {
    const one = candidate({ votes: 8, voters: 1, symbol: null, rank: 3 });
    const others = [leader, one];
    const got = campaignOf(round(others), one);
    expect(got.share.title).toBe("0xaaaa…aaaa needs 2 more votes for a seat in Trials round 6");
    expect(got.share.lines[0]).toBe("8 votes from 1 wallet");
    const near = candidate({ votes: 9, rank: 3 });
    expect(campaignOf(round([leader, near]), near).share.title).toBe("AAA needs 1 more vote for a seat in Trials round 6");
  });

  it("writes a card for a coin in a seat, and after the round", () => {
    expect(campaignOf(round([leader]), leader).share.title).toBe("BBB is in a seat in Trials round 6");
    const closed = round([leader, candidate()], { status: "closed", secondsLeft: 0 });
    expect(campaignOf(closed, leader).share.title).toBe("BBB took a seat in Trials round 6");
    expect(campaignOf(closed, candidate()).share.title).toBe("AAA didn't take a seat in Trials round 6");
  });

  it("writes a card for a coin in by trading, and says it needs no votes", () => {
    const fixed = candidate({ inByTrading: true });
    const got = campaignOf(round([leader, fixed]), fixed);
    expect(got).toMatchObject({ inByTrading: true, votesNeeded: 0 });
    expect(got.share.title).toBe("AAA is in by trading in Trials round 6");
  });

  it("has no votes needed once voting is over", () => {
    expect(campaignOf(round([candidate()], { status: "closed", secondsLeft: 0 }), candidate()).votesNeeded).toBeNull();
  });

  it("always shows DELPHI's verdict on the card, even a flagged coin's", () => {
    const bad = candidate({ verdict: "FLAG", reason: "3 linked wallets bought 16.8% of the supply.", verdictChanged: true });
    const got = campaignOf(round([bad]), bad);
    expect(got.share.lines).toContain("DELPHI: FLAG");
    expect(got.share.lines).toContain("3 linked wallets bought 16.8% of the supply.");
    expect(campaignOf(round([candidate({ verdict: "NOT_ENOUGH_DATA" })]), candidate({ verdict: "NOT_ENOUGH_DATA" })).share.lines).toContain("DELPHI: NOT ENOUGH DATA");
  });

  it("never tells anyone to buy or vote", () => {
    const got = JSON.stringify(campaignOf(round([leader, candidate()]), candidate()).share);
    expect(got).not.toMatch(/\bbuy\b|\bvote for\b|\bvote now\b/i);
  });

  it("has no referral link: the same for everyone, nothing added to it", () => {
    const got = campaignOf(round([candidate()]), candidate()).share.url;
    expect(got).toBe("https://pantheonindex.com/trials");
    expect(got).not.toMatch(/[?&#]|ref/);
  });
});

describe("reading campaigns", () => {
  const r = (x: RoundNow | null) => new CampaignReader({ read: async () => x });

  it("lists every candidate, and finds one however its address is written", async () => {
    const reader = r(round([leader, candidate()]));
    expect(await reader.all()).toHaveLength(2);
    expect((await reader.one(TOKEN.toUpperCase().replace("0X", "0x")))?.symbol).toBe("AAA");
  });

  it("says when there's no round, or a coin isn't a candidate", async () => {
    expect(await r(null).all()).toBeNull();
    expect(await r(null).one(TOKEN)).toBeNull();
    expect(await r(round([leader])).one(TOKEN)).toBeNull();
  });
});

describe("asking the server", () => {
  const v = new Verdicts(FIXTURE);
  const app = (x: RoundNow | null, fail = false) => buildApp(v, { campaigns: new CampaignReader({ read: async () => (fail ? Promise.reject(new Error("detail")) : x) }) });

  it("answers with all of them, or one", async () => {
    const a = app(round([leader, candidate()]));
    const list = await a.inject({ url: "/trials/campaigns" });
    expect(list.statusCode).toBe(200);
    expect(list.headers["cache-control"]).toBe("no-store");
    expect(list.json()).toHaveLength(2);
    expect((await a.inject({ url: `/trials/campaigns/${TOKEN}` })).json()).toMatchObject({ symbol: "AAA", votesNeeded: 6 });
  });

  it("says plainly what's missing or wrong", async () => {
    expect((await app(null).inject({ url: "/trials/campaigns" })).json()).toEqual({ error: "NO_ROUND" });
    const notThere = await app(round([leader])).inject({ url: `/trials/campaigns/${TOKEN}` });
    expect(notThere.statusCode).toBe(404);
    expect(notThere.json()).toEqual({ error: "NOT_A_CANDIDATE" });
    expect((await app(null).inject({ url: "/trials/campaigns/nope" })).statusCode).toBe(400);
  });

  it("answers 503 when Trials is down, without saying why", async () => {
    const res = await app(null, true).inject({ url: "/trials/campaigns" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "TRIALS_UNAVAILABLE" });
  });
});
