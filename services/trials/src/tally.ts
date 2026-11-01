// Counting: each ballot adds its weight (1 for staking PNTH, plus the Passport tier) to every coin it
// picked. The seats go to the coins with the most votes; equal votes go to the coin with more independent
// trading. Pure functions.
//
// A round with `tradingSeats` (from round 6) first puts the coins with the most independent trading in by
// trading, fixed when it opens. The vote's seats then go to the most-voted coins among the rest, and any
// seat the vote leaves empty goes to the best trading rank left. Without the field (rounds 1 to 5), the
// vote's seats go to the most-voted coins of all, as they always did.
import type { Address } from "viem";
import type { Ballot } from "./ballot.ts";
import type { RoundDef } from "./round.ts";

export type Count = { token: Address; votes: number; voters: number; rank: number };

/** What counting needs from a ballot. A published ballot (no stake or tier) has it too. */
type Counted = Pick<Ballot, "coins" | "weight">;

export function tally(r: RoundDef, ballots: readonly Counted[]): Count[] {
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

/** The candidates, most independent trading first. */
const byRank = (r: RoundDef) => [...r.candidates].sort((a, b) => a.rank - b.rank);

/** The coins in by trading before anyone votes: the `tradingSeats` best ranks. None in a round without it. */
export const inByTrading = (r: RoundDef): Address[] =>
  r.tradingSeats === undefined
    ? []
    : byRank(r)
        .slice(0, r.tradingSeats)
        .map((c) => c.token);

/** The coins the vote put in: the top `seats` that got at least one vote, leaving out coins already in by
 * trading (there are none in rounds 1 to 5). */
export function winners(r: RoundDef, ballots: readonly Counted[]): Address[] {
  const fixed = new Set(inByTrading(r).map((t) => t.toLowerCase()));
  return tally(r, ballots)
    .filter((c) => c.votes > 0 && !fixed.has(c.token.toLowerCase()))
    .slice(0, r.seats)
    .map((c) => c.token);
}

export type List = {
  /** In by trading, fixed when the round opened. Empty in rounds 1 to 5. */
  inByTrading: Address[];
  /** Voted in. */
  winners: Address[];
  /** The rest of the list, by trading: first any vote seat nobody voted for, then up to the list's size. */
  byTrading: Address[];
};

/** The basket list a round gives, `coins` coins at most: the coins in by trading, the vote's winners, then the
 * most independent trading among the coins left. It can be longer than `coins` only if `coins` is too small
 * for the seats the round promised, which scripts/close.ts refuses for a round with `tradingSeats`. */
export function basketList(r: RoundDef, ballots: readonly Counted[], coins: number): List {
  const fixed = inByTrading(r);
  const won = winners(r, ballots);
  const taken = new Set([...fixed, ...won].map((t) => t.toLowerCase()));
  // Rounds 1 to 5 took the rest in file order, which open.ts writes by rank.
  const order = r.tradingSeats === undefined ? r.candidates : byRank(r);
  const rest = order.filter((c) => !taken.has(c.token.toLowerCase())).slice(0, Math.max(0, coins - taken.size));
  return { inByTrading: fixed, winners: won, byTrading: rest.map((c) => c.token) };
}
