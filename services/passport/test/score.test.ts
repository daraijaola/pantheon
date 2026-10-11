import type { Address } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DAY_MS, E8, STAMP, STAMP_MASK } from "../src/config.ts";
import { HyperEvmReader, type EvmHoldings } from "../src/evm/hyperevm.ts";
import { HlClient } from "../src/hl/client.ts";
import { WeightLimiter } from "../src/ratelimit.ts";
import { computePassport, stampNames, toE8, type Passport, type Snapshot } from "../src/score.ts";
import { collectSnapshot } from "../src/snapshot.ts";
import { mockHyperEvm, rateFromFixture, walletFromFixture } from "./mockEvm.ts";
import { loadFixtures, startMockHl, type MockHl } from "./mockHl.ts";

const fixtures = loadFixtures();
const NOW = 1_791_681_994_068; // staker100 capturedAtMs

// ---------------------------------------------------------------- golden fixtures (§4.4), P1 → P2 → P3

describe("golden fixtures through the real clients", () => {
  let hl: MockHl;
  beforeAll(async () => {
    hl = await startMockHl(fixtures);
  });
  afterAll(() => hl.close());

  const evmWallets = Object.fromEntries(Object.values(fixtures).map((fx) => [fx.address, walletFromFixture(fx)]));

  async function passportOf(name: string) {
    const fx = fixtures[name]!;
    const client = new HlClient({ url: hl.url, limiter: new WeightLimiter(100_000) });
    const chain = mockHyperEvm(evmWallets);
    chain.state.rate = rateFromFixture(fx); // each fixture was captured at its own moment
    const evm = new HyperEvmReader({ client: chain.client, limiter: new WeightLimiter(100) });
    const snap = await collectSnapshot(client, evm, fx.address as Address);
    return { fx, result: computePassport(snap, fx.capturedAtMs) };
  }

  it.each(["staker100", "supplied_spot", "khype_whale", "new_big_staker", "small", "empty"])(
    "%s gets the spec's tier and stamps",
    async (name) => {
      const { fx, result } = await passportOf(name);
      const exp = fx.expected as { tier: number; stamps: number; staked: number; liquid: number; score: number; ageDays: number };
      expect(result.ok).toBe(true);
      const p = result as Passport;
      expect({ tier: p.tier, stamps: p.stamps }).toEqual({ tier: exp.tier, stamps: exp.stamps });
      // The spec rounds to 4 decimals (1 for age).
      expect(Number(p.parts.stakedE8) / 1e8).toBeCloseTo(exp.staked, 3);
      expect(Number(p.parts.liquidE8) / 1e8).toBeCloseTo(exp.liquid, 3);
      expect(Number(p.scoreE8) / 1e8).toBeCloseTo(exp.score, 3);
      expect(p.parts.ageMs / DAY_MS).toBeCloseTo(exp.ageDays, 0);
    },
  );

  it("rejects the agent fixture and names its master", async () => {
    const { result } = await passportOf("agent");
    expect(result).toEqual({ ok: false, error: "AGENT_WALLET", master: "0x5b5d51203a0f9079f8aeb098a6523a13f298c060" });
  });
});

// ---------------------------------------------------------------- synthetic snapshots

const EVM_ZERO: EvmHoldings = { blockNumber: 1n, nativeHype: 0n, whype: 0n, khype: 0n, khypeRate: 10n ** 18n, hypurr: 0n, kntq: 0n, failed: [] };

function snap(o: {
  delegated?: string;
  undelegated?: string;
  pending?: string;
  spotHype?: string;
  borrowHype?: string;
  subSpotHype?: string[];
  evm?: Partial<EvmHoldings>;
  ageDays?: number | null;
  role?: Snapshot["role"];
  multiSig?: Snapshot["multiSig"];
  genesis?: boolean;
  volume?: string;
  spotKntq?: string;
} = {}): Snapshot {
  const bal = (token: number, total: string) => ({ coin: String(token), token, total, hold: "0.0" });
  return {
    role: o.role ?? { role: "user" },
    multiSig: o.multiSig ?? null,
    spot: { balances: [...(o.spotHype ? [bal(150, o.spotHype)] : []), ...(o.spotKntq ? [bal(124, o.spotKntq)] : [])] },
    borrowLend: {
      tokenToState: o.borrowHype
        ? [[150, { borrow: { basis: o.borrowHype, value: o.borrowHype }, supply: { basis: "0.0", value: "0.0" } }]]
        : [],
    },
    staking: { delegated: o.delegated ?? "0.0", undelegated: o.undelegated ?? "0.0", totalPendingWithdrawal: o.pending ?? "0.0", nPendingWithdrawals: 0 },
    subAccounts: (o.subSpotHype ?? []).map((total, i) => ({
      name: `s${i}`,
      subAccountUser: `0x${String(i + 1).padStart(40, "0")}`,
      master: `0x${"9".repeat(40)}`,
      spotState: { balances: [bal(150, total)] },
    })),
    evm: { ...EVM_ZERO, ...o.evm },
    firstSeenMs: o.ageDays === null ? null : NOW - Math.round((o.ageDays ?? 400) * DAY_MS),
    hypeGenesis: o.genesis ?? false,
    allTimeVolumeUsd: o.volume ?? "0.0",
  };
}
const pass = (s: Snapshot) => {
  const r = computePassport(s, NOW);
  if (!r.ok) throw new Error(`rejected: ${r.error}`);
  return r;
};

describe("tier boundaries (§13 P3)", () => {
  it.each([
    ["9.99999999", 400, 0],
    ["10", 400, 1],
    ["99.99999999", 400, 1],
    ["100", 29.9, 1],
    ["100", 30, 2],
    ["1000", 89, 2],
    ["1000", 90, 3],
  ])("S = %s, age %s d → tier %i", (s, age, tier) => {
    expect(pass(snap({ delegated: s, ageDays: age })).tier).toBe(tier);
  });

  it("decides on exact fixed point, never floats (digits past 1e-8 are dropped, not rounded up)", () => {
    expect(toE8("9.999999999")).toBe(999_999_999n);
    expect(toE8("80796462.6899999976")).toBe(8_079_646_268_999_999n);
    expect(pass(snap({ delegated: "9.999999999" })).tier).toBe(0);
    expect(() => toE8("1e-8")).toThrow(RangeError);
  });

  it("weights liquid HYPE at 0.5: 20 liquid = 10 staked", () => {
    expect(pass(snap({ spotHype: "20" })).scoreE8).toBe(10n * E8);
    expect(pass(snap({ spotHype: "19.99999999" })).tier).toBe(0);
  });

  it("counts undelegated as staked and pending withdrawals as liquid", () => {
    expect(pass(snap({ undelegated: "10" })).scoreE8).toBe(10n * E8);
    expect(pass(snap({ pending: "20" })).scoreE8).toBe(10n * E8);
    expect(pass(snap({ pending: "19.99999999" })).tier).toBe(0);
  });

  it("nets borrowed HYPE out of spot, never below zero", () => {
    expect(pass(snap({ spotHype: "300", borrowHype: "100" })).scoreE8).toBe(100n * E8);
    expect(pass(snap({ spotHype: "100", borrowHype: "150", delegated: "10" })).scoreE8).toBe(10n * E8);
  });

  it("adds sub-account spot, EVM HYPE, WHYPE and kHYPE at its rate", () => {
    const s = snap({
      subSpotHype: ["4", "6"],
      evm: { nativeHype: 2n * 10n ** 18n, whype: 3n * 10n ** 18n, khype: 10n * 10n ** 18n, khypeRate: (11n * 10n ** 18n) / 10n },
    });
    expect(pass(s).scoreE8).toBe(((4n + 6n + 2n + 3n + 11n) * E8) / 2n);
  });

  it("ignores outcome-position entries that carry no token", () => {
    const s = snap({ spotHype: "20" });
    s.spot.balances.push({ coin: "o458", total: "999.0", hold: "0.0" }, { coin: "+103990", total: "999.0", hold: "0.0" });
    expect(pass(s).scoreE8).toBe(10n * E8);
  });

  it("scores a failed EVM read as 0 and says so", () => {
    const p = pass(snap({ delegated: "10", evm: { khype: null, failed: ["khype"] } }));
    expect(p.tier).toBe(1);
    expect(p.reasons).toContain("PARTIAL_EVM_READ");
  });
});

describe("roles and multi-sig (§2.1, §2.10)", () => {
  it.each([
    [{ role: "vault" }, "NOT_A_SIGNING_ACCOUNT"],
    [{ role: "subAccount", data: { master: `0x${"1".repeat(40)}` } }, "NOT_A_SIGNING_ACCOUNT"],
    [{ role: "someFutureRole" }, "NOT_A_SIGNING_ACCOUNT"],
  ])("rejects role %o as %s", (role, error) => {
    expect(computePassport(snap({ role, delegated: "5000" }), NOW)).toMatchObject({ ok: false, error });
  });

  it("rejects an agent with its master address", () => {
    const master = `0x${"2".repeat(40)}`;
    expect(computePassport(snap({ role: { role: "agent", data: { user: master } } }), NOW)).toEqual({ ok: false, error: "AGENT_WALLET", master });
  });

  it("rejects multi-sig accounts in v1", () => {
    const multiSig = { authorizedUsers: [`0x${"3".repeat(40)}`], threshold: 1 };
    expect(computePassport(snap({ multiSig, delegated: "5000" }), NOW)).toEqual({ ok: false, error: "MULTISIG_UNSUPPORTED" });
  });

  it("caps a `missing` account at tier 1 whatever it holds", () => {
    const p = pass(snap({ role: { role: "missing" }, evm: { khype: 5000n * 10n ** 18n }, ageDays: null }));
    expect(p.tier).toBe(1);
    expect(p.reasons).toEqual(expect.arrayContaining(["ACCOUNT_AGE_BELOW_30D", "NO_HYPERCORE_HISTORY"]));
  });
});

describe("stamps (§4.3)", () => {
  it("sets each stamp at its threshold", () => {
    const at = (o: Parameters<typeof snap>[0]) => pass(snap({ ageDays: 0, ...o })).stamps;
    expect(at({ delegated: "10" }) & STAMP.STAKER).toBe(STAMP.STAKER);
    expect(at({ delegated: "9.99999999" }) & STAMP.STAKER).toBe(0);
    expect(at({ evm: { khype: 10n * 10n ** 18n, khypeRate: 10n ** 18n } }) & STAMP.KHYPE).toBe(STAMP.KHYPE);
    expect(at({ genesis: true })).toBe(STAMP.GENESIS);
    expect(at({ ageDays: 365 }) & STAMP.VETERAN).toBe(STAMP.VETERAN);
    expect(at({ ageDays: 364.9 }) & STAMP.VETERAN).toBe(0);
    expect(at({ volume: "1000000.0" })).toBe(STAMP.TRADER);
    expect(at({ volume: "999999.99999999" })).toBe(0);
    expect(at({ evm: { hypurr: 1n } })).toBe(STAMP.HYPURR);
    expect(at({ spotKntq: "400", evm: { kntq: 600n * 10n ** 18n } })).toBe(STAMP.KNTQ);
    expect(at({ ageDays: 30 }) & STAMP.SEASONED).toBe(STAMP.SEASONED);
  });

  it("names stamps in bit order", () => {
    expect(stampNames(189)).toEqual(["STAKER", "GENESIS", "VETERAN", "TRADER", "HYPURR", "SEASONED"]);
  });

  it("never sets bits 8–31, and is deterministic, on 2,000 random snapshots", () => {
    let seed = 42;
    const rnd = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31);
    const amt = () => (rnd() < 0.3 ? "0.0" : (rnd() * 10 ** Math.floor(rnd() * 7)).toFixed(8));
    for (let i = 0; i < 2_000; i++) {
      const s = snap({
        delegated: amt(),
        spotHype: amt(),
        borrowHype: amt(),
        pending: amt(),
        volume: amt(),
        spotKntq: amt(),
        genesis: rnd() < 0.5,
        ageDays: rnd() < 0.1 ? null : rnd() * 1_200,
        evm: { hypurr: BigInt(Math.floor(rnd() * 3)), khype: BigInt(Math.floor(rnd() * 1e6)) * 10n ** 15n },
      });
      const a = pass(s);
      expect(a.stamps & ~STAMP_MASK).toBe(0);
      expect([0, 1, 2, 3]).toContain(a.tier);
      expect(pass(s)).toEqual(a);
    }
  });
});
