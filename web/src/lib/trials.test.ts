import assert from "node:assert/strict";
import { test } from "node:test";
import type { TrialRound, TrialRoundSnapshot } from "./trials";
const { trialsAction, roundDate, trialRoundAt, resolveTrialRound } = await import(new URL("./trials.ts", import.meta.url).href) as typeof import("./trials");

for (const [status, expected] of [["open", "Vote now"], ["closed", "See round 5 results"], ["upcoming", "Round 5 opens soon"]] as const) {
  test(`Trials action respects ${status} state`, () => assert.equal(trialsAction({ status, round: 5 } as TrialRound), expected));
}
test("An unreadable or absent round never advertises voting", () => assert.equal(trialsAction(null), "See the latest round"));
test("Round dates have an explicit stable timezone", () => assert.match(roundDate(1794000000), /UTC$/));

for (const status of ["upcoming", "open", "closed"] as const) {
  for (const [now, expected] of [[99, "upcoming"], [100, "open"], [199.999, "open"], [200, "closed"], [201, "closed"]] as const) {
    test(`Cached ${status} round reflects request time ${now} as ${expected}`, () => {
      const cached = { status, round: 5, opensAt: 100, closesAt: 200, ballots: 7 } as TrialRound;
      const current = trialRoundAt(cached, now)!;
      assert.equal(current.status, expected);
      assert.equal(current.ballots, 7);
      assert.equal(cached.status, status);
      assert.equal(trialsAction(current), expected === "open" ? "Vote now" : expected === "closed" ? "See round 5 results" : "Round 5 opens soon");
    });
  }
}
test("Missing round data stays unavailable at request time", () => assert.equal(trialRoundAt(null, 100), null));

const snapshot = (fetchedAt: number): TrialRoundSnapshot => ({ fetchedAt, round: { round: 5, status: "open", opensAt: 100, closesAt: 200, seats: 1, candidates: [], leaders: [], ballots: 7 } });
const unexpectedRefresh = async (): Promise<never> => { throw new Error("Unexpected refresh"); };

test("An open snapshot needs no extra fetch before closing", async () => {
  assert.equal((await resolveTrialRound(snapshot(100), 199, unexpectedRefresh))?.status, "open");
});
for (const now of [200, 201]) {
  test(`Pre-close counts and leaders are refreshed before showing results at ${now}`, async () => {
    const cached = snapshot(100);
    const fresh = snapshot(200);
    fresh.round.ballots = 9;
    fresh.round.leaders = ["0x1111111111111111111111111111111111111111"];
    let calls = 0;
    const result = await resolveTrialRound(cached, now, async (round) => {
      calls++;
      assert.equal(round.round, 5);
      assert.equal(round.closesAt, 200);
      return fresh;
    });
    assert.equal(calls, 1);
    assert.equal(result?.status, "closed");
    assert.equal(result?.ballots, 9);
    assert.deepEqual(result?.leaders, fresh.round.leaders);
    assert.equal(cached.round.ballots, 7);
  });
}
test("A post-close snapshot needs no extra fetch", async () => {
  assert.equal((await resolveTrialRound(snapshot(200), 201, unexpectedRefresh))?.status, "closed");
});
test("A failed post-close fetch never promotes provisional tallies to final results", async () => {
  const result = await resolveTrialRound(snapshot(199), 201, async () => null);
  assert.equal(result, null);
  assert.equal(trialsAction(result), "See the latest round");
});
test("A refresh still predating close is not final", async () => {
  assert.equal(await resolveTrialRound(snapshot(100), 201, async () => snapshot(199)), null);
});
test("Missing snapshots retain the unavailable fallback without another fetch", async () => {
  assert.equal(await resolveTrialRound(null, 201, unexpectedRefresh), null);
});
test("A refreshed next round uses its own window instead of the old closed status", async () => {
  const next = snapshot(200);
  next.round = { ...next.round, round: 6, opensAt: 300, closesAt: 400 };
  assert.equal((await resolveTrialRound(snapshot(100), 201, async () => next))?.status, "upcoming");
});
