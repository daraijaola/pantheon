// A wallet's voting record, and whether it can vote now. The vote itself still goes through the Trials
// service's existing signed ballot, which already refuses more picks than seats. For each round: the coins
// this wallet picked, whether each took a seat, whether it's in the basket now, DELPHI's verdict now, and
// how its price moved since the round closed. Prices come from fresh reads, which cover Ascend only, in
// test money on testnet, so a change can be null. No one's ballot but this wallet's is shown.
import { z } from "zod";
import { Remembered } from "./remembered.ts";
import type { CoinVerdict, UnknownCoin, Verdicts } from "./verdicts.ts";

const TTL_MS = 60_000;

const RoundView = z.object({
  round: z.number(),
  status: z.string(),
  closesAt: z.number(),
  seats: z.number(),
  leaders: z.array(z.string()),
  candidates: z.array(z.object({ token: z.string(), symbol: z.string().nullable() })),
  /** Only once a round has closed: ballots stay private during the vote. */
  ballotList: z.array(z.object({ voter: z.string(), coins: z.array(z.string()), weight: z.number(), receivedAt: z.number() })).optional(),
});
export type RoundResult = Required<z.infer<typeof RoundView>>;

const You = z.object({
  round: z.number(),
  status: z.enum(["upcoming", "open", "closed"]),
  closesAt: z.number(),
  seats: z.number(),
  you: z.object({
    weight: z.number().nullable(),
    /** Whether the stake counts in this round, and when a stake that's too new will. From round 6. */
    stakeVote: z.string().nullable().optional(),
    stakeVoteFrom: z.number().nullable().optional(),
    ballot: z.object({ coins: z.array(z.string()), weight: z.number() }).nullable(),
  }),
});
type You = z.infer<typeof You>;

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export type RoundsCalls = {
  /** Every closed round, with its ballots. Each is only read once: a closed round never changes. */
  rounds(): Promise<RoundResult[]>;
  /** The latest round as this wallet sees it, or null if there's none. */
  you(wallet: string): Promise<You | null>;
};

export function roundsCalls(base: string, doFetch: Fetch = globalThis.fetch): RoundsCalls {
  const closed = new Map<number, RoundResult>();
  async function get<T>(path: string, schema: z.ZodType<T>): Promise<T | null> {
    const res = await doFetch(`${base}${path}`, { signal: AbortSignal.timeout(5_000) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`trials answered ${res.status}`);
    return schema.parse(await res.json());
  }
  return {
    rounds: async () => {
      const health = await get("/health", z.object({ round: z.number().nullable() }));
      const out: RoundResult[] = [];
      for (let n = 1; n <= (health?.round ?? 0); n++) {
        const r = closed.get(n) ?? (await get(`/trials/rounds/${n}`, RoundView));
        // Rounds before the vote went live don't exist, and an open round doesn't list its ballots.
        if (!r || r.status !== "closed" || !r.ballotList) continue;
        const done = { ...r, ballotList: r.ballotList };
        closed.set(n, done);
        out.push(done);
      }
      return out;
    },
    you: (wallet) => get(`/trials/current?voter=${wallet}`, You),
  };
}

/** Why a wallet can't vote now, or null if it can. UNKNOWN: the chain didn't answer, so it may well be able to. */
export type NoVote = "NO_ROUND" | "NOT_OPEN" | "CLOSED" | "NO_VOTES" | "UNKNOWN";

export type BallotStatus = {
  wallet: string;
  round: number | null;
  canVote: boolean;
  whyNot: NoVote | null;
  /** Votes on each coin picked. Null if the chain didn't answer. */
  votes: number | null;
  /** Whether its stake counts this round: "ok", "none", "below_min" or "too_new". Null if unknown or not given. */
  stakeVote: string | null;
  /** For a stake that's too new: a round opening at this time or later counts it. */
  stakeCountsFrom: string | null;
  /** The most coins this wallet can pick. */
  maxPicks: number | null;
  /** What it has already picked this round. Voting again replaces it. */
  picks: string[];
  closesAt: string | null;
};

export function ballotStatus(wallet: string, y: You | null, nowSec: number): BallotStatus {
  if (!y) return { wallet, round: null, canVote: false, whyNot: "NO_ROUND", votes: null, stakeVote: null, stakeCountsFrom: null, maxPicks: null, picks: [], closesAt: null };
  const whyNot: NoVote | null = nowSec >= y.closesAt ? "CLOSED" : y.status === "upcoming" ? "NOT_OPEN" : y.you.weight === null ? "UNKNOWN" : y.you.weight < 1 ? "NO_VOTES" : null;
  const from = y.you.stakeVoteFrom ?? null;
  return { wallet, round: y.round, canVote: whyNot === null, whyNot, votes: y.you.weight, stakeVote: y.you.stakeVote ?? null, stakeCountsFrom: from === null ? null : new Date(from * 1000).toISOString(), maxPicks: y.seats, picks: (y.you.ballot?.coins ?? []).map((c) => c.toLowerCase()), closesAt: new Date(y.closesAt * 1000).toISOString() };
}

export type RecordPick = {
  token: string;
  symbol: string | null;
  /** It took a seat in the vote. */
  wonSeat: boolean;
  /** It's in the basket now. Null if the basket couldn't be read. */
  inBasketNow: boolean | null;
  verdictNow: CoinVerdict["verdict"] | UnknownCoin["verdict"];
  /** Price change since the round closed, in percent, in test money on testnet. Null if unknown. */
  changePct: number | null;
};

export type VotingRecord = {
  wallet: string;
  network: "testnet" | "mainnet";
  readAt: string;
  /** Newest first. */
  rounds: Array<{ round: number; closedAt: string; closed: boolean; votes: number; votedAt: string; picks: RecordPick[] }>;
  totals: { rounds: number; picks: number; seatsWon: number };
  /** False if the basket couldn't be read, so `inBasketNow` is missing. */
  complete: boolean;
};

export class RecordReader {
  readonly #verdicts: Pick<Verdicts, "get" | "health" | "priceChange">;
  readonly #calls: RoundsCalls;
  readonly #basket: () => Promise<Set<string>>;
  readonly #now: () => number;
  readonly #rounds: Remembered<RoundResult[]>;

  constructor(verdicts: Pick<Verdicts, "get" | "health" | "priceChange">, calls: RoundsCalls, basket: () => Promise<Set<string>>, opts: { now?: () => number; ttlMs?: number } = {}) {
    this.#verdicts = verdicts;
    this.#calls = calls;
    this.#basket = basket;
    this.#now = opts.now ?? Date.now;
    this.#rounds = new Remembered(() => calls.rounds(), { ttlMs: opts.ttlMs ?? TTL_MS, now: this.#now });
  }

  /** Whether this wallet can vote now. Never remembered: it changes as the wallet stakes. */
  async ballot(wallet: string): Promise<BallotStatus> {
    const w = wallet.toLowerCase();
    return ballotStatus(w, await this.#calls.you(w), Math.floor(this.#now() / 1000));
  }

  async read(wallet: string): Promise<VotingRecord> {
    const w = wallet.toLowerCase();
    const { network } = this.#verdicts.health();
    const [all, basket] = await Promise.all([this.#rounds.get("all"), this.#basket().catch(() => null)]);
    const nowSec = Math.floor(this.#now() / 1000);
    const rounds = all.flatMap((r) => {
      const mine = r.ballotList.find((b) => b.voter.toLowerCase() === w);
      if (!mine) return [];
      const seats = new Set(r.leaders.map((t) => t.toLowerCase()));
      const closed = nowSec >= r.closesAt;
      const picks = mine.coins.map((c): RecordPick => {
        const token = c.toLowerCase();
        return {
          token,
          symbol: r.candidates.find((x) => x.token.toLowerCase() === token)?.symbol ?? null,
          // While a round is open, the leaders can still change.
          wonSeat: closed && seats.has(token),
          inBasketNow: basket ? basket.has(token) : null,
          verdictNow: this.#verdicts.get(token).verdict,
          changePct: closed ? this.#verdicts.priceChange(token, r.closesAt) : null,
        };
      });
      return [{ round: r.round, closedAt: new Date(r.closesAt * 1000).toISOString(), closed, votes: mine.weight, votedAt: new Date(mine.receivedAt * 1000).toISOString(), picks }];
    });
    rounds.sort((a, b) => b.round - a.round);
    const picks = rounds.flatMap((r) => r.picks);
    return {
      wallet: w,
      network: network ?? "testnet",
      readAt: new Date(this.#now()).toISOString(),
      rounds,
      totals: { rounds: rounds.length, picks: picks.length, seatsWon: picks.filter((p) => p.wonSeat).length },
      complete: basket !== null,
    };
  }
}
