import type { Hex } from "viem";

export type TrialCoin = { token: Hex; symbol: string | null; verdict: "CLEAN" | "WATCH" | "NOT_ENOUGH_DATA"; headline?: string; realUsdc: string; rank: number; votes: number; voters: number };
export type TrialBallot = { voter: Hex; coins: Hex[]; weight: number; signedAt: number };
export type TrialRound = {
  round: number;
  status: "upcoming" | "open" | "closed";
  opensAt: number;
  closesAt: number;
  nextOpensAt?: number;
  seats: number;
  candidates: TrialCoin[];
  leaders: Hex[];
  ballots: number;
  you?: { voter: Hex; weight: number | null; tier: number | null; ballot: TrialBallot | null };
};

export const roundDate = (seconds: number) => new Date(seconds * 1000).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC";
export const trialsAction = (round: TrialRound | null) => !round ? "See the latest round" : round.status === "open" ? "Vote now" : round.status === "closed" ? `See round ${round.round} results` : `Round ${round.round} opens soon`;

export const trialRoundAt = (round: TrialRound | null, now: number): TrialRound | null => round ? { ...round, status: now < round.opensAt ? "upcoming" : now < round.closesAt ? "open" : "closed" } : null;

export type TrialRoundSnapshot = { round: TrialRound; fetchedAt: number };

const predatesClose = (snapshot: TrialRoundSnapshot, now: number) => now >= snapshot.round.closesAt && snapshot.fetchedAt < snapshot.round.closesAt;

export async function resolveTrialRound(snapshot: TrialRoundSnapshot | null, now: number, refresh: (round: TrialRound) => Promise<TrialRoundSnapshot | null>): Promise<TrialRound | null> {
  if (snapshot && predatesClose(snapshot, now)) snapshot = await refresh(snapshot.round);
  if (snapshot && predatesClose(snapshot, now)) return null;
  return trialRoundAt(snapshot?.round ?? null, now);
}
