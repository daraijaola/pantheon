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
