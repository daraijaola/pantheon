// Counting: each ballot adds its weight (1 for staking PNTH, plus the Passport tier) to every coin it
// picked. The seats go to the coins with the most votes; equal votes go to the coin with more independent
// trading. Pure functions.
import type { Address } from "viem";
import type { Ballot } from "./ballot.ts";
import type { RoundDef } from "./round.ts";

export type Count = { token: Address; votes: number; voters: number; rank: number };

export function tally(r: RoundDef, ballots: readonly Ballot[]): Count[] {
  const counts = new Map(r.candidates.map((c) => [c.token.toLowerCase(), { token: c.token, votes: 0, voters: 0, rank: c.rank }]));
  for (const b of ballots) {
    for (const coin of b.coins) {
      const c = counts.get(coin.toLowerCase());
      if (!c) continue; // checked on arrival; a coin dropped from the round just doesn't count
      c.votes += b.weight;
      c.voters += 1;
    }
  }
  return [...counts.values()].sort((a, b) => b.votes - a.votes || a.rank - b.rank);
}

/** The coins the vote put in: the top `seats` that got at least one vote. */
export const winners = (r: RoundDef, ballots: readonly Ballot[]): Address[] =>
  tally(r, ballots)
    .filter((c) => c.votes > 0)
    .slice(0, r.seats)
    .map((c) => c.token);
