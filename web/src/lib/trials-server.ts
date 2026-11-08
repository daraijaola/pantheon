import { cacheLife } from "next/cache";
import { connection } from "next/server";
import { resolveTrialRound } from "./trials";
import type { TrialRound, TrialRoundSnapshot } from "./trials";

async function cachedTrialRound(after?: Pick<TrialRound, "round" | "closesAt">): Promise<TrialRoundSnapshot | null> {
  "use cache";
  cacheLife("minutes");
  const fetchedAt = Date.now() / 1000;
  if (after && fetchedAt < after.closesAt) return null;
  try {
    const res = await fetch(`${process.env.TRIALS_API ?? "http://127.0.0.1:8790"}/trials/current`, { cache: "no-store", signal: AbortSignal.timeout(4_000) });
    if (!res.ok) return null;
    const round = await res.json() as TrialRound;
    return ["open", "closed", "upcoming"].includes(round.status) && Array.isArray(round.candidates) && Array.isArray(round.leaders) && [round.round, round.opensAt, round.closesAt, round.ballots].every(Number.isFinite) ? { round, fetchedAt } : null;
  } catch {
    return null;
  }
}

export async function readTrialRound(): Promise<TrialRound | null> {
  await connection();
  return resolveTrialRound(await cachedTrialRound(), Date.now() / 1000, (round) => cachedTrialRound({ round: round.round, closesAt: round.closesAt }));
}
