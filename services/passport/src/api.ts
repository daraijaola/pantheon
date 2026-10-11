// REST API (spec §8). Routes map PassportService results to HTTP; per-IP limits live here,
// per-account limits in the service. Responses never carry an HL address, a balance or a score.
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { HitCounter } from "./ratelimit.ts";
import type { ErrorCode, Fail, PassportService } from "./service.ts";

const STATUS: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  INVALID_ADDRESS: 400,
  RATE_LIMITED: 429,
  AGENT_WALLET: 403,
  NOT_A_SIGNING_ACCOUNT: 403,
  MULTISIG_UNSUPPORTED: 403,
  HL_ALREADY_LINKED: 409,
  ACCOUNT_ALREADY_LINKED: 409,
  REBIND_COOLDOWN: 409,
  CHALLENGE_NOT_FOUND: 404,
  CHALLENGE_USED: 409,
  CHALLENGE_EXPIRED: 410,
  BAD_HL_SIGNATURE: 401,
  BAD_ELYSIUM_SIGNATURE: 401,
  NOT_LINKED: 404,
  UPSTREAM_UNAVAILABLE: 503,
};

const ChallengeBody = z.object({ elysiumAccount: z.string().max(64), hyperliquidAccount: z.string().max(64) });
const VerifyBody = z.object({
  nonce: z.string().max(80),
  hlSignature: z.string().max(300),
  elysiumSignature: z.string().max(300).optional(),
  relay: z.boolean().optional(),
});
const RefreshBody = z.object({ elysiumAccount: z.string().max(64) });

/** Per-IP limits (§8). */
export const IP_LIMITS = {
  challenge: { limit: 10, windowMs: 60_000 },
  get: { limit: 120, windowMs: 60_000 },
} as const;

export type ApiOptions = { logger?: boolean; hits?: HitCounter };

export function buildApp(service: PassportService, opts: ApiOptions = {}): FastifyInstance {
  // Caddy on this host is the only proxy we trust for X-Forwarded-For.
  // requestTimeout: Fastify's default is none; a verify waiting on HL retries stays well under 120 s.
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: "127.0.0.1", bodyLimit: 16 * 1024, requestTimeout: 120_000 });
  const hits = opts.hits ?? new HitCounter();

  const sendFail = (reply: FastifyReply, f: Fail) => {
    if (f.retryAfterSec !== undefined) reply.header("retry-after", String(f.retryAfterSec));
    return reply.code(STATUS[f.error]).send({ error: f.error, ...(f.detail === undefined ? {} : { detail: f.detail }) });
  };
  const ipLimited = (req: FastifyRequest, reply: FastifyReply, route: keyof typeof IP_LIMITS) => {
    const { limit, windowMs } = IP_LIMITS[route];
    const wait = hits.hit(`${route}:${req.ip}`, limit, windowMs);
    if (wait === 0) return false;
    sendFail(reply, { ok: false, error: "RATE_LIMITED", detail: `${limit} per ${windowMs / 1000} s per IP`, retryAfterSec: Math.ceil(wait / 1000) });
    return true;
  };
  const body = <T>(schema: z.ZodType<T>, req: FastifyRequest, reply: FastifyReply): T | undefined => {
    const parsed = schema.safeParse(req.body);
    if (parsed.success) return parsed.data;
    sendFail(reply, { ok: false, error: "BAD_REQUEST", detail: parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") });
    return undefined;
  };
  const respond = (reply: FastifyReply, r: object) => {
    if ((r as Fail).ok === false) return sendFail(reply, r as Fail);
    const { ok: _ok, ...payload } = r as { ok?: boolean };
    return reply.send(payload);
  };

  app.get("/passport/stats", async (req, reply) => {
    if (ipLimited(req, reply, "get")) return reply;
    return reply.send(service.stats());
  });

  app.get<{ Params: { address: string } }>("/passport/:address", async (req, reply) => {
    if (ipLimited(req, reply, "get")) return reply;
    return respond(reply, await service.passport(req.params.address));
  });

  app.post("/passport/challenge", async (req, reply) => {
    if (ipLimited(req, reply, "challenge")) return reply;
    const b = body(ChallengeBody, req, reply);
    if (!b) return reply;
    return respond(reply, await service.challenge(b, req.ip));
  });

  app.post("/passport/verify", async (req, reply) => {
    const b = body(VerifyBody, req, reply);
    if (!b) return reply;
    return respond(reply, await service.verify(b));
  });

  app.post("/passport/refresh", async (req, reply) => {
    const b = body(RefreshBody, req, reply);
    if (!b) return reply;
    return respond(reply, await service.refresh(b.elysiumAccount));
  });

  // §8 names /health; Caddy exposes the service under /api/passport/*, so serve both.
  for (const path of ["/health", "/passport/health"]) {
    app.get(path, async (req, reply) => {
      if (ipLimited(req, reply, "get")) return reply;
      const h = await service.health();
      return reply.code(h.ok ? 200 : 503).send(h);
    });
  }

  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: "NOT_FOUND" }));
  app.setErrorHandler((err: { statusCode?: number; message?: string }, req, reply) => {
    // Malformed JSON, wrong content type, oversized body: the client's fault, say so briefly.
    if (err.statusCode !== undefined && err.statusCode >= 400 && err.statusCode < 500) {
      return reply.code(400).send({ error: "BAD_REQUEST", detail: err.message });
    }
    req.log.error(err);
    return reply.code(500).send({ error: "INTERNAL" });
  });
  return app;
}
