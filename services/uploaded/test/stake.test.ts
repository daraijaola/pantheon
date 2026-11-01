// Stake data and the unstake preview. The sums are checked against what the contract does; a separate
// live check compared them with real stakers and a simulated unstake (see TASKS.md).
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/api.ts";
import { chainStake, describeStake, previewUnstake, StakeReader, timeBonusAt, workingFor, type StakeState, type UnstakeError } from "../src/stake.ts";
import { Verdicts } from "../src/verdicts.ts";

const FIXTURE = new URL("./fixtures/scan.json", import.meta.url).pathname;
const WALLET = "0x79a320a02db0c1cbe7a5f2cd47210ea6f3b9f23a";
const E = 10n ** 18n;
const DAY = 86_400n;
const NOW = 1_800_000_000n;

/** A stake of 1,000 PNTH this many days old, with no Passport, up to date. */
function state(over: Partial<StakeState> & { days?: bigint } = {}): StakeState {
  const { days = 15n, ...rest } = over;
  const staked = rest.staked ?? 1_000n * E;
  const passport = rest.passport ?? E;
  const w = workingFor(staked, days * DAY, passport);
  return { staked, cooling: 0n, working: w, workingNow: w, coolEnd: 0n, stakeStart: NOW - days * DAY, passport, tier: 0, now: NOW, ...rest };
}

describe("the contract's sums", () => {
  it("grows the time bonus from 1.0× to 1.5× over 30 days, and stops there", () => {
    expect(timeBonusAt(0n)).toBe(E);
    expect(timeBonusAt(15n * DAY)).toBe((E * 125n) / 100n);
    expect(timeBonusAt(30n * DAY)).toBe((E * 150n) / 100n);
    expect(timeBonusAt(300n * DAY)).toBe((E * 150n) / 100n);
  });

  it("rounds a working balance the way the contract does", () => {
    // (staked × bonus / 1e18) × passport / 1e18, each division rounding down: 7 × 1.25 = 8, 8 × 1.2 = 9.
    // Rounding only once at the end would give 7 × 1.25 × 1.2 = 10.
    expect(workingFor(7n, 15n * DAY, (E * 12n) / 10n)).toBe(9n);
    expect(workingFor(1_000n * E, 30n * DAY, (E * 125n) / 100n)).toBe(1_875n * E);
  });
});

describe("a wallet's stake", () => {
  it("shows the amount, the bonus and how far along it is", () => {
    const s = describeStake(WALLET, "testnet", state({ days: 15n }));
    expect(s).toMatchObject({ wallet: WALLET, network: "testnet", staked: { raw: (1_000n * E).toString(), amount: "1000" }, coolEnd: null, canWithdraw: false, needsRefresh: false });
    expect(s.timeBonus).toEqual({ now: 1.25, max: 1.5, progress: 0.5, fullAt: new Date(Number(NOW + 15n * DAY) * 1000).toISOString() });
    expect(s.passportBoost).toBe(1);
  });

  it("caps the bonus and its progress after 30 days", () => {
    expect(describeStake(WALLET, "testnet", state({ days: 90n })).timeBonus).toMatchObject({ now: 1.5, progress: 1 });
  });

  it("shows a wallet with nothing staked plainly", () => {
    const s = describeStake(WALLET, "testnet", state({ staked: 0n, working: 0n, workingNow: 0n, stakeStart: 0n }));
    expect(s).toMatchObject({ stakeStart: null, multiplier: { earning: 1, ifRefreshed: 1 }, needsRefresh: false });
    expect(s.timeBonus).toEqual({ now: 1, max: 1.5, progress: 0, fullAt: null });
  });

  it("includes the Passport boost in what it earns at", () => {
    const passport = (E * 12n) / 10n;
    const s = describeStake(WALLET, "testnet", state({ days: 30n, passport }));
    expect(s.passportBoost).toBe(1.2);
    expect(s.multiplier.earning).toBe(1.8);
  });

  it("spots a bonus that has grown but isn't earning yet", () => {
    const w = workingFor(1_000n * E, 5n * DAY, E); // last touched at 5 days
    const s = describeStake(WALLET, "testnet", state({ days: 15n, working: w }));
    expect(s.needsRefresh).toBe(true);
    expect(s.multiplier.earning).toBeLessThan(s.multiplier.ifRefreshed);
  });

  it("doesn't call a working balance that would fall a refresh worth doing", () => {
    expect(describeStake(WALLET, "testnet", state({ working: 2_000n * E })).needsRefresh).toBe(false);
  });

  it("says when unlocking PNTH can be withdrawn", () => {
    const waiting = describeStake(WALLET, "testnet", state({ cooling: 5n * E, coolEnd: NOW + 100n }));
    expect(waiting).toMatchObject({ cooling: { amount: "5" }, canWithdraw: false, coolEnd: new Date(Number(NOW + 100n) * 1000).toISOString() });
    expect(describeStake(WALLET, "testnet", state({ cooling: 5n * E, coolEnd: NOW })).canWithdraw).toBe(true);
  });
});

describe("the unstake preview", () => {
  it("shows the whole loss: the bonus restarts on what stays staked too", () => {
    const p = previewUnstake(WALLET, "testnet", state({ days: 15n }), 1n * E);
    expect(p.stakedAfter.amount).toBe("999");
    expect(p.timeBonus).toEqual({ before: 1.25, after: 1 });
    expect(p.daysLost).toBe(15);
    expect(p.working.before.amount).toBe("1250");
    expect(p.working.after.amount).toBe("999");
    expect(p.bonusLost.working.amount).toBe("249.75"); // 999 × 0.25
    expect(p.bonusLost.share).toBe(0.2); // 249.75 of the 1,248.75 it would have stayed at
  });

  it("counts 30 days at most, however old the stake", () => {
    const p = previewUnstake(WALLET, "testnet", state({ days: 90n }), 1n * E);
    expect(p.daysLost).toBe(30);
    expect(p.timeBonus.before).toBe(1.5);
  });

  it("takes the Passport boost into account", () => {
    const passport = (E * 125n) / 100n;
    const p = previewUnstake(WALLET, "testnet", state({ days: 30n, passport }), 100n * E);
    expect(p.working.after.amount).toBe("1125"); // 900 × 1.0 × 1.25
    expect(p.bonusLost.working.amount).toBe("562.5"); // 900 × 0.5 × 1.25
  });

  it("handles unstaking everything: nothing left, so no bonus lost on what stays", () => {
    const p = previewUnstake(WALLET, "testnet", state({ days: 15n }), 1_000n * E);
    expect(p).toMatchObject({ stakedAfter: { raw: "0" }, working: { after: { raw: "0" } }, bonusLost: { working: { raw: "0" } } });
  });

  it("warns when it would restart the 3 days on PNTH already unlocking", () => {
    const fresh = previewUnstake(WALLET, "testnet", state(), 1n * E);
    expect(fresh.restartsCooldown).toBe(false);
    expect(fresh.coolEndAfter).toBe(new Date(Number(NOW + 3n * DAY) * 1000).toISOString());
    const again = previewUnstake(WALLET, "testnet", state({ cooling: 7n * E, coolEnd: NOW + 100n }), 1n * E);
    expect(again.restartsCooldown).toBe(true);
    expect(again.coolingAfter.amount).toBe("8");
    expect(again.coolEndAfter).toBe(fresh.coolEndAfter);
  });

  it("refuses nothing, and more than is staked, as the contract would", () => {
    const code = (amount: bigint) => {
      try {
        previewUnstake(WALLET, "testnet", state(), amount);
        return null;
      } catch (e) {
        return (e as UnstakeError).code;
      }
    };
    expect(code(0n)).toBe("ZERO_AMOUNT");
    expect(code(1_000n * E + 1n)).toBe("TOO_MUCH");
    expect(code(1_000n * E)).toBeNull();
  });
});

describe("reading the chain", () => {
  const ok = (result: unknown) => ({ status: "success", result });
  const client = (results: unknown[]) => ({ multicall: async (_o: { batchSize: number }) => (expect(_o.batchSize).toBe(0), results) });
  const addresses = { staking: "0x" + "a".repeat(40), passport: "0x" + "b".repeat(40) };

  it("reads everything from one moment, in one request", async () => {
    const got = await chainStake(client([ok([10n, 2n, 11n, 99n, 50n]), ok(12n), ok(E), ok(NOW), ok(2)]) as never, addresses).read(WALLET);
    expect(got).toEqual({ staked: 10n, cooling: 2n, working: 11n, workingNow: 12n, coolEnd: 99n, stakeStart: 50n, passport: E, tier: 2, now: NOW });
  });

  it("treats an unreadable Passport as no boost, and caps it, as the contract does", async () => {
    const stake = [10n, 0n, 10n, 0n, 50n];
    const none = await chainStake(client([ok(stake), ok(10n), { status: "failure" }, ok(NOW), { status: "failure" }]) as never, addresses).read(WALLET);
    expect(none.passport).toBe(E);
    expect(none.tier).toBe(0);
    const huge = await chainStake(client([ok(stake), ok(10n), ok(5n * E), ok(NOW), ok(3)]) as never, addresses).read(WALLET);
    expect(huge.passport).toBe((E * 125n) / 100n);
    const low = await chainStake(client([ok(stake), ok(10n), ok(1n), ok(NOW), ok(0)]) as never, addresses).read(WALLET);
    expect(low.passport).toBe(E);
  });

  it("fails out loud if the stake itself can't be read", async () => {
    await expect(chainStake(client([{ status: "failure" }, ok(1n), ok(E), ok(NOW), ok(0)]) as never, addresses).read(WALLET)).rejects.toThrow("couldn't be read");
  });
});

describe("the reader", () => {
  it("remembers a wallet only briefly, so a preview stays close to what gets signed", async () => {
    let t = 0;
    let reads = 0;
    const r = new StakeReader(() => "testnet", { read: async () => (reads++, state()) }, { now: () => t });
    await r.read(WALLET);
    await r.preview(WALLET, 1n);
    expect(reads).toBe(1);
    t = 10_000;
    await r.preview(WALLET, 1n);
    expect(reads).toBe(2);
  });

  it("refuses to answer before DELPHI's coins are loaded", async () => {
    await expect(new StakeReader(() => null, { read: async () => state() }).read(WALLET)).rejects.toThrow("no coins loaded");
  });
});

describe("asking the server", () => {
  const verdicts = new Verdicts(FIXTURE);
  const app = (read: () => Promise<StakeState> = async () => state()) => buildApp(verdicts, { stake: new StakeReader(() => "testnet", { read }) });
  const preview = (query: string) => `/wallets/${WALLET}/stake/unstake-preview${query}`;

  it("answers with the stake", async () => {
    const res = await app().inject({ url: `/wallets/${WALLET}/stake` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ staked: { amount: "1000" }, timeBonus: { now: 1.25 } });
  });

  it("answers with a preview", async () => {
    const res = await app().inject({ url: preview(`?amount=${E}`) });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json()).toMatchObject({ stakedAfter: { amount: "999" }, timeBonus: { after: 1 } });
  });

  it("refuses a missing or strange amount, zero, and too much", async () => {
    for (const q of ["", "?amount=", "?amount=abc", "?amount=-1", "?amount=1.5", "?amount=1e18"]) expect((await app().inject({ url: preview(q) })).json(), q).toEqual({ error: "INVALID_AMOUNT" });
    expect((await app().inject({ url: preview("?amount=0") })).json()).toEqual({ error: "ZERO_AMOUNT" });
    const res = await app().inject({ url: preview(`?amount=${2_000n * E}`) });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "TOO_MUCH" });
  });

  it("answers 503 when the chain fails, never a made-up stake", async () => {
    const down = app(() => Promise.reject(new Error("rpc detail")));
    expect((await down.inject({ url: `/wallets/${WALLET}/stake` })).statusCode).toBe(503);
    const res = await down.inject({ url: preview(`?amount=${E}`) });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "CHAIN_UNAVAILABLE" });
  });
});
