// Passport scoring (spec §4): a PURE function of one account's snapshot and the time.
// Amounts are fixed-point bigint in 1e8 units (HyperCore's precision). No floats, no clock reads.
import type { Address } from "viem";
import { BPS, DAY_MS, E8, HL_TOKEN, SIGNING_ROLES, STAMP, STAMP_RULES, TIERS, WEIGHT_BPS } from "./config.ts";
import { khypeInHype, type EvmHoldings } from "./evm/hyperevm.ts";
import type {
  BorrowLendUserState,
  DelegatorSummary,
  MultiSigSigners,
  SpotClearinghouseState,
  SubAccounts,
  UserRole,
} from "./hl/schemas.ts";

/** Everything scoring needs about one HL account. Re-checks may fill the last three from cache (§7.2). */
export type Snapshot = {
  role: UserRole;
  multiSig: MultiSigSigners;
  spot: SpotClearinghouseState;
  borrowLend: BorrowLendUserState;
  staking: DelegatorSummary;
  subAccounts: SubAccounts;
  evm: EvmHoldings;
  /** Time (ms) of the earliest HL ledger entry; null when the account has no HyperCore history. */
  firstSeenMs: number | null;
  /** Received HYPE at the 2024-11-29 genesis (§2.6). */
  hypeGenesis: boolean;
  /** Portfolio `allTime.vlm`, USD as an HL decimal string (§2.7). */
  allTimeVolumeUsd: string;
};

export type Tier = 0 | 1 | 2 | 3;

/** Why the account is not one tier higher. Codes only: the API never reveals amounts (§8). */
export type Reason =
  | "SCORE_BELOW_10"
  | "SCORE_BELOW_100"
  | "SCORE_BELOW_1000"
  | "ACCOUNT_AGE_BELOW_30D"
  | "ACCOUNT_AGE_BELOW_90D"
  | "NO_HYPERCORE_HISTORY"
  | "PARTIAL_EVM_READ";

export type Rejection =
  | { ok: false; error: "AGENT_WALLET"; master: Address | null }
  | { ok: false; error: "NOT_A_SIGNING_ACCOUNT"; role: string }
  | { ok: false; error: "MULTISIG_UNSUPPORTED" };

export type Passport = {
  ok: true;
  tier: Tier;
  /** uint32 bitmap; bits 8–31 are always 0. */
  stamps: number;
  scoreE8: bigint;
  reasons: Reason[];
  /** Internal breakdown for logs and tests; never returned by the API. `liquidE8` includes kHYPE, as in §4.1. */
  parts: { stakedE8: bigint; liquidE8: bigint; khypeE8: bigint; ageMs: number };
};

const WEI_PER_E8 = 10n ** 10n;

/** HL decimal string → 1e8 fixed point, dropping digits past the 8th (never rounds up). */
export function toE8(decimal: string): bigint {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(decimal);
  if (!m) throw new RangeError(`not a decimal string: ${decimal}`);
  const [, sign, int = "0", frac = ""] = m;
  const v = BigInt(int) * E8 + BigInt(frac.padEnd(8, "0").slice(0, 8));
  return sign === "-" ? -v : v;
}

/** 18-decimal on-chain amount → 1e8 fixed point (floor); a failed read counts as 0. */
function weiToE8(wei: bigint | null): bigint {
  return wei === null || wei < 0n ? 0n : wei / WEI_PER_E8;
}

const pos = (v: bigint) => (v > 0n ? v : 0n);

function spotOf(spot: SpotClearinghouseState, token: number): bigint {
  return spot.balances.filter((b) => b.token === token).reduce((sum, b) => sum + pos(toE8(b.total)), 0n);
}

/** Gates (§2.1, §2.10): only an account's own key may link it. Used at challenge time and when scoring. */
export function signingGate(role: UserRole, multiSig: MultiSigSigners): Rejection | null {
  if (role.role === "agent") return { ok: false, error: "AGENT_WALLET", master: (role.data?.user as Address | undefined) ?? null };
  if (!(SIGNING_ROLES as readonly string[]).includes(role.role)) return { ok: false, error: "NOT_A_SIGNING_ACCOUNT", role: role.role };
  if (multiSig !== null) return { ok: false, error: "MULTISIG_UNSUPPORTED" };
  return null;
}

export function computePassport(s: Snapshot, nowMs: number): Passport | Rejection {
  const rejected = signingGate(s.role, s.multiSig);
  if (rejected) return rejected;

  // §4.1: staked counts 1.0 (≥ 7 days from spot); everything that can move in one transaction 0.5.
  const stakedE8 = pos(toE8(s.staking.delegated)) + pos(toE8(s.staking.undelegated));
  const borrowedE8 = s.borrowLend.tokenToState
    .filter(([token]) => token === HL_TOKEN.HYPE)
    .reduce((sum, [, st]) => sum + pos(toE8(st.borrow.value)), 0n);
  const subSpotE8 = s.subAccounts.reduce((sum, a) => sum + spotOf(a.spotState, HL_TOKEN.HYPE), 0n);
  const liquidE8 =
    pos(toE8(s.staking.totalPendingWithdrawal)) +
    pos(spotOf(s.spot, HL_TOKEN.HYPE) - borrowedE8) +
    subSpotE8 +
    weiToE8(s.evm.nativeHype) +
    weiToE8(s.evm.whype);
  const khypeE8 = weiToE8(khypeInHype(s.evm));
  const scoreE8 = (stakedE8 * WEIGHT_BPS.STAKED + liquidE8 * WEIGHT_BPS.LIQUID + khypeE8 * WEIGHT_BPS.KHYPE) / BPS;

  const ageMs = s.firstSeenMs === null ? 0 : Math.max(0, nowMs - s.firstSeenMs);
  const reaches = (t: (typeof TIERS)[number]) => scoreE8 >= t.minScoreE8 && ageMs >= t.minAgeDays * DAY_MS;
  let tier = TIERS.reduce<Tier>((best, t) => (reaches(t) ? (t.tier as Tier) : best), 0);
  if (s.role.role === "missing" && tier > 1) tier = 1; // no HyperCore account: capped at T1 (§4.2)

  // §4.3: coarse booleans, never amounts.
  const kntqE8 = spotOf(s.spot, HL_TOKEN.KNTQ) + weiToE8(s.evm.kntq);
  let stamps = 0;
  if (stakedE8 >= STAMP_RULES.stakerMinE8) stamps |= STAMP.STAKER;
  if (khypeE8 >= STAMP_RULES.khypeMinE8) stamps |= STAMP.KHYPE;
  if (s.hypeGenesis) stamps |= STAMP.GENESIS;
  if (ageMs >= STAMP_RULES.veteranMinAgeDays * DAY_MS) stamps |= STAMP.VETERAN;
  if (pos(toE8(s.allTimeVolumeUsd)) >= BigInt(STAMP_RULES.traderMinVolumeUsd) * E8) stamps |= STAMP.TRADER;
  if ((s.evm.hypurr ?? 0n) >= STAMP_RULES.hypurrMinCount) stamps |= STAMP.HYPURR;
  if (kntqE8 >= STAMP_RULES.kntqMinE8) stamps |= STAMP.KNTQ;
  if (ageMs >= STAMP_RULES.seasonedMinAgeDays * DAY_MS) stamps |= STAMP.SEASONED;

  const reasons: Reason[] = [];
  const next = TIERS[tier + 1];
  if (next) {
    if (scoreE8 < next.minScoreE8) reasons.push(`SCORE_BELOW_${next.minScoreE8 / E8}` as Reason);
    if (ageMs < next.minAgeDays * DAY_MS) reasons.push(`ACCOUNT_AGE_BELOW_${next.minAgeDays}D` as Reason);
    if ((s.firstSeenMs === null || s.role.role === "missing") && next.tier >= 2) reasons.push("NO_HYPERCORE_HISTORY");
  }
  if (s.evm.failed.length > 0) reasons.push("PARTIAL_EVM_READ");

  return { ok: true, tier, stamps, scoreE8, reasons, parts: { stakedE8, liquidE8: liquidE8 + khypeE8, khypeE8, ageMs } };
}

/** Stamp names for a bitmap, in bit order (for the API's `stampNames`). */
export function stampNames(stamps: number): Array<keyof typeof STAMP> {
  return (Object.keys(STAMP) as Array<keyof typeof STAMP>).filter((name) => (stamps & STAMP[name]) !== 0);
}
