import { cacheLife } from "next/cache";
import type { TrialRound } from "./trials";

export async function readTrialRound(): Promise<TrialRound | null> {
  "use cache";
  cacheLife("minutes");
  try {
    const res = await fetch(`${process.env.TRIALS_API ?? "http://127.0.0.1:8790"}/trials/current`, { signal: AbortSignal.timeout(4_000) });
    if (!res.ok) return null;
    const round = await res.json() as TrialRound;
    return ["open", "closed", "upcoming"].includes(round.status) && Array.isArray(round.candidates) && Array.isArray(round.leaders) && [round.round, round.opensAt, round.closesAt, round.ballots].every(Number.isFinite) ? round : null;
  } catch {
    return null;
  }
}
