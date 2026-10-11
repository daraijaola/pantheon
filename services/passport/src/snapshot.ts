// Gathers one account's Snapshot: the HL info calls of §2.11 plus one HyperEVM read (§3).
// Requests go out together; each client's limiter still paces them.
import type { Address } from "viem";
import { GENESIS_WINDOW_MS, HL_WEIGHT } from "./config.ts";
import type { HyperEvmReader } from "./evm/hyperevm.ts";
import type { HlClient } from "./hl/client.ts";
import type { LedgerUpdates, Portfolio } from "./hl/schemas.ts";
import type { Snapshot } from "./score.ts";

/** Earliest ledger entry (ms), or null for an account with no HyperCore history. */
export function firstSeenMs(ledger: LedgerUpdates): number | null {
  return ledger.length === 0 ? null : Math.min(...ledger.map((e) => e.time));
}

/** HYPE received at genesis: a `spotGenesis` delta for token HYPE (§2.6). */
export function hasHypeGenesis(genesisWindow: LedgerUpdates): boolean {
  return genesisWindow.some((e) => e.delta.type === "spotGenesis" && e.delta.token === "HYPE");
}

/** Portfolio `allTime.vlm`; "0" if the period is missing. */
export function allTimeVolume(portfolio: Portfolio): string {
  return portfolio.find(([period]) => period === "allTime")?.[1].vlm ?? "0";
}

/** The full first-link snapshot (202 HL weight + 1 HyperEVM request). */
export async function collectSnapshot(hl: HlClient, evm: HyperEvmReader, user: Address): Promise<Snapshot> {
  const [role, multiSig, spot, borrowLend, staking, ledger, genesis, portfolio, subAccounts, holdings] = await Promise.all([
    hl.userRole(user),
    hl.userToMultiSigSigners(user),
    hl.spotClearinghouseState(user),
    hl.borrowLendUserState(user),
    hl.delegatorSummary(user),
    hl.userNonFundingLedgerUpdates(user, 0),
    hl.userNonFundingLedgerUpdates(user, GENESIS_WINDOW_MS.start, GENESIS_WINDOW_MS.end),
    hl.portfolio(user),
    hl.subAccounts(user),
    evm.holdings(user),
  ]);
  return {
    role,
    multiSig,
    spot,
    borrowLend,
    staking,
    subAccounts,
    evm: holdings,
    firstSeenMs: firstSeenMs(ledger),
    hypeGenesis: hasHypeGenesis(genesis),
    allTimeVolumeUsd: allTimeVolume(portfolio),
  };
}

/** Role, multi-sig and volume are refreshed this often on re-checks (§2.11 "weekly"). */
export const FULL_RECHECK_EVERY_SEC = 7 * 86_400;

const isWeekly = (b: { roleCheckedAt: number | null }, nowSec: number) =>
  b.roleCheckedAt === null || nowSec - b.roleCheckedAt >= FULL_RECHECK_EVERY_SEC;

/** HL weight `collectRecheck` will spend: 62 daily, +100 weekly, +20 while the account has no history. */
export function recheckCost(b: { firstSeenMs: number | null; roleCheckedAt: number | null }, nowSec: number): number {
  const daily = HL_WEIGHT.spotClearinghouseState + HL_WEIGHT.borrowLendUserState + HL_WEIGHT.delegatorSummary + HL_WEIGHT.subAccounts;
  const weekly = isWeekly(b, nowSec) ? HL_WEIGHT.userRole + HL_WEIGHT.userToMultiSigSigners + HL_WEIGHT.portfolio : 0;
  return daily + weekly + (b.firstSeenMs === null ? HL_WEIGHT.userNonFundingLedgerUpdates : 0);
}

/**
 * A re-check snapshot (§2.11, §7.2): spot, staking, borrows and sub-accounts every time (62 weight)
 * plus one HyperEVM read; role, multi-sig and volume only weekly (+100). Account age and genesis come
 * from the binding's cache: they never change, except that an account with no history yet is re-read.
 */
export async function collectRecheck(
  hl: HlClient,
  evm: HyperEvmReader,
  b: { hl: Address; firstSeenMs: number | null; genesis: boolean; vlm: string | null; roleCheckedAt: number | null },
  nowSec: number,
): Promise<{ snapshot: Snapshot; full: boolean }> {
  const full = isWeekly(b, nowSec);
  const [spot, borrowLend, staking, subAccounts, holdings, weekly, ledger] = await Promise.all([
    hl.spotClearinghouseState(b.hl),
    hl.borrowLendUserState(b.hl),
    hl.delegatorSummary(b.hl),
    hl.subAccounts(b.hl),
    evm.holdings(b.hl),
    full ? Promise.all([hl.userRole(b.hl), hl.userToMultiSigSigners(b.hl), hl.portfolio(b.hl)]) : undefined,
    b.firstSeenMs === null ? hl.userNonFundingLedgerUpdates(b.hl, 0) : undefined,
  ]);
  const seen = b.firstSeenMs ?? (ledger ? firstSeenMs(ledger) : null);
  return {
    full,
    snapshot: {
      // Between weekly checks the role is known from the last one: linked accounts are user or missing.
      role: weekly ? weekly[0] : { role: seen === null ? "missing" : "user" },
      multiSig: weekly ? weekly[1] : null,
      spot,
      borrowLend,
      staking,
      subAccounts,
      evm: holdings,
      firstSeenMs: seen,
      hypeGenesis: b.genesis,
      allTimeVolumeUsd: weekly ? allTimeVolume(weekly[2]) : (b.vlm ?? "0"),
    },
  };
}
