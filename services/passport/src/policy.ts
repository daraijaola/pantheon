// Re-check policy (spec §7.2), shared by POST /passport/refresh and the scheduler (P8).
// Downgrade at once; upgrade only when the account has supported the higher level for ≥ 20 h.
import { TIMING } from "./config.ts";

export type Level = { tier: number; stamps: number };
export type PastCheck = Level & { at: number };

/**
 * What to attest after a re-check.
 * - No on-chain passport for this binding: a first link, so the current check applies at once.
 * - Tier or stamps BELOW what is on chain: the drop applies now.
 * - ABOVE what is on chain: applies only up to what every check since the latest one at least
 *   `upgradeConfirmGap` (20 h) old also supported. With no such old check, nothing is upgraded.
 *   So a balance parked for one check cannot buy an instant upgrade.
 */
export function confirmedLevel(onChain: Level | null, current: Level, history: PastCheck[], nowSec: number): Level {
  if (onChain === null) return current;

  const cutoff = nowSec - TIMING.upgradeConfirmGap;
  const anchor = history.filter((c) => c.at <= cutoff).at(-1);
  const window = anchor ? [anchor, ...history.filter((c) => c.at > anchor.at && c.at < nowSec), current] : [];

  const sustainedTier = window.length > 0 ? Math.min(...window.map((c) => c.tier)) : onChain.tier;
  const tier = current.tier <= onChain.tier ? current.tier : Math.max(onChain.tier, Math.min(current.tier, sustainedTier));

  const sustainedStamps = window.reduce((all, c) => all & c.stamps, window.length > 0 ? 0xff : 0);
  const stamps = (current.stamps & onChain.stamps) | (current.stamps & ~onChain.stamps & sustainedStamps);
  return { tier, stamps };
}
