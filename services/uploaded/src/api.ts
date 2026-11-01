// The HTTP side. Read-only JSON. It listens on this machine only, so it isn't public: nothing here
// checks who is asking yet. Holdings are meant to be private, so this must not go public before sign-in.
import Fastify from "fastify";
import { z } from "zod";
import type { BagReader } from "./bag.ts";
import type { FreshChecks } from "./fresh.ts";
import type { HistoryReader } from "./history.ts";
import { NotReady, type HoldingsReader } from "./holdings.ts";
import type { StageEvent } from "./scan.ts";
import type { Verdicts } from "./verdicts.ts";

/** Requests per minute per visitor. Answers come from memory, so this only stops floods. */
export const PER_MINUTE = 120;

const Address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

export function buildApp(verdicts: Pick<Verdicts, "health" | "get">, opts: { logger?: boolean; now?: () => number; fresh?: Pick<FreshChecks, "ask">; holdings?: Pick<HoldingsReader, "read">; history?: Pick<HistoryReader, "read">; bag?: Pick<BagReader, "read">; scan?: (wallet: string) => AsyncIterable<StageEvent> } = {}) {
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

  // Check any coin. Always answers from memory, at once. A coin DELPHI hasn't read is a normal answer
  // ("UNKNOWN"), not a 404. `checking` says a fresh read is on its way: ask again in about 15 seconds.
  app.get<{ Params: { token: string } }>("/coins/:token", async (req, reply) => {
    const token = Address.safeParse(req.params.token);
    if (!token.success) return reply.code(400).send({ error: "INVALID_ADDRESS" });
    const coin = verdicts.get(token.data);
    return reply.header("cache-control", "no-store").send({ ...coin, checking: opts.fresh?.ask(coin) ?? false });
  });

  // A failed read is a 503, never an empty answer: "holds nothing" has to be something we actually read.
  const walletRoute = (path: string, reader: { read(wallet: string): Promise<unknown> }) =>
    app.get<{ Params: { address: string } }>(`/wallets/:address/${path}`, async (req, reply) => {
      const wallet = Address.safeParse(req.params.address);
      if (!wallet.success) return reply.code(400).send({ error: "INVALID_ADDRESS" });
      try {
        return await reply.header("cache-control", "no-store").send(await reader.read(wallet.data));
      } catch (err) {
        req.log.warn({ error: (err as Error).message.split("\n")[0] }, `couldn't read a wallet's ${path}`);
        return reply.code(503).send({ error: err instanceof NotReady ? "NOT_READY" : "CHAIN_UNAVAILABLE" });
      }
    });
  if (opts.holdings) walletRoute("holdings", opts.holdings);
  if (opts.history) walletRoute("history", opts.history);
  if (opts.bag) walletRoute("bag", opts.bag);

  // The wallet scan, sent as server-sent events: one `stage` event as each stage finishes, then `done`.
  // no-transform stops anything on the way from compressing the stream, which would hold events back.
  const { scan } = opts;
  if (scan) {
    app.get<{ Params: { address: string } }>("/wallets/:address/scan", async (req, reply) => {
      const wallet = Address.safeParse(req.params.address);
      if (!wallet.success) return reply.code(400).send({ error: "INVALID_ADDRESS" });
      reply.hijack();
      const out = reply.raw;
      out.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" });
      const send = (event: string, data: unknown) => out.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      const failed: string[] = [];
      try {
        for await (const stage of scan(wallet.data.toLowerCase())) {
          if (out.destroyed) return; // they left: the rest would go nowhere
          if (!stage.ok) failed.push(stage.stage);
          send("stage", stage);
        }
        send("done", { failed });
      } catch (err) {
        req.log.error({ err }, "scan failed");
      }
      out.end();
    });
  }

  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: "NOT_FOUND" }));
  app.setErrorHandler((err, req, reply) => {
    req.log.error({ err }, "request failed");
    return reply.code(500).send({ error: "INTERNAL" });
  });
  return app;
}
