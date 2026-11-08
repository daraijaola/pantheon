import assert from "node:assert/strict";
import { test } from "node:test";
import type { TrialRound } from "./trials";
const { trialsAction, roundDate, trialRoundAt } = await import(new URL("./trials.ts", import.meta.url).href) as typeof import("./trials");

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
