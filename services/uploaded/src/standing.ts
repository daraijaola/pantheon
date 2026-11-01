// The on-chain facts a wallet's standing will rest on: its first day, when it staked, the Trials rounds it
// voted in, the coins it launched and its Passport tier. Which facts earn which role (Staker, Councillor,
// Creator, Pillar, Genesis) is Micheal's to decide, so no role is named here. These are facts only, and
// the rules can sit on top of them later. A part that can't be read is null, never 0 or "none", and
// `complete` turns false: "never voted" has to be something we actually checked.
import { z } from "zod";
import type { IndexerCalls } from "./basket.ts";
import type { FirstSeen, HistoryReader, WalletNow } from "./history.ts";
import { Remembered } from "./remembered.ts";
import type { Amount, StakeInfo, StakeReader } from "./stake.ts";

const TTL_MS = 60_000;

export type StandingFacts = {
  wallet: string;
  network: "testnet" | "mainnet";
  readAt: string;
  firstSeen: FirstSeen | null;
  staking: {
    now: Amount;
    /** When the current stake's time bonus started: weighted by amount, and restarted by an unstake. */
    bonusSince: string | null;
    /** The first stake this wallet ever made. Null if it never has, or if `complete` is false. */
    firstStaked: string | null;
  };
  /** Rounds voted in, oldest first. Null if the Trials service couldn't be read. */
  roundsVoted: number[] | null;
  coinsLaunched: { total: number; byVerdict: Record<string, number> };
  passport: { tier: number; boost: number };
  /** False if a part couldn't be read. */
  complete: boolean;
};

const RoundView = z.object({
  round: z.number(),
  status: z.string(),
  ballotList: z.array(z.object({ voter: z.string() })),
});
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Who voted in each round. A closed round never changes, so it's read once. */
export function roundVoters(base: string, doFetch: Fetch = globalThis.fetch) {
  const closed = new Map<number, Set<string>>();
  async function get<T>(path: string, schema: z.ZodType<T>): Promise<T | null> {
    const res = await doFetch(`${base}${path}`, { signal: AbortSignal.timeout(5_000) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`trials answered ${res.status}`);
    return schema.parse(await res.json());
  }
  return async (): Promise<Map<number, Set<string>>> => {
    const health = await get("/health", z.object({ round: z.number().nullable() }));
    const out = new Map<number, Set<string>>();
    for (let n = 1; n <= (health?.round ?? 0); n++) {
      const known = closed.get(n);
      if (known) {
        out.set(n, known);
        continue;
      }
      const r = await get(`/trials/rounds/${n}`, RoundView);
      if (!r) continue; // rounds before the vote went live have no ballots
      const voters = new Set(r.ballotList.map((b) => b.voter.toLowerCase()));
      out.set(n, voters);
      if (r.status === "closed") closed.set(n, voters);
    }
    return out;
  };
}

export type StandingDeps = {
  history: Pick<HistoryReader, "quick" | "firstDay">;
  stake: Pick<StakeReader, "read">;
  indexer: Pick<IndexerCalls, "stakes">;
  voters: () => Promise<Map<number, Set<string>>>;
  now?: () => number;
  ttlMs?: number;
};

export function factsFrom(p: {
  wallet: string;
  readAt: string;
  now: WalletNow;
  firstSeen: FirstSeen | null;
  stake: StakeInfo;
  /** Times of this wallet's stakes, in seconds, or null if they couldn't be read. */
  stakes: number[] | null;
  voters: Map<number, Set<string>> | null;
}): StandingFacts {
  const byVerdict: Record<string, number> = {};
  for (const c of p.now.coinsLaunched) byVerdict[c.verdict] = (byVerdict[c.verdict] ?? 0) + 1;
  const firstStake = p.stakes?.length ? Math.min(...p.stakes) : null;
  return {
    wallet: p.wallet,
    network: p.now.network,
    readAt: p.readAt,
    firstSeen: p.firstSeen,
    staking: { now: p.stake.staked, bonusSince: p.stake.stakeStart, firstStaked: firstStake === null ? null : new Date(firstStake * 1000).toISOString() },
    roundsVoted: p.voters ? [...p.voters].filter(([, who]) => who.has(p.wallet)).map(([n]) => n).sort((a, b) => a - b) : null,
    coinsLaunched: { total: p.now.coinsLaunched.length, byVerdict },
    passport: { tier: p.stake.passportTier, boost: p.stake.passportBoost },
    complete: p.stakes !== null && p.voters !== null,
  };
}

export class StandingReader {
  readonly #deps: StandingDeps;
  readonly #now: () => number;
  readonly #voters: Remembered<Map<number, Set<string>>>;
  readonly #wallets: Remembered<StandingFacts>;

  constructor(deps: StandingDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
    const remember = { ttlMs: deps.ttlMs ?? TTL_MS, now: this.#now };
    this.#voters = new Remembered(() => deps.voters(), remember);
    this.#wallets = new Remembered((w) => this.#read(w), remember);
  }

  read(wallet: string): Promise<StandingFacts> {
    return this.#wallets.get(wallet.toLowerCase());
  }

  async #read(wallet: string): Promise<StandingFacts> {
    const d = this.#deps;
    const [now, firstSeen, stake, stakes, voters] = await Promise.all([
      d.history.quick(wallet),
      d.history.firstDay(wallet),
      d.stake.read(wallet),
      d.indexer.stakes(wallet).catch(() => null),
      this.#voters.get("all").catch(() => null),
    ]);
    return factsFrom({ wallet, readAt: new Date(this.#now()).toISOString(), now, firstSeen, stake, stakes: stakes && stakes.whole ? stakes.times : null, voters });
  }
}
