import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HL_WEIGHT } from "../src/config.ts";
import { toSignable } from "../src/eip712.ts";
import { hlKeyOf } from "../src/link.ts";
import { RETRY_FAILED_RELAY_SEC } from "../src/scheduler.ts";
import { ELY, ELY2, fakeRelayer, harness, HL_T1, HL_T2 } from "./harness.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PEPPER = `0x${"42".repeat(32)}` as const;

let h: Awaited<ReturnType<typeof harness>>;
let relayer: ReturnType<typeof fakeRelayer>;
beforeEach(async () => {
  h = await harness({ relayer: (reg) => (relayer = fakeRelayer(reg)) });
});
afterEach(() => h.close());

/** Link through the API with relay: true, so the passport is on the (fake) chain. */
async function link(hl = HL_T2, ely = ELY) {
  const c = await h.app.inject({ method: "POST", url: "/passport/challenge", payload: { hyperliquidAccount: hl.address, elysiumAccount: ely.address } });
  const td = toSignable(c.json().typedData);
  const v = await h.app.inject({
    method: "POST",
    url: "/passport/verify",
    payload: { nonce: c.json().nonce, hlSignature: await hl.signTypedData(td), elysiumSignature: await ely.signTypedData(td), relay: true },
  });
  expect(v.json().txHash).toBeDefined();
  return v.json();
}
const onChain = (ely = ELY) => h.registry.passportOf(ely.address);
const run = (max?: number) => h.scheduler(max).runOnce();

describe("scheduler (§7.2, §13 P8)", () => {
  it("does nothing before a binding is due, then re-checks it 12–36 h later", async () => {
    await link();
    expect((await run()).checked).toBe(0);
    h.clock.ms += 23 * HOUR;
    expect((await run()).checked).toBe(0);
    h.clock.ms += 1 * HOUR; // random 0.5 → 12 h + 12 h
    expect(await run()).toMatchObject({ checked: 1, signed: 0 }); // nothing changed, expiry 6 d away
  });

  it("applies a downgrade in the same run", async () => {
    await link();
    expect((await onChain()).tier).toBe(2);
    h.fixtures.t2!.delegatorSummary = { delegated: "15.0", undelegated: "0.0", totalPendingWithdrawal: "0.0", nPendingWithdrawals: 0 };
    h.clock.ms += DAY;
    expect(await run()).toMatchObject({ checked: 1, signed: 1, relayed: 1 });
    expect((await onChain()).tier).toBe(1);
    expect(h.service.pokes(0).accounts).toContain(ELY.address);
  });

  it("upgrades only after a second check ≥ 20 h later", async () => {
    await link(HL_T1, ELY);
    expect((await onChain()).tier).toBe(1);
    h.fixtures.t1!.delegatorSummary = { delegated: "0.0", undelegated: "500.0", totalPendingWithdrawal: "0.0", nPendingWithdrawals: 0 };
    h.clock.ms += DAY;
    expect(await run()).toMatchObject({ checked: 1, signed: 0 }); // first check at T2: not yet
    expect((await onChain()).tier).toBe(1);
    h.clock.ms += DAY;
    expect(await run()).toMatchObject({ checked: 1, signed: 1, relayed: 1 }); // confirmed ≥ 20 h later
    expect((await onChain()).tier).toBe(2);
  });

  it("renews when less than 48 h are left, and not before", async () => {
    const first = await link();
    const signedAt: number[] = [];
    for (let day = 1; day <= 6; day++) {
      h.clock.ms += DAY;
      if ((await run()).signed > 0) signedAt.push(day);
    }
    expect(signedAt).toEqual([6]); // day 5 leaves exactly 48 h: not yet; day 6 leaves 24 h
    const p = await onChain();
    expect(p.tier).toBe(2);
    expect(p.expiry).toBeGreaterThan(first.expiry);
  });

  it("re-signs a failed relay with a new issuedAt, instead of resubmitting", async () => {
    await link();
    h.fixtures.t2!.delegatorSummary = { delegated: "15.0", undelegated: "0.0", totalPendingWithdrawal: "0.0", nPendingWithdrawals: 0 };
    h.clock.ms += DAY;
    relayer.failNext = 1;
    expect(await run()).toMatchObject({ signed: 1, relayed: 0, failed: 1 });
    expect((await onChain()).tier).toBe(2);
    const failedIssuedAt = Math.floor(h.clock.ms / 1000);

    h.clock.ms += RETRY_FAILED_RELAY_SEC * 1000 - 1000;
    expect((await run()).checked).toBe(0); // retry not due yet
    h.clock.ms += 1000;
    expect(await run()).toMatchObject({ signed: 1, relayed: 1 });
    const p = await onChain();
    expect(p.tier).toBe(1);
    expect(p.issuedAt).toBeGreaterThan(failedIssuedAt);
  });

  it("follows Unlinked events, stops re-checking, and forgets the HL address after 7 days", async () => {
    await link();
    h.registry.unlink(ELY.address);
    expect((await run()).unlinked).toBe(1);
    expect(h.service.deps.store.bindingByElysium(ELY.address)).toBeUndefined();
    expect(h.service.pokes(0).accounts).toContain(ELY.address);
    h.clock.ms += DAY;
    expect((await run()).checked).toBe(0);
    expect((await run()).unlinked).toBe(0); // the cursor moved on
    h.clock.ms += 6 * DAY + 1000;
    expect((await run()).forgotten).toBe(1);
    const left = h.db.prepare("SELECT COUNT(*) AS n FROM bindings").get() as { n: number };
    expect(left.n).toBe(0);
  });

  it("spends 62 HL weight on a daily re-check and re-reads role, multi-sig and volume weekly", async () => {
    await link();
    const spent = async () => {
      const before = h.service.deps.hl.limiter.available();
      await run();
      return before - h.service.deps.hl.limiter.available();
    };
    h.clock.ms += DAY;
    expect(await spent()).toBe(62);
    for (let d = 2; d <= 6; d++) {
      h.clock.ms += DAY;
      await run();
    }
    h.clock.ms += DAY; // 7 days after the link
    expect(await spent()).toBe(62 + HL_WEIGHT.userRole + HL_WEIGHT.userToMultiSigSigners + HL_WEIGHT.portfolio);
  });

  it("caps re-checks per run so the API keeps most of the HL budget", async () => {
    await link(HL_T2, ELY);
    await link(HL_T1, ELY2);
    h.clock.ms += DAY;
    expect((await run(1)).checked).toBe(1);
    expect((await run(1)).checked).toBe(1);
    expect((await run(1)).checked).toBe(0);
  });

  it("caps each run by HL weight: two weekly checks (162 each) never share a 240 run", async () => {
    await link(HL_T2, ELY);
    await link(HL_T1, ELY2);
    h.clock.ms += 7 * DAY; // both due, both weekly
    const before = h.service.deps.hl.limiter.available();
    const first = await run();
    expect(first).toMatchObject({ checked: 1, weight: 162 });
    expect(before - h.service.deps.hl.limiter.available()).toBe(162); // predicted cost = real spend
    expect(await run()).toMatchObject({ checked: 1, weight: 162 });
    expect((await run()).checked).toBe(0);
  });

  it("retries in 5 minutes when an upstream is down, changing nothing", async () => {
    await link();
    h.clock.ms += DAY;
    h.registry.down = true;
    const r = await run();
    expect(r.checked).toBe(0);
    expect(r.errors.join()).toMatch(/rpc down/);
    h.registry.down = false;
    h.clock.ms += RETRY_FAILED_RELAY_SEC * 1000;
    expect((await run()).checked).toBe(1);
  });

  it("pokes accounts whose passport ran out without a renewal", async () => {
    await link();
    h.service.deps.store.setNextCheck(hlKeyOf(PEPPER, HL_T2.address), Number.MAX_SAFE_INTEGER);
    h.clock.ms += 1000; // past the link's own "issued" poke
    await run();
    expect(h.service.pokes(Math.floor(h.clock.ms / 1000)).accounts).toEqual([]);
    h.clock.ms += 7 * DAY + 1000;
    await run();
    expect(h.service.pokes(Math.floor(h.clock.ms / 1000)).accounts).toEqual([ELY.address]);
  });
});

describe("GET /passport/pokes (for the staking keeper, §6.3)", () => {
  it("lists accounts poked since a time, and refuses a bad `since`", async () => {
    const t0 = Math.floor(h.clock.ms / 1000);
    await link();
    const r = await h.app.inject({ method: "GET", url: `/passport/pokes?since=${t0}` });
    expect(r.json()).toEqual({ accounts: [ELY.address], until: t0 });
    expect((await h.app.inject({ method: "GET", url: "/passport/pokes?since=soon" })).statusCode).toBe(400);
  });
});
