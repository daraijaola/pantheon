import assert from "node:assert/strict";
import { test } from "node:test";

const { readStakeWindow, stakeWindowState, assertStakeWindowOpen } = await import(new URL("./stake-window.ts", import.meta.url).href) as typeof import("./stake-window");
const window = { start: 1794247200, end: 1794248400 };

test("window accepts Unix seconds and timezone-explicit ISO timestamps", () => {
  assert.deepEqual(readStakeWindow({ STAKING_WINDOW_START: String(window.start), STAKING_WINDOW_END: String(window.end) }), window);
  assert.deepEqual(readStakeWindow({ STAKING_WINDOW_START: new Date(window.start * 1000).toISOString(), STAKING_WINDOW_END: new Date(window.end * 1000).toISOString() }), window);
  assert.deepEqual(readStakeWindow({ STAKING_WINDOW_START: "2026-11-09T20:00:00+02:00", STAKING_WINDOW_END: "2026-11-09T20:20:00+02:00" }), { start: Date.parse("2026-11-09T18:00:00Z") / 1000, end: Date.parse("2026-11-09T18:20:00Z") / 1000 });
});
test("missing, invalid or non-20-minute configuration fails closed", () => {
  for (const env of [{}, { STAKING_WINDOW_START: String(window.start) }, { STAKING_WINDOW_END: String(window.end) }, ...["", "junk", "Infinity", "-1", "1794247200000", "2026-02-30T18:00:00Z", "2026-11-09T18:00:00", "2026-11-09T18:00:00.001Z"].map(value => ({ STAKING_WINDOW_START: value, STAKING_WINDOW_END: String(window.end) })), ...[window.start, window.start - 1, window.end - 1, window.end + 1].map(end => ({ STAKING_WINDOW_START: String(window.start), STAKING_WINDOW_END: String(end) }))]) assert.equal(readStakeWindow(env), null);
  assert.equal(stakeWindowState(null, window.start), "unconfigured");
  assert.equal(stakeWindowState(window, NaN), "unconfigured");
});
test("start is inclusive, end is exclusive and an expired window never reopens", () => {
  for (const [now, state] of [[window.start - 1, "before"], [window.start, "open"], [window.end - 1, "open"], [window.end, "closed"], [window.end + 86400, "closed"]] as const) assert.equal(stakeWindowState(window, now), state);
});
test("send guard rechecks time after approval and fails closed outside the window", () => {
  assert.doesNotThrow(() => assertStakeWindowOpen(window, window.start));
  for (const now of [window.start - 1, window.end, window.end + 1]) assert.throws(() => assertStakeWindowOpen(window, now), /Staking window is not open/);
  assert.throws(() => assertStakeWindowOpen(null, window.start), /No further staking transaction was sent/);
});
