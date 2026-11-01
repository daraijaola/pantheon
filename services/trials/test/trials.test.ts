import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { MIN_STAKE, problem, signer, weightOf, type BallotInput } from "../src/ballot.ts";
import { loadRounds, statusOf } from "../src/round.ts";
import { Ballots } from "../src/state.ts";
import { tally, winners } from "../src/tally.ts";
import { A, app, B, ballot, C, CHAIN, coin, D, round, signed, standing, T0 } from "./fixtures.ts";

describe("round files", () => {
  it("loads rounds oldest first and refuses a file that doesn't match its name or lists a coin twice", () => {
    const dir = mkdtempSync(join(tmpdir(), "trials-"));
    writeFileSync(join(dir, "round-3.vote.json"), JSON.stringify(round()));
    writeFileSync(join(dir, "round-1.json"), "{}"); // a proposal file, not a vote: ignored
    expect(loadRounds(dir).map((r) => r.round)).toEqual([3]);
    writeFileSync(join(dir, "round-4.vote.json"), JSON.stringify(round()));
    expect(() => loadRounds(dir)).toThrow(/says it is round 3/);
    const twice = round({ round: 4 });
    twice.candidates.push(twice.candidates[0]!);
    writeFileSync(join(dir, "round-4.vote.json"), JSON.stringify(twice));
    expect(() => loadRounds(dir)).toThrow(/listed twice/);
    expect(loadRounds(join(dir, "missing"))).toEqual([]);
  });

  it("knows when it is open", () => {
    expect(statusOf(round(), T0 - 1)).toBe("upcoming");
    expect(statusOf(round(), T0)).toBe("open");
    expect(statusOf(round(), T0 + 86_400)).toBe("closed");
  });
});

describe("ballots", () => {
  const b = (over: Partial<BallotInput>): BallotInput => ({ round: 3, voter: coin(1), coins: [A], signedAt: T0 + 100, signature: "0x", ...over });

  it("names what's wrong with a ballot", () => {
    const r = round();
    expect(problem(r, b({}), T0 + 100)).toBeNull();
    expect(problem(r, b({ round: 2 }), T0 + 100)).toBe("WRONG_ROUND");
    expect(problem(r, b({}), T0 - 10)).toBe("NOT_OPEN");
    expect(problem(r, b({ signedAt: T0 + 86_400 }), T0 + 86_400)).toBe("CLOSED");
    expect(problem(r, b({ signedAt: T0 }), T0 + 1_000)).toBe("STALE_SIGNATURE");
    expect(problem(r, b({ coins: [A, B, C, D] }), T0 + 100)).toBe("TOO_MANY_COINS");
    expect(problem(r, b({ coins: [A, A] }), T0 + 100)).toBe("DUPLICATE_COIN");
    expect(problem(r, b({ coins: [coin(0xee)] }), T0 + 100)).toBe("NOT_A_CANDIDATE");
  });

  it("recovers the wallet that signed", async () => {
    const key = generatePrivateKey();
    const s = await signed(key, [A, B]);
    expect(await signer(CHAIN, s)).toBe(privateKeyToAccount(key).address);
    // the same signature for different coins, or another chain, points to someone else
    expect(await signer(CHAIN, { ...s, coins: [A, C] })).not.toBe(s.voter);
    expect(await signer(1, s)).not.toBe(s.voter);
  });
});

describe("counting", () => {
  it("gives 1 vote for staking PNTH and 1, 2 or 3 more for a Passport", () => {
    const pnth = (n: bigint) => n * 10n ** 18n;
    expect(weightOf({ staked: 0n, tier: 0 })).toBe(0);
    expect(weightOf({ staked: MIN_STAKE - 1n, tier: 0 })).toBe(0);
    expect(weightOf({ staked: MIN_STAKE, tier: 0 })).toBe(1);
    expect(weightOf({ staked: pnth(10_000n), tier: 0 })).toBe(1); // one wallet, one vote, however much it stakes
    expect(weightOf({ staked: 0n, tier: 2 })).toBe(2);
    expect(weightOf({ staked: pnth(1n), tier: 3 })).toBe(4);
  });

  it("weighs each ballot, and breaks ties by independent trading", () => {
    const r = round();
    const all = [ballot(coin(1), [D, C], 3), ballot(coin(2), [C, B], 1), ballot(coin(3), [B], 2)];
    expect(tally(r, all).map((c) => [c.token, c.votes, c.voters])).toEqual([
      [C, 4, 2],
      [B, 3, 2],
      [D, 3, 1],
      [A, 0, 0],
    ]);
    // B and D tie on 3 votes; B trades more (rank 2 before rank 4)
    expect(winners(r, all)).toEqual([C, B, D]);
  });

  it("only coins with votes win seats", () => {
    expect(winners(round(), [ballot(coin(1), [B], 1)])).toEqual([B]);
    expect(winners(round(), [])).toEqual([]);
  });
});

describe("the ballot box", () => {
  it("keeps one ballot per voter, takes newer ones, and survives a restart", () => {
    const file = join(mkdtempSync(join(tmpdir(), "trials-")), "sub", "ballots.json");
    const box = new Ballots(file);
    expect(box.put(3, ballot(coin(1), [A], 1, T0 + 10))).toBe("added");
    expect(box.put(3, ballot(coin(1), [B], 1, T0 + 20))).toBe("replaced");
    expect(box.put(3, ballot(coin(1), [C], 1, T0 + 15))).toBe("older");
    expect(new Ballots(file).get(3, coin(1).toLowerCase())?.coins).toEqual([B]);
    expect(new Ballots(file).of(4)).toEqual([]);
  });
});

describe("the API", () => {
  it("takes a signed ballot from a staker with a Passport and counts it", async () => {
    const key = generatePrivateKey();
    const voter = privateKeyToAccount(key).address;
    const { a } = app({ [voter.toLowerCase()]: standing(MIN_STAKE, 1) });
    const res = await a.inject({ method: "POST", url: "/trials/vote", payload: await signed(key, [C, A]) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, result: "added", ballot: { weight: 2, staked: MIN_STAKE.toString(), tier: 1, coins: [C, A] } });
    const cur = (await a.inject({ url: `/trials/current?voter=${voter}` })).json();
    // C and A tie on 2 votes each; A has more independent trading, so it leads
    expect(cur).toMatchObject({ round: 3, status: "open", ballots: 1, leaders: [A, C], you: { weight: 2, tier: 1, ballot: { coins: [C, A] } } });
    expect(cur.candidates.slice(0, 2).map((c: { token: string; votes: number }) => [c.token, c.votes])).toEqual([
      [A, 2],
      [C, 2],
    ]);
    const full = (await a.inject({ url: "/trials/rounds/3" })).json();
    expect(full.ballotList).toHaveLength(1);
    expect(full.ballotList[0].signature).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it("takes a staker with no Passport as 1 vote", async () => {
    const key = generatePrivateKey();
    const voter = privateKeyToAccount(key).address;
    const { a } = app({ [voter.toLowerCase()]: standing(MIN_STAKE, 0) });
    expect((await a.inject({ url: `/trials/current?voter=${voter}` })).json().you).toMatchObject({ weight: 1, staked: MIN_STAKE.toString(), tier: 0, ballot: null });
    expect((await a.inject({ method: "POST", url: "/trials/vote", payload: await signed(key, [B]) })).json()).toMatchObject({ ok: true, ballot: { weight: 1 } });
    expect((await a.inject({ url: "/trials/current" })).json().leaders).toEqual([B]);
  });

  it("refuses wallets with nothing staked and no Passport, forged signatures and closed rounds", async () => {
    const key = generatePrivateKey();
    const { a } = app({ [privateKeyToAccount(key).address.toLowerCase()]: standing(MIN_STAKE - 1n, 0) });
    const none = await a.inject({ method: "POST", url: "/trials/vote", payload: await signed(key, [A]) });
    expect([none.statusCode, none.json()]).toEqual([403, { error: "NO_VOTES" }]);

    const other = privateKeyToAccount(generatePrivateKey()).address;
    const forged = { ...(await signed(key, [A])), voter: other };
    const r2 = await a.inject({ method: "POST", url: "/trials/vote", payload: forged });
    expect([r2.statusCode, r2.json()]).toEqual([400, { error: "BAD_SIGNATURE" }]);

    const late = app({}, T0 + 90_000).a;
    expect((await late.inject({ method: "POST", url: "/trials/vote", payload: await signed(key, [A], { signedAt: T0 + 90_000 }) })).json()).toEqual({
      error: "CLOSED",
    });
    expect((await a.inject({ method: "POST", url: "/trials/vote", payload: { round: 3 } })).statusCode).toBe(400);
  });

  it("limits how often one visitor can send ballots", async () => {
    const { a } = app();
    let last = 0;
    for (let i = 0; i < 13; i++) last = (await a.inject({ method: "POST", url: "/trials/vote", payload: {} })).statusCode;
    expect(last).toBe(429);
  });
});
