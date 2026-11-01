// The rules added after round 5, each switched on by its own field in the round file, and proof that a
// round without those fields still counts exactly as rounds 1 to 5 did.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { problem, type Ballot, type BallotInput } from "../src/ballot.ts";
import { loadRounds, RoundDef } from "../src/round.ts";
import { basketList, inByTrading, tally, winners } from "../src/tally.ts";
import { A, app, B, ballot, C, coin, k, ks, ranked, round, signed, T0 } from "./fixtures.ts";

const pnth = (n: bigint) => n * 10n ** 18n;
const voterOf = (key: `0x${string}`) => privateKeyToAccount(key).address;
const pickOf = (over: Partial<BallotInput>): BallotInput => ({ round: 3, voter: coin(1), coins: [A], signedAt: T0 + 100, signature: "0x", ...over });

describe("rounds 1 to 5 count as they always did", () => {
  const DEPLOYED = fileURLToPath(new URL("../../../deployments/trials/", import.meta.url));

  it("recounts the committed rounds to the winners and counts they were proposed with", () => {
    const rounds = loadRounds(DEPLOYED); // every committed round file still loads
    expect(rounds.map((r) => r.round)).toEqual(expect.arrayContaining([3, 4, 5]));
    for (const n of [3, 4]) {
      const def = rounds.find((r) => r.round === n)!;
      const vote = JSON.parse(readFileSync(join(DEPLOYED, `round-${n}.json`), "utf8")).vote as { winners: string[]; tally: unknown; ballots: Ballot[] };
      expect(def.tradingSeats).toBeUndefined();
      expect(winners(def, vote.ballots)).toEqual(vote.winners);
      expect(tally(def, vote.ballots)).toEqual(vote.tally);
    }
    // round 4's list: its 3 winners, then the most trading, 10 coins: exactly the coins proposed
    const file = JSON.parse(readFileSync(join(DEPLOYED, "round-4.json"), "utf8")) as { tokens: string[]; vote: { ballots: Ballot[] } };
    const list = basketList(rounds.find((r) => r.round === 4)!, file.vote.ballots, 10);
    expect(list.inByTrading).toEqual([]);
    expect([...list.winners, ...list.byTrading].sort()).toEqual([...file.tokens].sort());
  });

  it("recounts a round-4-style vote to the same winners and list as before", () => {
    // 17 candidates and 24 ballots, nearly all for the top 3 by trading, so the vote decided nothing
    const r4 = round({ round: 4, candidates: ranked(17) });
    const all = [
      ...Array.from({ length: 19 }, (_, i) => ballot(coin(i + 1), ks(1, 2, 3), 1)),
      ballot(coin(20), ks(1, 2), 1),
      ...Array.from({ length: 3 }, (_, i) => ballot(coin(21 + i), ks(1), 1)),
      ballot(coin(24), ks(10, 9, 8), 1),
    ];
    expect(
      tally(r4, all)
        .slice(0, 6)
        .map((c) => [c.rank, c.votes]),
    ).toEqual([
      [1, 23],
      [2, 20],
      [3, 19],
      [8, 1],
      [9, 1],
      [10, 1],
    ]);
    expect(winners(r4, all)).toEqual(ks(1, 2, 3));
    expect(basketList(r4, all, 10)).toEqual({ inByTrading: [], winners: ks(1, 2, 3), byTrading: ks(4, 5, 6, 7, 8, 9, 10) });
  });

  it("lets a ballot pick any candidate, the best trading included", () => {
    expect(inByTrading(round())).toEqual([]);
    expect(problem(round(), pickOf({ coins: [A, B, C] }), T0 + 100)).toBeNull();
  });

  it("shows an old round as before, with every coin marked not in by trading", async () => {
    const { a } = app();
    const cur = (await a.inject({ url: "/trials/current" })).json();
    expect(cur).not.toHaveProperty("tradingSeats");
    expect(cur.candidates.map((c: { inByTrading: boolean }) => c.inByTrading)).toEqual([false, false, false, false]);
    const full = (await a.inject({ url: "/trials/rounds/3" })).json();
    expect(full.candidates.map((c: { inByTrading: boolean }) => c.inByTrading)).toEqual([false, false, false, false]);
  });
});

describe("seats in by trading", () => {
  // 10 candidates: the top 4 by trading are in, and the vote fills 3 seats from the other 6
  const r = round({ tradingSeats: 4, candidates: ranked(10) });

  it("goes by rank, not by the order the file lists the coins in", () => {
    expect(inByTrading(r)).toEqual(ks(1, 2, 3, 4));
    expect(inByTrading(round({ tradingSeats: 0 }))).toEqual([]);
    const backwards = round({ tradingSeats: 2, seats: 2, candidates: [...ranked(5)].reverse() });
    expect(inByTrading(backwards)).toEqual(ks(1, 2));
    expect(basketList(backwards, [], 4)).toEqual({ inByTrading: ks(1, 2), winners: [], byTrading: ks(3, 4) });
  });

  it("gives the vote seats to the most-voted coins among the rest; equal votes go to the better rank", () => {
    const all = [ballot(coin(1), ks(9, 6), 1), ballot(coin(2), ks(9), 2), ballot(coin(3), ks(7, 6), 1), ballot(coin(4), ks(8), 1)];
    // 9 has 3 votes, 6 has 2, and 7 and 8 have 1 each: 7 trades more
    expect(winners(r, all)).toEqual(ks(9, 6, 7));
  });

  it("lets a vote for a coin in by trading decide nothing", () => {
    // the API refuses such a ballot (ALREADY_IN), but if one were counted it couldn't take a vote seat
    expect(winners(r, [ballot(coin(1), ks(1, 8), 5)])).toEqual(ks(8));
  });

  it("fills the vote seats nobody won by trading rank, then the list up to its size", () => {
    expect(basketList(r, [ballot(coin(1), ks(10), 1)], 7)).toEqual({ inByTrading: ks(1, 2, 3, 4), winners: ks(10), byTrading: ks(5, 6) });
    expect(basketList(r, [], 7)).toEqual({ inByTrading: ks(1, 2, 3, 4), winners: [], byTrading: ks(5, 6, 7) });
    expect(basketList(r, [ballot(coin(1), ks(10, 9, 8), 1)], 9)).toEqual({ inByTrading: ks(1, 2, 3, 4), winners: ks(8, 9, 10), byTrading: ks(5, 6) });
  });

  it("lets the vote change a round-4-style basket", () => {
    // the top 7 are in by trading; the voters pick from ranks 8 to 17, and their picks get in
    const r6 = round({ round: 6, tradingSeats: 7, candidates: ranked(17) });
    const all = [ballot(coin(1), ks(12, 15), 1), ballot(coin(2), ks(15, 12), 1), ballot(coin(3), ks(9), 1)];
    expect(winners(r6, all)).toEqual(ks(12, 15, 9));
    expect(basketList(r6, all, 10)).toEqual({ inByTrading: ks(1, 2, 3, 4, 5, 6, 7), winners: ks(12, 15, 9), byTrading: [] });
  });

  it("copes with fewer coins than seats, and with every coin in by trading", () => {
    const few = round({ tradingSeats: 0, candidates: ranked(2) });
    expect(basketList(few, [ballot(coin(1), ks(2), 1)], 10)).toEqual({ inByTrading: [], winners: ks(2), byTrading: ks(1) });
    const all = round({ tradingSeats: 6, candidates: ranked(4) });
    expect(basketList(all, [ballot(coin(1), ks(3), 1)], 10)).toEqual({ inByTrading: ks(1, 2, 3, 4), winners: [], byTrading: [] });
  });

  it("refuses a ballot that picks a coin in by trading", () => {
    expect(problem(r, pickOf({ coins: ks(5, 1) }), T0 + 100)).toBe("ALREADY_IN");
    expect(problem(r, pickOf({ coins: ks(4) }), T0 + 100)).toBe("ALREADY_IN");
    expect(problem(r, pickOf({ coins: ks(5, 10) }), T0 + 100)).toBeNull();
    // the older checks come first
    expect(problem(r, pickOf({ coins: [k(1), coin(0xee)] }), T0 + 100)).toBe("NOT_A_CANDIDATE");
  });

  it("needs a whole number of seats, and every coin on its own rank", () => {
    expect(RoundDef.safeParse(r).success).toBe(true);
    expect(RoundDef.safeParse({ ...r, tradingSeats: -1 }).success).toBe(false);
    expect(RoundDef.safeParse({ ...r, tradingSeats: 1.5 }).success).toBe(false);
    const shared = { ...r, candidates: r.candidates.map((c) => (c.rank === 2 ? { ...c, rank: 1 } : c)) };
    expect(RoundDef.safeParse(shared).error?.issues.map((i) => i.message)).toEqual(["two coins share a rank"]);
    // a round without the field never cared about ranks being distinct, and still doesn't
    expect(RoundDef.safeParse({ ...shared, tradingSeats: undefined }).success).toBe(true);
  });
});

describe("the API, from round 6", () => {
  const r = round({ tradingSeats: 4, candidates: ranked(10) });

  it("marks the coins in by trading, refuses votes for them and leads with the rest", async () => {
    const key = generatePrivateKey();
    const { a } = app({ [voterOf(key).toLowerCase()]: { staked: pnth(100n), tier: 0 } }, T0 + 100, [r]);
    const cur = (await a.inject({ url: "/trials/current" })).json();
    expect(cur).toMatchObject({ tradingSeats: 4, leaders: [] });
    const marked = cur.candidates.filter((c: { inByTrading: boolean }) => c.inByTrading).map((c: { token: string }) => c.token);
    expect(marked).toEqual(ks(1, 2, 3, 4));

    const refused = await a.inject({ method: "POST", url: "/trials/vote", payload: await signed(key, ks(6, 2)) });
    expect([refused.statusCode, refused.json()]).toEqual([400, { error: "ALREADY_IN" }]);
    expect((await a.inject({ method: "POST", url: "/trials/vote", payload: await signed(key, ks(8, 6)) })).json()).toMatchObject({ ok: true, ballot: { weight: 1 } });
    expect((await a.inject({ url: "/trials/current" })).json().leaders).toEqual(ks(6, 8));
    const full = (await a.inject({ url: "/trials/rounds/3" })).json();
    expect(full.candidates.filter((c: { inByTrading: boolean }) => c.inByTrading).map((c: { token: string }) => c.token)).toEqual(ks(1, 2, 3, 4));
  });
});
