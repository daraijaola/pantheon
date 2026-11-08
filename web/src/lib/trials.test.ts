import assert from "node:assert/strict";
import { test } from "node:test";
import type { TrialRound } from "./trials";
const { trialsAction, roundDate } = await import(new URL("./trials.ts", import.meta.url).href) as typeof import("./trials");

for (const [status, expected] of [["open", "Vote now"], ["closed", "See round 5 results"], ["upcoming", "Round 5 opens soon"]] as const) {
  test(`Trials action respects ${status} state`, () => assert.equal(trialsAction({ status, round: 5 } as TrialRound), expected));
}
test("An unreadable or absent round never advertises voting", () => assert.equal(trialsAction(null), "See the latest round"));
test("Round dates have an explicit stable timezone", () => assert.match(roundDate(1794000000), /UTC$/));
