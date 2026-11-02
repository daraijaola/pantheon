// The current Trials round for the voting screen: its candidates, seats and time left, with DELPHI's
// latest verdict on each coin. A round's file records each coin's verdict when the round was set, and a
// coin can change after that, so both are given: 3 of round 5's 20 candidates had changed by Nov 1.
import { z } from "zod";
import { Remembered } from "./remembered.ts";
import type { Verdicts } from "./verdicts.ts";

const TTL_MS = 15_000;

const Current = z.object({
  round: z.number(),
  status: z.enum(["upcoming", "open", "closed"]),
  opensAt: z.number(),
  closesAt: z.number(),
  /** Seats the vote fills. Coins in by trading come on top, from round 6. */
  seats: z.number(),
  tradingSeats: z.number().optional(),
  /** The stake a vote needs, and how long it must have been in place. From round 6. */
  minStake: z.string().optional(),
  minHoldSec: z.number().optional(),
  method: z.string(),
  ballots: z.number(),
  leaders: z.array(z.string()),
  candidates: z.array(
    z.object({
      token: z.string(),
      symbol: z.string().nullable(),
      verdict: z.string(),
      launchedAt: z.number(),
      rank: z.number(),
      votes: z.number(),
      voters: z.number(),
      /** Already in by trading, so it can't be voted for. From round 6. */
      inByTrading: z.boolean().optional(),
    }),
  ),
});
type Current = z.infer<typeof Current>;

export type TrialsCalls = {
  /** The latest round, or null if there has never been one. */
  current(): Promise<Current | null>;
};

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export function trialsCalls(base: string, doFetch: Fetch = globalThis.fetch): TrialsCalls {
  return {
    current: async () => {
      const res = await doFetch(`${base}/trials/current`, { signal: AbortSignal.timeout(5_000) });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`trials answered ${res.status}`);
      return Current.parse(await res.json());
    },
  };
}

export type Candidate = {
  token: string;
  symbol: string | null;
  votes: number;
  voters: number;
  /** Rank by independent trading, 1 = most. It breaks ties between equal votes. */
  rank: number;
  /** True if it would take a vote seat as the votes stand. */
  inSeat: boolean;
  /** True if it's already in by trading, so picking it is refused. */
  inByTrading: boolean;
  launchedAt: string;
  /** DELPHI's verdict now. */
  verdict: string;
  /** Its verdict when the round was set. */
  verdictAtOpen: string;
  verdictChanged: boolean;
  reason: string;
  reportUrl: string | null;
  disputeUrl: string | null;
  /** True if that verdict is older than it should be. */
  stale: boolean;
};

export type RoundNow = {
  round: number;
  status: Current["status"];
  opensAt: string;
  closesAt: string;
  /** Until it opens if upcoming, until it closes if open, 0 once closed. */
  secondsLeft: number;
  seats: number;
  tradingSeats: number | null;
  minStake: string | null;
  minHoldSec: number | null;
  ballots: number;
  method: string;
  /** Most votes first, as the Trials service orders them. */
  candidates: Candidate[];
};

const iso = (s: number) => new Date(s * 1000).toISOString();

export function describeRound(r: Current, verdicts: Pick<Verdicts, "get">, nowSec: number): RoundNow {
  // The times decide the status, so a remembered answer can't say "open" after the round has closed.
  const status = nowSec < r.opensAt ? "upcoming" : nowSec < r.closesAt ? "open" : "closed";
  const leaders = new Set(r.leaders.map((t) => t.toLowerCase()));
  return {
    round: r.round,
    status,
    opensAt: iso(r.opensAt),
    closesAt: iso(r.closesAt),
    secondsLeft: status === "upcoming" ? r.opensAt - nowSec : status === "open" ? r.closesAt - nowSec : 0,
    seats: r.seats,
    tradingSeats: r.tradingSeats ?? null,
    minStake: r.minStake ?? null,
    minHoldSec: r.minHoldSec ?? null,
    ballots: r.ballots,
    method: r.method,
    candidates: r.candidates.map((c) => {
      const v = verdicts.get(c.token);
      return {
        token: c.token.toLowerCase(),
        symbol: c.symbol,
        votes: c.votes,
        voters: c.voters,
        rank: c.rank,
        inSeat: leaders.has(c.token.toLowerCase()),
        inByTrading: c.inByTrading ?? false,
        launchedAt: iso(c.launchedAt),
        verdict: v.verdict,
        verdictAtOpen: c.verdict,
        verdictChanged: v.verdict !== c.verdict,
        reason: v.reason,
        reportUrl: v.known ? v.reportUrl : null,
        disputeUrl: v.known ? v.disputeUrl : null,
        stale: v.known ? v.stale : false,
      };
    }),
  };
}

export class RoundReader {
  readonly #verdicts: Pick<Verdicts, "get">;
  readonly #now: () => number;
  readonly #round: Remembered<Current | null>;

  constructor(verdicts: Pick<Verdicts, "get">, calls: TrialsCalls, opts: { now?: () => number; ttlMs?: number } = {}) {
    this.#verdicts = verdicts;
    this.#now = opts.now ?? Date.now;
    this.#round = new Remembered(() => calls.current(), { ttlMs: opts.ttlMs ?? TTL_MS, now: this.#now });
  }

  /** The latest round with today's verdicts, or null if there has never been one. */
  async read(): Promise<RoundNow | null> {
    const r = await this.#round.get("current");
    return r && describeRound(r, this.#verdicts, Math.floor(this.#now() / 1000));
  }
}
