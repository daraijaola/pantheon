// The HTTP side. Read-only JSON, answered from memory. It listens on this machine only, so it isn't
// public: nothing here checks who is asking yet, and nothing private may be served until something does.
import Fastify from "fastify";
import type { Verdicts } from "./verdicts.ts";

/** Requests per minute per visitor. Answers come from memory, so this only stops floods. */
export const PER_MINUTE = 120;

export function buildApp(verdicts: Pick<Verdicts, "health">, opts: { logger?: boolean; now?: () => number } = {}) {
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

  // The file's error stays in the log: it can name paths on this machine.
  app.get("/health", async (_req, reply) => {
    const { ready, lastError, ...rest } = verdicts.health();
    return reply
      .code(ready ? 200 : 503)
      .header("cache-control", "no-store")
      .send({ ok: ready, ...rest, reading: lastError ? "failing" : "ok" });
  });

  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: "NOT_FOUND" }));
  app.setErrorHandler((err, req, reply) => {
    req.log.error({ err }, "request failed");
    return reply.code(500).send({ error: "INTERNAL" });
  });
  return app;
}
