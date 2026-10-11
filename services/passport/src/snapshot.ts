// Gathers one account's Snapshot: the HL info calls of §2.11 plus one HyperEVM read (§3).
// Requests go out together; each client's limiter still paces them.
import type { Address } from "viem";
import { GENESIS_WINDOW_MS } from "./config.ts";
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
