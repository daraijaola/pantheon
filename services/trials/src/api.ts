// The vote's web API (the site forwards /api/trials/* here):
//   GET  /trials/current[?voter=0x…]  the open round: candidates with live counts, and the voter's own ballot and tier
//   POST /trials/vote                 a signed ballot
//   GET  /trials/rounds/:n            a whole round, every signed ballot included, so anyone can recount it
//   GET  /health
import Fastify, { type FastifyServerOptions } from "fastify";
import { getAddress, isAddress, type Address } from "viem";
import { BallotInput, problem, signer, type Ballot } from "./ballot.ts";
import { currentRound, statusOf, type RoundDef } from "./round.ts";
import type { Ballots } from "./state.ts";
import { tally, winners } from "./tally.ts";

/** A voter's Passport tier right now: 1, 2 or 3 votes, or 0 with no valid Passport. */
export type TierOf = (voter: Address) => Promise<number>;

export type Deps = {
  rounds: () => RoundDef[];
  ballots: Ballots;
  tierOf: TierOf;
  chainId: number;
  now?: () => number;
};

const LIMIT = { perIp: 12, windowMs: 60_000 };

function view(r: RoundDef, all: Ballot[], nowSec: number) {
  const counts = new Map(tally(r, all).map((c) => [c.token.toLowerCase(), c]));
  return {
    round: r.round,
    status: statusOf(r, nowSec),
    opensAt: r.opensAt,
    closesAt: r.closesAt,
    seats: r.seats,
    method: r.method,
    source: r.source,
    candidates: r.candidates
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
  const tierCache = new Map<string, { tier: number; at: number }>();

  const cachedTier = async (voter: Address) => {
    const hit = tierCache.get(voter.toLowerCase());
    if (hit && Date.now() - hit.at < 60_000) return hit.tier;
    const tier = await deps.tierOf(voter);
    tierCache.set(voter.toLowerCase(), { tier, at: Date.now() });
    return tier;
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
    // If the chain doesn't answer, the tier is null and the site says so instead of guessing.
    const tier = await cachedTier(voter).catch(() => null);
    return { ...body, you: { voter, tier, ballot: deps.ballots.get(r.round, voter) ?? null } };
  });

  app.get<{ Params: { n: string } }>("/trials/rounds/:n", async (req, reply) => {
    const r = deps.rounds().find((x) => String(x.round) === req.params.n);
    if (!r) return reply.code(404).send({ error: "NO_ROUND" });
    const all = deps.ballots.of(r.round).sort((a, b) => a.receivedAt - b.receivedAt);
    return { ...view(r, all, now()), candidates: r.candidates, tally: tally(r, all), ballotList: all };
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

    let tier: number;
    try {
      tier = await deps.tierOf(b.voter); // always fresh for a vote
    } catch {
      return reply.code(503).send({ error: "CHAIN_UNAVAILABLE" });
    }
    if (tier < 1) return reply.code(403).send({ error: "NO_PASSPORT" });
    tierCache.set(b.voter.toLowerCase(), { tier, at: Date.now() });

    const ballot: Ballot = { voter: b.voter, coins: b.coins, tier, signedAt: b.signedAt, signature: b.signature, receivedAt: now() };
    const result = deps.ballots.put(r.round, ballot);
    if (result === "older") return reply.code(409).send({ error: "OLDER_BALLOT" });
    return { ok: true, result, ballot };
  });

  return app;
}
