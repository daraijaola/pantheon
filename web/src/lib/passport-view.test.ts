import { test } from "node:test";
import assert from "node:assert/strict";
const { extraVotes, registryView } = await import(new URL("../components/passport-book/view.ts", import.meta.url).href) as typeof import("../components/passport-book/view");

const wallet = `0x${"a".repeat(40)}`;
const record = { tier: 2, stamps: 131, issuedAt: 100n, expiry: 300n, linkedAt: 90n };

test("registry card preserves public facts and decodes stamps", () => {
  const view = registryView(wallet, record, true, 1200000000000000000n, 200000)!;
  assert.equal(view.status, "Valid");
  assert.equal(view.boost, "1.20×");
  assert.deepEqual(view.stamps, ["STAKER", "KHYPE", "SEASONED"]);
  assert.equal(view.issued.toISOString(), "1970-01-01T00:01:40.000Z");
  assert.equal(extraVotes(view), 2);
  assert.equal("hlKey" in view, false);
});
test("expired card retains recorded tier and stamps, but not extra votes", () => {
  const view = registryView(wallet, record, false, 1000000000000000000n, 300000)!;
  assert.equal(view.status, "Expired");
  assert.equal(view.tier, 2);
  assert.equal(view.stamps.length, 3);
  assert.equal(view.boost, "1.00×");
  assert.equal(extraVotes(view), 0);
});
test("retired registry is inactive, not no-passport or expired", () => {
  const view = registryView(wallet, record, false, 1000000000000000000n, 200000)!;
  assert.equal(view.status, "Inactive");
  assert.equal(extraVotes(view), 0);
});
test("empty record is not a fabricated passport", () => {
  assert.equal(registryView(wallet, { ...record, issuedAt: 0n, linkedAt: 0n }, false, 1000000000000000000n), null);
});
test("issued tier-zero record is still a real passport", () => {
  const view = registryView(wallet, { ...record, tier: 0 }, true, 1000000000000000000n, 200000)!;
  assert.equal(view.tier, 0);
  assert.equal(view.example, false);
  assert.equal(extraVotes(view), 0);
});
test("registry validity takes precedence over a fast device clock", () => {
  assert.equal(registryView(wallet, record, true, 1200000000000000000n, 400000)!.status, "Valid");
});
