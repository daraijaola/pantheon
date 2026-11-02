// Campaigns: a page for each candidate in a Trials round, showing the votes it needs for a seat, and the
// facts for a share card. This is how a coin's community brings voters in. There are no referral links
// and no referral pay, so the link is the same for everyone and nothing here knows who is sharing. A share
// card always carries DELPHI's verdict, so a flagged coin can't be promoted without it, and it never
// says to buy or vote for anything. How the card looks is Micheal's.
import type { Candidate, RoundNow, RoundReader } from "./trials.ts";

const SITE = "https://pantheonindex.com";

type Ranked = Pick<Candidate, "token" | "votes" | "rank"> & { inByTrading?: boolean };

/**
 * Votes this coin needs to take a seat if nothing else changes, or 0 if it's in one. It follows the
 * Trials service's counting: most votes first, equal votes go to the coin with more independent trading
 * (the lower rank), and a coin needs at least one vote. Coins in by trading (from round 6) are outside the
 * vote: they need nothing, and they take none of the vote's seats.
 */
export function votesNeeded(coin: Ranked, all: readonly Ranked[], seats: number): number {
  if (coin.inByTrading) return 0;
  const order = all.filter((c) => c.votes > 0 && !c.inByTrading).sort((a, b) => b.votes - a.votes || a.rank - b.rank);
  const seated = order.slice(0, seats);
  if (seated.some((c) => c.token === coin.token)) return 0;
  // A free seat: one vote takes it, ahead of every coin with none.
  if (seated.length < seats) return Math.max(1, 1 - coin.votes);
  const last = seated.at(-1)!;
  return last.votes - coin.votes + (coin.rank < last.rank ? 0 : 1);
}

export type Campaign = {
  round: number;
  token: string;
  symbol: string | null;
  status: RoundNow["status"];
  secondsLeft: number;
  closesAt: string;
  seats: number;
  votes: number;
  voters: number;
  inSeat: boolean;
  inByTrading: boolean;
  /** Votes needed for a seat, if nothing else changes. 0 if in one. Null once voting is over. */
  votesNeeded: number | null;
  verdict: string;
  verdictChanged: boolean;
  reason: string;
  reportUrl: string | null;
  disputeUrl: string | null;
  /** The facts for a share card. The same for everyone: no referral link. */
  share: { title: string; lines: string[]; url: string };
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function headline(name: string, c: Candidate, r: RoundNow, needed: number | null): string {
  if (c.inByTrading) return `${name} is in by trading in Trials round ${r.round}`;
  if (r.status === "closed") return c.inSeat ? `${name} took a seat in Trials round ${r.round}` : `${name} didn't take a seat in Trials round ${r.round}`;
  if (needed === 0) return `${name} is in a seat in Trials round ${r.round}`;
  return `${name} needs ${plural(needed ?? 0, "more vote")} for a seat in Trials round ${r.round}`;
}

export function campaignOf(r: RoundNow, c: Candidate): Campaign {
  const needed = r.status === "closed" ? null : votesNeeded(c, r.candidates, r.seats);
  const name = c.symbol ?? `${c.token.slice(0, 6)}…${c.token.slice(-4)}`;
  return {
    round: r.round,
    token: c.token,
    symbol: c.symbol,
    status: r.status,
    secondsLeft: r.secondsLeft,
    closesAt: r.closesAt,
    seats: r.seats,
    votes: c.votes,
    voters: c.voters,
    inSeat: c.inSeat,
    inByTrading: c.inByTrading,
    votesNeeded: needed,
    verdict: c.verdict,
    verdictChanged: c.verdictChanged,
    reason: c.reason,
    reportUrl: c.reportUrl,
    disputeUrl: c.disputeUrl,
    share: {
      title: headline(name, c, r, needed),
      lines: [`${plural(c.votes, "vote")} from ${plural(c.voters, "wallet")}`, `DELPHI: ${c.verdict.replaceAll("_", " ")}`, c.reason],
      url: `${SITE}/trials`,
    },
  };
}

export class CampaignReader {
  readonly #round: Pick<RoundReader, "read">;

  constructor(round: Pick<RoundReader, "read">) {
    this.#round = round;
  }

  /** Every candidate in the latest round, or null if there has never been one. */
  async all(): Promise<Campaign[] | null> {
    const r = await this.#round.read();
    return r && r.candidates.map((c) => campaignOf(r, c));
  }

  /** One candidate. Null if there's no round, or it isn't a candidate. */
  async one(token: string): Promise<Campaign | null> {
    const r = await this.#round.read();
    const c = r?.candidates.find((x) => x.token === token.toLowerCase());
    return r && c ? campaignOf(r, c) : null;
  }
}
