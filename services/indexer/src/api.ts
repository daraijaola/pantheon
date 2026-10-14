// The read-only JSON API the site shows. Answers are built once per poll and served from memory, so
// visitors never cause chain reads. Listens on 127.0.0.1 only; the site forwards /api/{stats,basket,receipts}.
import Fastify from "fastify";
import { getAddress, isAddress } from "viem";
import { z } from "zod";
import type { Kind } from "./chain.ts";
import { basket, receipts, stats, type Ctx } from "./views.ts";

export const KINDS = [
  "run", "burn", "to-basket", "leg", "deferred", "buy", "skip", "stream", "proposed", "vetoed", "executed",
  "stake", "unstake", "cancel-unstake", "withdraw", "claim", "reward",
] as const satisfies readonly Kind[];

const Query = z.object({
  kind: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(",") : undefined))
    .pipe(z.array(z.enum(KINDS)).max(KINDS.length).optional()),
  account: z.string().refine((v) => isAddress(v, { strict: false }), "not an address").transform((v) => getAddress(v)).optional(),
  token: z.string().refine((v) => isAddress(v, { strict: false }), "not an address").transform((v) => getAddress(v)).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z
    .string()
    .regex(/^\d{1,12}-\d{1,6}$/, "block-logIndex")
    .transform((v) => ({ block: Number(v.split("-")[0]), logIndex: Number(v.split("-")[1]) }))
    .optional(),
});

/** Requests per minute per visitor. Answers are cached, so this only stops floods. */
export const PER_MINUTE = 120;

export function buildApp(ctx: () => Ctx | null, opts: { logger?: boolean; now?: () => number } = {}) {
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: "127.0.0.1", bodyLimit: 1024 });
  const now = opts.now ?? Date.now;
  const hits = new Map<string, { n: number; since: number }>();
  app.addHook("onRequest", async (req, reply) => {
    const t = now();
    const h = hits.get(req.ip);
    if (!h || t - h.since >= 60_000) hits.set(req.ip, { n: 1, since: t });
    else if (++h.n > PER_MINUTE) return reply.code(429).send({ error: "RATE_LIMITED" });
    if (hits.size > 10_000) for (const [ip, v] of hits) if (t - v.since >= 60_000) hits.delete(ip);
  });

  const NOT_READY = { error: "NOT_READY", detail: "first read of the chain still running" };
  // Built once per poll (a new poll brings a new `live` object or more events), then served from memory.
  let memo: { live: Ctx["live"]; events: number; stats: ReturnType<typeof stats>; basket: ReturnType<typeof basket> } | null = null;
  const views = (c: Ctx) => {
    if (!memo || memo.live !== c.live || memo.events !== c.records.length) memo = { live: c.live, events: c.records.length, stats: stats(c), basket: basket(c) };
    return memo;
  };
  const cached = { "cache-control": "public, max-age=15" };

  app.get("/health", async (_req, reply) => {
    const c = ctx();
    return reply.code(c ? 200 : 503).send({ ok: !!c, block: c?.live.block ?? null, events: c?.records.length ?? 0 });
  });
  app.get("/stats", async (_req, reply) => {
    const c = ctx();
    if (!c) return reply.code(503).send(NOT_READY);
    return reply.headers(cached).send(views(c).stats);
  });
  app.get("/basket", async (_req, reply) => {
    const c = ctx();
    if (!c) return reply.code(503).send(NOT_READY);
    return reply.headers(cached).send(views(c).basket);
  });
  app.get("/receipts", async (req, reply) => {
    const q = Query.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "BAD_REQUEST", detail: q.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    const c = ctx();
    if (!c) return reply.code(503).send(NOT_READY);
    const { kind, ...rest } = q.data;
    return reply.headers(cached).send(receipts(c, { ...rest, ...(kind ? { kinds: kind } : {}) }));
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: "NOT_FOUND" }));
  app.setErrorHandler((err: { statusCode?: number; message?: string }, req, reply) => {
    if (err.statusCode !== undefined && err.statusCode < 500) return reply.code(400).send({ error: "BAD_REQUEST" });
    req.log.error({ err: { type: (err as Error).name, message: String(err.message ?? "").split("\n")[0] } }, "internal error");
    return reply.code(500).send({ error: "INTERNAL" });
  });
  return app;
}
