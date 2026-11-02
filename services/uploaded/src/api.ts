// The HTTP side. Read-only JSON. It listens on this machine only, so it isn't public: nothing here
// checks who is asking yet. Holdings are meant to be private, so this must not go public before sign-in.
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import type { BagReader } from "./bag.ts";
import type { BasketReader } from "./basket.ts";
import type { CampaignReader } from "./campaign.ts";
import type { FreshChecks } from "./fresh.ts";
import type { HistoryReader } from "./history.ts";
import type { RecordReader } from "./record.ts";
import type { ElsewhereReader } from "./elsewhere.ts";
import { TooBig, type FootprintReader } from "./footprint.ts";
import type { GuardReader } from "./guard.ts";
import { NotReady, type HoldingsReader } from "./holdings.ts";
import type { StageEvent } from "./scan.ts";
import type { StandingReader } from "./standing.ts";
import { UnstakeError, type StakeReader } from "./stake.ts";
import type { RoundReader } from "./trials.ts";
import type { Verdicts } from "./verdicts.ts";

/** Requests per minute per visitor. Answers come from memory, so this only stops floods. */
export const PER_MINUTE = 120;

const Address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

export function buildApp(verdicts: Pick<Verdicts, "health" | "get">, opts: { logger?: boolean; now?: () => number; fresh?: Pick<FreshChecks, "ask">; holdings?: Pick<HoldingsReader, "read">; history?: Pick<HistoryReader, "read">; bag?: Pick<BagReader, "read">; scan?: (wallet: string) => AsyncIterable<StageEvent>; stake?: Pick<StakeReader, "read" | "preview">; basket?: Pick<BasketReader, "read" | "basket">; standing?: Pick<StandingReader, "read">; guard?: Pick<GuardReader, "read">; round?: Pick<RoundReader, "read">; record?: Pick<RecordReader, "read" | "ballot">; campaigns?: Pick<CampaignReader, "all" | "one">; footprint?: Pick<FootprintReader, "read">; elsewhere?: Pick<ElsewhereReader, "read"> | undefined } = {}) {
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
        if (err instanceof TooBig) return reply.code(422).send({ error: "TOO_BIG" });
        return reply.code(503).send({ error: err instanceof NotReady ? "NOT_READY" : "CHAIN_UNAVAILABLE" });
      }
    });
  if (opts.holdings) walletRoute("holdings", opts.holdings);
  if (opts.history) walletRoute("history", opts.history);
  if (opts.bag) walletRoute("bag", opts.bag);
  if (opts.standing) walletRoute("standing", opts.standing);
  if (opts.footprint) walletRoute("footprint", opts.footprint);
  if (opts.elsewhere) walletRoute("elsewhere", opts.elsewhere);

  // Both lean on the Trials service, so a failure here says that, not that the chain is down.
  const { record } = opts;
  if (record) {
    const trialsRoute = (path: string, read: (wallet: string) => Promise<unknown>) =>
      app.get<{ Params: { address: string } }>(`/wallets/:address/${path}`, async (req, reply) => {
        const wallet = Address.safeParse(req.params.address);
        if (!wallet.success) return reply.code(400).send({ error: "INVALID_ADDRESS" });
        try {
          return await reply.header("cache-control", "no-store").send(await read(wallet.data));
        } catch (err) {
          req.log.warn({ error: (err as Error).message.split("\n")[0] }, `couldn't read a wallet's ${path}`);
          return reply.code(503).send({ error: "TRIALS_UNAVAILABLE" });
        }
      });
    trialsRoute("record", (w) => record.read(w));
    trialsRoute("ballot", (w) => record.ballot(w));
  }

  const { campaigns } = opts;
  if (campaigns) {
    const answer = async (req: FastifyRequest, reply: FastifyReply, read: () => Promise<unknown>, missing: string) => {
      try {
        const got = await read();
        if (!got) return await reply.code(404).send({ error: missing });
        return await reply.header("cache-control", "no-store").send(got);
      } catch (err) {
        req.log.warn({ error: (err as Error).message.split("\n")[0] }, "couldn't read a campaign");
        return reply.code(503).send({ error: "TRIALS_UNAVAILABLE" });
      }
    };
    app.get("/trials/campaigns", (req, reply) => answer(req, reply, () => campaigns.all(), "NO_ROUND"));
    app.get<{ Params: { token: string } }>("/trials/campaigns/:token", async (req, reply) => {
      const token = Address.safeParse(req.params.token);
      if (!token.success) return reply.code(400).send({ error: "INVALID_ADDRESS" });
      return answer(req, reply, () => campaigns.one(token.data), "NOT_A_CANDIDATE");
    });
  }

  const { round } = opts;
  if (round) {
    app.get("/trials/round", async (req, reply) => {
      try {
        const r = await round.read();
        if (!r) return await reply.code(404).send({ error: "NO_ROUND" });
        return await reply.header("cache-control", "no-store").send(r);
      } catch (err) {
        req.log.warn({ error: (err as Error).message.split("\n")[0] }, "couldn't read the Trials round");
        return reply.code(503).send({ error: "TRIALS_UNAVAILABLE" });
      }
    });
  }

  const { guard } = opts;
  if (guard) {
    // A wallet's alerts. `since` (a date) picks how far back; the default is a week.
    app.get<{ Params: { address: string }; Querystring: { since?: string } }>("/wallets/:address/guard", async (req, reply) => {
      const wallet = Address.safeParse(req.params.address);
      if (!wallet.success) return reply.code(400).send({ error: "INVALID_ADDRESS" });
      const since = req.query.since === undefined ? undefined : Date.parse(req.query.since);
      if (since !== undefined && Number.isNaN(since)) return reply.code(400).send({ error: "INVALID_SINCE" });
      try {
        return await reply.header("cache-control", "no-store").send(await guard.read(wallet.data, since));
      } catch (err) {
        req.log.warn({ error: (err as Error).message.split("\n")[0] }, "couldn't read a wallet's guard");
        return reply.code(503).send({ error: err instanceof NotReady ? "NOT_READY" : "CHAIN_UNAVAILABLE" });
      }
    });
  }

  const { basket } = opts;
  if (basket) {
    walletRoute("rewards", basket);
    app.get("/basket", async (req, reply) => {
      try {
        return await reply.header("cache-control", "no-store").send(await basket.basket());
      } catch (err) {
        req.log.warn({ error: (err as Error).message.split("\n")[0] }, "couldn't read the basket");
        return reply.code(503).send({ error: "INDEXER_UNAVAILABLE" });
      }
    });
  }

  const { stake } = opts;
  if (stake) {
    walletRoute("stake", stake);
    // What unstaking this much would cost, for the screen before signing. `amount` is raw PNTH, 18 decimals.
    app.get<{ Params: { address: string }; Querystring: { amount?: string } }>("/wallets/:address/stake/unstake-preview", async (req, reply) => {
      const wallet = Address.safeParse(req.params.address);
      if (!wallet.success) return reply.code(400).send({ error: "INVALID_ADDRESS" });
      if (!/^\d{1,40}$/.test(req.query.amount ?? "")) return reply.code(400).send({ error: "INVALID_AMOUNT" });
      try {
        return await reply.header("cache-control", "no-store").send(await stake.preview(wallet.data, BigInt(req.query.amount!)));
      } catch (err) {
        if (err instanceof UnstakeError) return reply.code(400).send({ error: err.code });
        req.log.warn({ error: (err as Error).message.split("\n")[0] }, "couldn't preview an unstake");
        return reply.code(503).send({ error: err instanceof NotReady ? "NOT_READY" : "CHAIN_UNAVAILABLE" });
      }
    });
  }

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
