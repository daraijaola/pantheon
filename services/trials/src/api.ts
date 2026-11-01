// The vote's web API (the site forwards /api/trials/* here):
//   GET  /trials/current[?voter=0x…]  the open round: candidates with live counts, and the voter's own ballot and votes
//   POST /trials/vote                 a signed ballot
//   GET  /trials/rounds/:n            a whole round, every signed ballot included, so anyone can recount it
//   GET  /health
import Fastify, { type FastifyServerOptions } from "fastify";
import { getAddress, isAddress, type Address } from "viem";
import { BallotInput, problem, signer, stakeVote, stakeVoteFrom, weightIn, type Ballot, type Standing } from "./ballot.ts";
import { currentRound, statusOf, type RoundDef } from "./round.ts";
import type { Ballots } from "./state.ts";
import { inByTrading, tally, winners } from "./tally.ts";

/** A wallet's PNTH stake, when that stake started, and its Passport tier right now, read from the chain. */
export type StandingOf = (voter: Address) => Promise<Standing>;

export type Deps = {
  rounds: () => RoundDef[];
  ballots: Ballots;
  standingOf: StandingOf;
  chainId: number;
  now?: () => number;
};

const LIMIT = { perIp: 12, windowMs: 60_000 };

/** The round's candidates, each marked if it's in by trading already (never, in rounds 1 to 5). */
function marked(r: RoundDef) {
  const fixed = new Set(inByTrading(r).map((t) => t.toLowerCase()));
  return r.candidates.map((c) => ({ ...c, inByTrading: fixed.has(c.token.toLowerCase()) }));
}

function view(r: RoundDef, all: Ballot[], nowSec: number) {
  const counts = new Map(tally(r, all).map((c) => [c.token.toLowerCase(), c]));
  return {
    round: r.round,
    status: statusOf(r, nowSec),
    opensAt: r.opensAt,
    closesAt: r.closesAt,
    seats: r.seats,
    // Only in rounds that have them; JSON leaves out a field that's undefined.
    tradingSeats: r.tradingSeats,
    minStake: r.minStake,
    minHoldSec: r.minHoldSec,
    method: r.method,
    source: r.source,
    candidates: marked(r)
      .map((c) => ({ ...c, votes: counts.get(c.token.toLowerCase())?.votes ?? 0, voters: counts.get(c.token.toLowerCase())?.voters ?? 0 }))
      .sort((a, b) => b.votes - a.votes || a.rank - b.rank),
    leaders: winners(r, all),
    ballots: all.length,
  };
}

export function buildApp(deps: Deps, opts: FastifyServerOptions = {}) {
  // Requests come through the site on this machine, so the visitor's address is in X-Forwarded-For.
  const app = Fastify({ ...opts, trustProxy: "127.0.0.1" });
  const now = () => (deps.now ? deps.now() : Math.floor(Date.now() / 1000));
  const hits = new Map<string, number[]>();
  const cache = new Map<string, { standing: Standing; at: number }>();

  const cachedStanding = async (voter: Address) => {
    const hit = cache.get(voter.toLowerCase());
    if (hit && Date.now() - hit.at < 60_000) return hit.standing;
    const standing = await deps.standingOf(voter);
    cache.set(voter.toLowerCase(), { standing, at: Date.now() });
    return standing;
  };

  app.get("/health", async () => {
    const r = currentRound(deps.rounds());
    return { ok: true, round: r?.round ?? null, status: r ? statusOf(r, now()) : null };
  });

  app.get<{ Querystring: { voter?: string } }>("/trials/current", async (req, reply) => {
    const r = currentRound(deps.rounds());
    if (!r) return reply.code(404).send({ error: "NO_ROUND" });
    const body = view(r, deps.ballots.of(r.round), now());
    const v = req.query.voter;
    if (!v) return body;
    if (!isAddress(v, { strict: false })) return reply.code(400).send({ error: "INVALID_ADDRESS" });
    const voter = getAddress(v);
    // If the chain doesn't answer, the votes are null and the site says so instead of guessing.
    // stakeVote says whether the stake gives its 1 vote in this round, and if not, why; stakeVoteFrom is when
    // a stake that's too new starts to count.
    const st = await cachedStanding(voter).catch(() => null);
    const you = st
      ? {
          weight: weightIn(r, st),
          staked: st.staked.toString(),
          tier: st.tier,
          stakeStart: st.stakeStart,
          stakeVote: stakeVote(r, st),
          stakeVoteFrom: stakeVoteFrom(r, st),
        }
      : { weight: null, staked: null, tier: null, stakeStart: null, stakeVote: null, stakeVoteFrom: null };
    // The voter's own ballot, stake and tier included, as before. Anyone can ask for any address, so keeping
    // a ballot private during the vote needs sign-in first.
    return { ...body, you: { voter, ...you, ballot: deps.ballots.get(r.round, voter) ?? null } };
  });

  app.get<{ Params: { n: string } }>("/trials/rounds/:n", async (req, reply) => {
    const r = deps.rounds().find((x) => String(x.round) === req.params.n);
    if (!r) return reply.code(404).send({ error: "NO_ROUND" });
    const all = deps.ballots.of(r.round).sort((a, b) => a.receivedAt - b.receivedAt);
    return { ...view(r, all, now()), candidates: marked(r), tally: tally(r, all), ballotList: all };
  });

  app.post("/trials/vote", async (req, reply) => {
    const ip = req.ip;
    const t = Date.now();
    const recent = (hits.get(ip) ?? []).filter((x) => t - x < LIMIT.windowMs);
    if (recent.length >= LIMIT.perIp) return reply.code(429).send({ error: "RATE_LIMITED" });
    hits.set(ip, [...recent, t]);

    const parsed = BallotInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_BALLOT", detail: parsed.error.issues[0]?.message });
    const b = parsed.data;
    const r = currentRound(deps.rounds());
    if (!r) return reply.code(404).send({ error: "NO_ROUND" });
    const why = problem(r, b, now());
    if (why) return reply.code(400).send({ error: why });

    let who: Address;
    try {
      who = await signer(deps.chainId, b);
    } catch {
      return reply.code(400).send({ error: "BAD_SIGNATURE" });
    }
    if (who.toLowerCase() !== b.voter.toLowerCase()) return reply.code(400).send({ error: "BAD_SIGNATURE" });

    let st: Standing;
    try {
      st = await deps.standingOf(b.voter); // always fresh for a vote
    } catch {
      return reply.code(503).send({ error: "CHAIN_UNAVAILABLE" });
    }
    cache.set(b.voter.toLowerCase(), { standing: st, at: Date.now() });
    const weight = weightIn(r, st);
    if (weight < 1) return reply.code(403).send({ error: "NO_VOTES" });

    const ballot: Ballot = {
      voter: b.voter,
      coins: b.coins,
      weight,
      staked: st.staked.toString(),
      tier: st.tier,
      signedAt: b.signedAt,
      signature: b.signature,
      receivedAt: now(),
    };
    const result = deps.ballots.put(r.round, ballot);
    if (result === "older") return reply.code(409).send({ error: "OLDER_BALLOT" });
    return { ok: true, result, ballot };
  });

  return app;
}
