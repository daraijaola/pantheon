// The feed server, proven endpoint by endpoint: valid and invalid input, the envelope, ETags, CORS, rate
// limits on a fake clock, timeouts, abuse (huge bodies, injection, malformed HTTP) and a small load burst.
// The real load and soak numbers come from scripts/feed-load.ts.
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request, type IncomingHttpHeaders, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { runDisputes } from "../scripts/disputes.ts";
import { fakeRecord, fakeToken } from "../src/live/fake.ts";
import { ENDPOINTS, RECORD_FIELDS } from "../src/live/format.ts";
import { createFeedServer, expiresOf, ipKey, RateLimiter, type FeedLimits, type FeedLogEvent, type FeedServerOptions } from "../src/live/server.ts";
import { FeedStore, type StoredDispute } from "../src/live/store.ts";
import { Dispute, disputeMessage, FeedRecord } from "../src/live/types.ts";

const T0 = 1_800_000_000_000;
const UNKNOWN = "0x00000000000000000000000000000000000000ff";
const OPEN: Limits = { get: { burst: 1e9, perSecond: 1e9 }, post: { burst: 1e9, perSecond: 1e9 }, postAll: { burst: 1e9, perSecond: 1e9 } };
type Limits = Partial<FeedLimits>;

type Harness = {
  base: string;
  port: number;
  store: FeedStore;
  clock: { t: number };
  disputes: StoredDispute[];
  logs: FeedLogEvent[];
};

const running: Array<{ server: Server; store: FeedStore }> = [];
afterEach(async () => {
  for (const { server, store } of running.splice(0)) {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    if (store.db.open) store.close();
  }
});

/** A feed server on a free port with `records` fake records, a fake clock, and limits open unless given. */
async function start(o: { records?: number; limits?: Limits; options?: Partial<FeedServerOptions> } = {}): Promise<Harness> {
  const store = new FeedStore(":memory:");
  for (let i = 0; i < (o.records ?? 10); i++) store.put(fakeRecord(i, { nowMs: T0 }), "launched");
  const clock = { t: T0 + 1_000 };
  const disputes: StoredDispute[] = [];
  const logs: FeedLogEvent[] = [];
  const server = createFeedServer({
    store,
    now: () => clock.t,
    limits: { ...OPEN, ...o.limits },
    log: (e) => logs.push(e),
    notifyDispute: (d) => void disputes.push(d),
    ...o.options,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  running.push({ server, store });
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, port, store, clock, disputes, logs };
}

type Answer = { status: number; headers: IncomingHttpHeaders; text: string; json: () => Record<string, unknown> };

/** One plain request with node:http (no fetch defaults), the body sent as given. */
function call(base: string, path: string, init: { method?: string; headers?: Record<string, string | number>; body?: string | Buffer } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request(`${base}${path}`, { method: init.method ?? "GET", headers: init.headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: () => JSON.parse(text) as Record<string, unknown> });
      });
    });
    req.on("error", reject);
    req.end(init.body);
  });
}

const get = (h: Harness, path: string, headers: Record<string, string> = {}) => call(h.base, path, { headers });
const post = (h: Harness, body: unknown, headers: Record<string, string> = {}) =>
  call(h.base, "/v1/dispute", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

/** Raw bytes on a socket: what came back, and whether the server closed the connection. */
function raw(port: number, data: string | Buffer, waitMs = 1_500): Promise<{ text: string; closed: boolean; ms: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const s = connect(port, "127.0.0.1");
    let text = "";
    const done = (closed: boolean) => {
      clearTimeout(timer);
      s.destroy();
      resolve({ text, closed, ms: Date.now() - t0 });
    };
    const timer = setTimeout(() => done(false), waitMs);
    s.on("data", (c: Buffer) => (text += c.toString("utf8")));
    s.on("close", () => done(true));
    s.on("error", () => done(true));
    s.write(data);
  });
}

/** Every item is {stale, record} with a record that passes the v1 format. */
function validItems(items: unknown): Array<{ stale: boolean; record: FeedRecord }> {
  const list = z.array(z.object({ stale: z.boolean(), record: FeedRecord }).strict()).parse(items);
  return list;
}

const ERROR_SHAPE = z.object({ v: z.literal(1), error: z.string().regex(/^[a-z-]+$/) }).loose();

// ---------------------------------------------------------------------------------------------------

describe("GET /v1/token/{address}", () => {
  it("serves the stored record exactly, inside the envelope", async () => {
    const h = await start();
    const a = await get(h, `/v1/token/${fakeToken(3).toUpperCase().replace("0X", "0x")}`);
    expect(a.status).toBe(200);
    expect(a.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(a.headers["cache-control"]).toBe("public, max-age=5");
    const body = a.json();
    expect(Object.keys(body)).toEqual(["v", "stale", "record", "servedAtMs"]);
    expect(body).toMatchObject({ v: 1, stale: false, servedAtMs: h.clock.t });
    expect(body.record).toEqual(h.store.get(fakeToken(3)));
    expect(FeedRecord.parse(body.record)).toEqual(body.record);
  });

  it("says stale once the clock passes expiresAtMs, and leaves the record's own fields alone", async () => {
    const h = await start();
    const rec = h.store.get(fakeToken(2))!;
    h.clock.t = rec.expiresAtMs;
    expect((await get(h, `/v1/token/${fakeToken(2)}`)).json().stale).toBe(false);
    h.clock.t = rec.expiresAtMs + 1;
    const body = (await get(h, `/v1/token/${fakeToken(2)}`)).json();
    expect(body.stale).toBe(true);
    expect(body.record).toEqual(rec);
    expect(h.store.get(fakeToken(2))).toEqual(rec);
  });

  it("answers 404 unknown, with the lowercase address, for a coin it has not seen", async () => {
    const h = await start();
    const a = await get(h, `/v1/token/${UNKNOWN.toUpperCase().replace("0X", "0x")}`);
    expect(a.status).toBe(404);
    expect(a.json()).toEqual({ v: 1, error: "unknown", token: UNKNOWN });
    expect(a.headers["cache-control"]).toBe("no-store");
  });

  it.each([
    "0x123",
    `0x${"g".repeat(40)}`,
    `0x${"a".repeat(41)}`,
    `0x${"a".repeat(39)}`,
    "a".repeat(42),
    `0X${"a".repeat(40)}`,
    "%3Cscript%3Ealert(1)%3C%2Fscript%3E",
    `0x${"a".repeat(39)}%00`,
    `0x${"a".repeat(38)}%EF%BC%90%EF%BC%90`,
    "javascript:alert(1)",
  ])("refuses a bad address (%s) without echoing it", async (bad) => {
    const h = await start();
    const a = await get(h, `/v1/token/${bad}`);
    expect(a.status).toBe(400);
    expect(a.json()).toEqual({ v: 1, error: "bad-address" });
  });

  it("accepts a trailing slash and the /api/delphi prefix", async () => {
    const h = await start();
    expect((await get(h, `/v1/token/${fakeToken(1)}/`)).status).toBe(200);
    expect((await get(h, `/api/delphi/v1/token/${fakeToken(1)}`)).status).toBe(200);
  });
});

describe("GET /v1/tokens", () => {
  it("answers in the order asked, lists unknown ones in missing, and answers a repeat once", async () => {
    const h = await start();
    const ids = [fakeToken(3), UNKNOWN, fakeToken(1), fakeToken(3).toUpperCase().replace("0X", "0x"), "0x00000000000000000000000000000000000000ee"];
    const a = await get(h, `/v1/tokens?ids=${ids.join(",")}`);
    expect(a.status).toBe(200);
    const body = a.json();
    expect(Object.keys(body)).toEqual(["v", "items", "missing", "servedAtMs"]);
    const items = validItems(body.items);
    expect(items.map((i) => i.record.token)).toEqual([fakeToken(3), fakeToken(1)]);
    expect(body.missing).toEqual([UNKNOWN, "0x00000000000000000000000000000000000000ee"]);
    expect(items[0]!.record).toEqual(h.store.get(fakeToken(3)));
  });

  it("serves 50 at once, every one a valid v1 record with its own stale flag", async () => {
    const h = await start({ records: 60 });
    h.store.put(fakeRecord(7, { nowMs: T0 }, { checkedAtMs: T0, expiresAtMs: T0 + 500 }), "short-lived");
    const ids = Array.from({ length: 50 }, (_, i) => fakeToken(i));
    const items = validItems((await get(h, `/v1/tokens?ids=${ids.join(",")}`)).json().items);
    expect(items).toHaveLength(50);
    expect(items.filter((i) => i.stale).map((i) => i.record.token)).toEqual([fakeToken(7)]);
  });

  it("refuses more than 50 ids", async () => {
    const h = await start();
    const ids = Array.from({ length: 51 }, (_, i) => fakeToken(i));
    const a = await get(h, `/v1/tokens?ids=${ids.join(",")}`);
    expect(a.status).toBe(400);
    expect(a.json()).toEqual({ v: 1, error: "too-many", max: 50 });
  });

  it.each(["/v1/tokens", "/v1/tokens?ids=", "/v1/tokens?ids=,,,", "/v1/tokens?other=1"])("refuses a call without ids (%s)", async (path) => {
    const h = await start();
    const a = await get(h, path);
    expect(a.status).toBe(400);
    expect(a.json()).toEqual({ v: 1, error: "bad-ids" });
  });

  it("refuses the whole batch for one bad address, saying which, without echoing it", async () => {
    const h = await start();
    const a = await get(h, `/v1/tokens?ids=${fakeToken(1)},${encodeURIComponent("<img src=x onerror=alert(1)>")},${fakeToken(2)}`);
    expect(a.status).toBe(400);
    expect(a.json()).toEqual({ v: 1, error: "bad-address", index: 1 });
  });

  it("also takes addresses= (the name in our first notes to Kalos)", async () => {
    const h = await start();
    const body = (await get(h, `/v1/tokens?addresses=${fakeToken(1)}`)).json();
    expect(validItems(body.items)).toHaveLength(1);
  });
});

describe("GET /v1/new", () => {
  it("lists the newest launches first, by venue, and pages with next/before", async () => {
    const h = await start({ records: 30 });
    const all = (await get(h, "/v1/new?limit=100")).json();
    const items = validItems(all.items);
    expect(items).toHaveLength(30);
    expect(items.map((i) => Number(i.record.launch.block))).toEqual([...items.map((i) => Number(i.record.launch.block))].sort((a, b) => b - a));
    expect(all.next).toBeNull();
    expect(all.venue).toBeNull();

    const kalos = (await get(h, "/v1/new?venue=kalos")).json();
    expect(kalos.venue).toBe("kalos");
    expect(validItems(kalos.items).every((i) => i.record.venue === "kalos")).toBe(true);

    const seen: string[] = [];
    let before: unknown = null;
    for (let page = 0; page < 10; page++) {
      const body = (await get(h, `/v1/new?limit=7${before ? `&before=${String(before)}` : ""}`)).json();
      seen.push(...validItems(body.items).map((i) => i.record.token));
      before = body.next;
      if (before === null) break;
      expect(before).toBe(validItems(body.items).at(-1)!.record.launch.block);
    }
    expect(seen).toEqual(items.map((i) => i.record.token));
  });

  it("defaults to 50", async () => {
    const h = await start({ records: 60 });
    const body = (await get(h, "/v1/new")).json();
    expect(validItems(body.items)).toHaveLength(50);
    expect(body.next).toBe(h.store.recent({ limit: 50 }).at(-1)!.launch.block);
  });

  it("answers an empty list for an empty feed", async () => {
    const h = await start({ records: 0 });
    expect((await get(h, "/v1/new")).json()).toMatchObject({ v: 1, items: [], next: null });
  });

  it.each([
    ["venue=pump", "bad-venue"],
    ["venue=%3Cscript%3E", "bad-venue"],
    ["venue=KALOS", "bad-venue"],
    ["limit=0", "bad-limit"],
    ["limit=101", "bad-limit"],
    ["limit=-1", "bad-limit"],
    ["limit=abc", "bad-limit"],
    ["limit=1.5", "bad-limit"],
    ["limit=1e2", "bad-limit"],
    ["limit=99999999999", "bad-limit"],
    ["before=abc", "bad-before"],
    ["before=-1", "bad-before"],
    ["before=1e9", "bad-before"],
    ["before=1234567890123456", "bad-before"],
  ])("refuses %s", async (q, error) => {
    const h = await start();
    const a = await get(h, `/v1/new?${q}`);
    expect(a.status).toBe(400);
    expect(a.json()).toMatchObject({ v: 1, error });
    expect(a.text).not.toMatch(/script|pump|abc/i);
  });
});

describe("GET /v1/history/{address}", () => {
  it("lists every verdict the coin has had, oldest first, with why", async () => {
    const h = await start({ records: 0 });
    const r = fakeRecord(1, { nowMs: T0 });
    h.store.put({ ...r, state: "pending", verdict: "CHECKING", checkedAtMs: T0 }, "launched");
    h.store.put({ ...r, checkedAtMs: T0 + 1 }, "4 linked wallets bought 17% at launch");
    const body = (await get(h, `/v1/history/${r.token}`)).json();
    expect(body).toEqual({
      v: 1,
      token: r.token,
      items: [
        { atMs: T0, verdict: "CHECKING", rules: "fake-seed", why: "launched" },
        { atMs: T0 + 1, verdict: r.verdict, rules: "fake-seed", why: "4 linked wallets bought 17% at launch" },
      ],
      servedAtMs: h.clock.t,
    });
  });

  it("answers unknown for a coin it has not seen, and refuses a bad address", async () => {
    const h = await start();
    expect((await get(h, `/v1/history/${UNKNOWN}`)).json()).toEqual({ v: 1, error: "unknown", token: UNKNOWN });
    expect((await get(h, "/v1/history/0x1")).json()).toEqual({ v: 1, error: "bad-address" });
  });
});

describe("GET /v1/health", () => {
  it("says ok, the newest update time and the version, and is never cached", async () => {
    const h = await start({ records: 3 });
    const a = await get(h, "/v1/health");
    expect(a.status).toBe(200);
    expect(a.headers["cache-control"]).toBe("no-store");
    expect(a.headers.etag).toBeUndefined();
    expect(a.json()).toEqual({ v: 1, ok: true, version: "1.0.0", newestUpdateMs: T0, newestUpdateAgeMs: h.clock.t - T0, recordCount: 3, empty: false, stale: false, servedAtMs: h.clock.t });
  });

  it("stays cheap however big the feed gets: the newest update comes from an index, never a scan", async () => {
    const h = await start({ records: 0 });
    const plan = h.store.db.prepare("EXPLAIN QUERY PLAN SELECT MAX(updated_ms) FROM feed").all() as Array<{ detail: string }>;
    expect(plan.map((p) => p.detail).join(" ")).toMatch(/USING COVERING INDEX feed_updated/);
  });

  it("says null for an empty feed, and 503 when the database is gone", async () => {
    const h = await start({ records: 0 });
    expect((await get(h, "/v1/health")).json()).toMatchObject({ ok: true, newestUpdateMs: null, newestUpdateAgeMs: null, recordCount: 0, empty: true, stale: true });
    h.store.close();
    const a = await get(h, "/v1/health");
    expect(a.status).toBe(503);
    expect(a.json()).toMatchObject({ v: 1, ok: false });
  });

  it("marks the newest record stale only after its expiry, and clears on a fresh scan", async () => {
    const h = await start({ records: 1 });
    const r = h.store.get(fakeToken(0))!;
    h.clock.t = r.expiresAtMs;
    expect((await get(h, "/v1/health")).json()).toMatchObject({ stale: false });
    h.clock.t++;
    expect((await get(h, "/v1/health")).json()).toMatchObject({ ok: true, stale: true, empty: false, newestUpdateAgeMs: h.clock.t - T0 });
    h.store.put({ ...r, checkedAtMs: h.clock.t, expiresAtMs: h.clock.t + 1000 });
    expect((await get(h, "/v1/health")).json()).toMatchObject({ stale: false, newestUpdateAgeMs: 0 });
  });
});

/** Every field path a JSON Schema describes (`[]` for list items). */
function schemaPaths(s: Record<string, unknown>, prefix = ""): string[] {
  const out: string[] = [];
  for (const v of (s.anyOf as Array<Record<string, unknown>> | undefined) ?? [s]) {
    if (v.type === "object" && v.properties)
      for (const [k, sub] of Object.entries(v.properties as Record<string, Record<string, unknown>>)) {
        const p = prefix ? `${prefix}.${k}` : k;
        out.push(p, ...schemaPaths(sub, p));
      }
    if (v.type === "array" && v.items) out.push(...schemaPaths(v.items as Record<string, unknown>, `${prefix}[]`));
  }
  return out;
}

describe("GET /v1/format", () => {
  it("describes every record field the v1 schema has, and no others", async () => {
    const h = await start();
    const body = (await get(h, "/v1/format")).json();
    const fromSchema = schemaPaths(z.toJSONSchema(FeedRecord) as Record<string, unknown>);
    const described = (body.record as Array<{ path: string; meaning: string }>).map((f) => f.path);
    expect(new Set(described)).toEqual(new Set(fromSchema));
    expect(described).toHaveLength(fromSchema.length);
    expect((body.record as Array<{ meaning: string }>).every((f) => f.meaning.length > 10)).toBe(true);
    expect((body.schema as { record: unknown }).record).toEqual(z.toJSONSchema(FeedRecord));
    expect((body.endpoints as unknown[]).length).toBe(ENDPOINTS.length);
    expect(body.servedAtMs).toBe(h.clock.t);
  });

  it("matches docs/kalos-adapter.md, which lists every field and endpoint", () => {
    const doc = readFileSync(new URL("../docs/kalos-adapter.md", import.meta.url), "utf8");
    for (const f of RECORD_FIELDS) expect(doc, f.path).toContain(`| \`${f.path}\` |`);
    for (const e of ["/v1/tokens", "/v1/token/", "/v1/new", "/v1/history/", "/v1/health", "/v1/format", "/v1/dispute"]) expect(doc).toContain(e);
  });
});

describe("the adapter in docs/kalos-adapter.md", () => {
  it("fetches a batch, answers holders(t) and dev(t) from its cache, and shows nothing when DELPHI is down", async () => {
    const h = await start({ records: 0 });
    for (let i = 0; i < 5; i++) h.store.put(fakeRecord(i, { nowMs: Date.now() }));
    h.clock.t = Date.now();
    const doc = readFileSync(new URL("../docs/kalos-adapter.md", import.meta.url), "utf8");
    const code = /```js\n([\s\S]*?)```/.exec(doc)![1]!;
    expect(code.trim().split("\n").length).toBeLessThanOrEqual(20);
    const dir = mkdtempSync(join(tmpdir(), "delphi-adapter-"));
    try {
      writeFileSync(join(dir, "adapter.mjs"), code);
      const mod = (await import(pathToFileURL(join(dir, "adapter.mjs")).href)) as {
        delphiInsights: (ctx: { emit: (e: string) => void }, base: string) => { refresh: (t: string[]) => Promise<void>; holders: (t: unknown) => unknown; dev: (t: unknown) => unknown };
      };
      const emitted: string[] = [];
      const ins = mod.delphiInsights({ emit: (e) => emitted.push(e) }, `${h.base}/v1`);
      expect(ins.holders(fakeToken(1))).toBeNull();
      await ins.refresh([fakeToken(1), fakeToken(2).toUpperCase().replace("0X", "0x"), UNKNOWN]);
      expect(emitted).toEqual(["sniper-insights"]);
      const rec = h.store.get(fakeToken(1))!;
      expect(ins.holders(fakeToken(1))).toEqual(rec.holders);
      expect(ins.holders({ address: fakeToken(1).toUpperCase().replace("0X", "0x") })).toEqual(rec.holders);
      expect(ins.dev(fakeToken(2))).toEqual(h.store.get(fakeToken(2))!.dev);
      expect(ins.dev(UNKNOWN)).toBeNull();
      // DELPHI goes down: no throw, no event, nothing new.
      const dead = mod.delphiInsights({ emit: (e) => emitted.push(e) }, "http://127.0.0.1:1/v1");
      await dead.refresh([fakeToken(1)]);
      expect(dead.holders(fakeToken(1))).toBeNull();
      expect(emitted).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("POST /v1/dispute", () => {
  const good = { token: fakeToken(1), contact: "@someone", message: "Those two wallets are a market maker, not the dev." };

  it("stores a dispute, says its id, and tells a person", async () => {
    const h = await start();
    const a = await post(h, { ...good, token: good.token.toUpperCase().replace("0X", "0x") });
    expect(a.status).toBe(201);
    expect(a.headers["cache-control"]).toBe("no-store");
    expect(a.headers["access-control-allow-origin"]).toBe("*");
    const body = a.json();
    expect(body).toEqual({ v: 1, ok: true, id: expect.any(Number), status: "open" });
    const stored = h.store.disputes("open");
    expect(stored).toEqual([{ ...good, id: body.id, atMs: h.clock.t, status: "open", answer: null }]);
    expect(h.disputes).toEqual(stored);
    expect(h.logs).toContainEqual({ kind: "dispute", id: body.id, token: good.token });
  });

  it("keeps a script-injection message as plain text and never reflects it", async () => {
    const h = await start();
    const evil = `<script>alert(document.cookie)</script><img src=x onerror="alert(1)">'; DROP TABLE disputes;--`;
    const a = await post(h, { ...good, contact: "<b>me</b>", message: evil });
    expect(a.status).toBe(201);
    expect(a.text).not.toMatch(/[<>]/);
    expect(a.headers["x-content-type-options"]).toBe("nosniff");
    expect(a.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(h.store.disputes()[0]).toMatchObject({ contact: "<b>me</b>", message: evil });
    // A bad dispute's answer names fields, never their values.
    const b = await post(h, { token: "<script>alert(1)</script>", contact: 1, message: evil });
    expect(b.status).toBe(400);
    expect(b.json()).toEqual({ v: 1, error: "bad-dispute", fields: ["token", "contact"] });
    expect(b.text).not.toMatch(/[<>]/);
  });

  it("refuses a body over 4 KB and stores nothing", async () => {
    const h = await start();
    const a = await post(h, { ...good, message: "x".repeat(5_000) });
    expect(a.status).toBe(413);
    expect(a.json()).toEqual({ v: 1, error: "too-large", max: 4096 });
    expect(a.headers.connection).toBe("close");
    expect(h.store.disputes()).toHaveLength(0);
  });

  it("cuts off a huge streamed body (no Content-Length), stores nothing, and keeps serving", async () => {
    const h = await start();
    const answer = await new Promise<number | string>((resolve) => {
      const req = request(`${h.base}/v1/dispute`, { method: "POST", headers: { "content-type": "application/json", "transfer-encoding": "chunked" }, agent: false }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", (e: NodeJS.ErrnoException) => resolve(e.code ?? "error"));
      req.write(`{"token":"${good.token}","contact":"x","message":"`);
      const chunk = Buffer.alloc(64 * 1024, "a");
      let sent = 0;
      const pump = () => {
        while (sent < 20 * 1024 * 1024) {
          sent += chunk.length;
          if (!req.write(chunk)) return req.once("drain", pump);
        }
        req.end('"}');
      };
      pump();
    });
    expect([413, "ECONNRESET", "EPIPE"]).toContain(answer);
    expect(h.store.disputes()).toHaveLength(0);
    expect((await get(h, "/v1/health")).status).toBe(200);
  });

  it.each(["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "text/json", "application/jsonp", ""])("refuses Content-Type %j with 415", async (type) => {
    const h = await start();
    const a = await call(h.base, "/v1/dispute", { method: "POST", headers: type ? { "content-type": type } : {}, body: JSON.stringify(good) });
    expect(a.status).toBe(415);
    expect(a.json()).toEqual({ v: 1, error: "bad-content-type" });
    expect(h.store.disputes()).toHaveLength(0);
  });

  it("takes application/json with a charset", async () => {
    const h = await start();
    expect((await post(h, good, { "content-type": "application/json; charset=utf-8" })).status).toBe(201);
  });

  it.each(["{", "", "nul", '{"token":', "\ufeff{}", "{'token': 1}"])("refuses broken JSON %j", async (body) => {
    const h = await start();
    const a = await post(h, body);
    expect(a.status).toBe(400);
    expect(a.json()).toEqual({ v: 1, error: "bad-json" });
  });

  const C = (n: number) => String.fromCharCode(n);
  it.each<[string, unknown, string[]]>([
    ["no message", { token: good.token, contact: "x" }, ["message"]],
    ["a message over 1,200 characters", { ...good, message: "m".repeat(1_201) }, ["message"]],
    ["a contact over 120 characters", { ...good, contact: "c".repeat(121) }, ["contact"]],
    ["a short token", { ...good, token: "0x123" }, ["token"]],
    ["a number token", { ...good, token: 123 }, ["token"]],
    ["a number contact", { ...good, contact: 5 }, ["contact"]],
    ["a list message", { ...good, message: ["a"] }, ["message"]],
    ["an empty message", { ...good, message: "   \n " }, ["message"]],
    ["terminal escapes in the message", { ...good, message: `fine${C(27)}[2J${C(27)}]0;pwned${C(7)}` }, ["message"]],
    ["a null byte in the contact", { ...good, contact: `a${C(0)}b` }, ["contact"]],
    ["a direction override in the contact", { ...good, contact: `@me${C(0x202e)}gpj.exe` }, ["contact"]],
    ["a list body", [good], ["token", "contact", "message"]],
    ["a null body", null, ["token", "contact", "message"]],
    ["a string body", "hello", ["token", "contact", "message"]],
  ])("refuses %s, naming the bad fields", async (_name, body, fields) => {
    const h = await start();
    const a = await post(h, JSON.stringify(body));
    expect(a.status).toBe(400);
    expect(a.json()).toEqual({ v: 1, error: "bad-dispute", fields });
    expect(h.store.disputes()).toHaveLength(0);
  });

  it("keeps line breaks, tabs and any language in a message", async () => {
    const h = await start();
    const message = "Line one\nLine two\twith a tab. 这是做市商 — مرحبا 👋";
    expect((await post(h, { ...good, message })).status).toBe(201);
    expect(h.store.disputes()[0]!.message).toBe(message);
  });

  it("refuses a dispute about a coin DELPHI has no record of", async () => {
    const h = await start();
    const a = await post(h, { ...good, token: UNKNOWN });
    expect(a.status).toBe(404);
    expect(a.json()).toEqual({ v: 1, error: "unknown", token: UNKNOWN });
    expect(h.store.disputes()).toHaveLength(0);
  });

  it("stores only the three fields, ignoring any others", async () => {
    const h = await start();
    expect((await post(h, { ...good, status: "changed", id: 99, answer: "ok", __proto__: { admin: true } })).status).toBe(201);
    expect(h.store.disputes()[0]).toMatchObject({ status: "open", answer: null });
    expect(Dispute.strict().safeParse({ token: good.token, contact: good.contact, message: good.message }).success).toBe(true);
  });

  it("still takes the dispute when telling a person fails", async () => {
    const h = await start({
      options: {
        notifyDispute: () => {
          throw new Error("disk full");
        },
      },
    });
    expect((await post(h, good)).status).toBe(201);
    await new Promise((r) => setTimeout(r, 10));
    expect(h.store.disputes()).toHaveLength(1);
    expect(h.logs).toContainEqual({ kind: "error", route: "dispute", message: "notifyDispute: disk full" });
  });

  it("refuses GET, PUT and DELETE, saying what is allowed", async () => {
    const h = await start();
    for (const method of ["GET", "PUT", "DELETE", "HEAD"]) {
      const a = await call(h.base, "/v1/dispute", { method });
      expect(a.status).toBe(405);
      expect(a.headers.allow).toBe("POST, OPTIONS");
    }
  });
});

describe("POST /v1/dispute, signed by the wallet", () => {
  const good = { token: fakeToken(1), contact: "@someone", message: "That wallet is our market maker, not the dev." };
  // fresh keys every run: no key material in the repo
  const me = privateKeyToAccount(generatePrivateKey());
  const other = privateKeyToAccount(generatePrivateKey());
  const nowSec = (h: Harness) => Math.floor(h.clock.t / 1000);
  /** The dispute with a signature over its message, by `me` unless told otherwise. */
  const signed = async (h: Harness, o: { by?: typeof me; signedAt?: number } = {}) => {
    const signedAt = o.signedAt ?? nowSec(h);
    const signature = await (o.by ?? me).signMessage({ message: disputeMessage({ token: good.token, message: good.message, signedAt }) });
    return { ...good, wallet: me.address, signedAt, signature };
  };

  it("keeps the wallet that signed it for the person answering, and answers only that it was signed", async () => {
    const h = await start();
    const a = await post(h, await signed(h));
    expect(a.status).toBe(201);
    expect(a.json()).toEqual({ v: 1, ok: true, id: expect.any(Number), status: "open", signed: true });
    expect(a.text.toLowerCase()).not.toContain(me.address.slice(2).toLowerCase());
    const stored = h.store.disputes()[0]!;
    expect(stored).toEqual({ ...good, id: stored.id, atMs: h.clock.t, status: "open", answer: null, wallet: me.address.toLowerCase() });
    expect(h.disputes).toEqual([stored]);
    expect(h.logs).toContainEqual({ kind: "dispute", id: stored.id, token: good.token, signed: true });
    // the wallet can come in any case
    expect((await post(h, { ...(await signed(h)), wallet: me.address.toLowerCase() })).status).toBe(201);
  });

  it("refuses another wallet's signature, or one over another message, and stores nothing", async () => {
    const h = await start();
    const bodies = [
      await signed(h, { by: other }), // signed by someone else for my wallet
      { ...(await signed(h)), message: "Changed after signing." },
      { ...(await signed(h)), token: fakeToken(2) },
      { ...(await signed(h)), signedAt: nowSec(h) - 1 },
      { ...(await signed(h)), signature: `0x${"ab".repeat(65)}` },
    ];
    for (const body of bodies) {
      const a = await post(h, body);
      expect(a.status).toBe(400);
      expect(a.json()).toEqual({ v: 1, error: "bad-signature" });
    }
    expect(h.store.disputes()).toHaveLength(0);
  });

  it("refuses a signature made more than 10 minutes from the server's clock, either way", async () => {
    const h = await start();
    for (const off of [-601, 601, -86_400]) {
      const a = await post(h, await signed(h, { signedAt: nowSec(h) + off }));
      expect(a.status).toBe(400);
      expect(a.json()).toEqual({ v: 1, error: "stale-signature" });
    }
    expect(h.store.disputes()).toHaveLength(0);
    for (const off of [-600, 600]) expect((await post(h, await signed(h, { signedAt: nowSec(h) + off }))).status).toBe(201);
  });

  it("needs all three of wallet, signedAt and signature, and names the ones missing or bad", async () => {
    const h = await start();
    const s = await signed(h);
    const cases: Array<[unknown, string[]]> = [
      [{ ...good, wallet: s.wallet }, ["signedAt", "signature"]],
      [{ ...good, signature: s.signature }, ["wallet", "signedAt"]],
      [{ ...s, wallet: "0x123" }, ["wallet"]],
      [{ ...s, signedAt: String(s.signedAt) }, ["signedAt"]],
      [{ ...s, signedAt: s.signedAt + 0.5 }, ["signedAt"]],
      [{ ...s, signature: "not a signature" }, ["signature"]],
      [{ ...s, signature: "0xabc" }, ["signature"]],
      [{ ...s, contact: 5, wallet: 7 }, ["contact", "wallet"]],
    ];
    for (const [body, fields] of cases) {
      const a = await post(h, body);
      expect(a.status, JSON.stringify(body)).toBe(400);
      expect(a.json()).toEqual({ v: 1, error: "bad-dispute", fields });
    }
    expect(h.store.disputes()).toHaveLength(0);
  });

  it("leaves the unsigned form exactly as it was", async () => {
    const h = await start();
    const a = await post(h, good);
    expect(a.status).toBe(201);
    const id = a.json().id;
    expect(a.text).toBe(`{"v":1,"ok":true,"id":${id},"status":"open"}`);
    const stored = h.store.disputes()[0]!;
    expect(stored).toEqual({ ...good, id, atMs: h.clock.t, status: "open", answer: null });
    expect(stored).not.toHaveProperty("wallet");
    expect(h.logs).toContainEqual({ kind: "dispute", id, token: good.token });
    // empty signed fields are no signature at all
    const b = await post(h, { ...good, wallet: null, signedAt: null, signature: null });
    expect(b.text).toBe(`{"v":1,"ok":true,"id":${b.json().id},"status":"open"}`);
  });

  it("is described at /v1/format and in docs/kalos-adapter.md", async () => {
    const h = await start();
    const f = (await get(h, "/v1/format")).json() as { signedDispute: { message: string; signedAtWindowSec: number }; errors: Record<string, string>; schema: Record<string, unknown> };
    expect(f.signedDispute).toMatchObject({ message: expect.stringMatching(/^PANTHEON dispute\ncoin: .*\nmessage sha256: .*\nsigned at: /), signedAtWindowSec: 600 });
    expect(Object.keys(f.errors)).toEqual(expect.arrayContaining(["bad-signature", "stale-signature"]));
    expect(f.schema.disputeSignature).toBeDefined();
    const doc = readFileSync(new URL("../docs/kalos-adapter.md", import.meta.url), "utf8");
    for (const s of ["PANTHEON dispute", "message sha256:", "signed at:", "stale-signature", "bad-signature", "signed:true"]) expect(doc, s).toContain(s);
  });

  it("checks with the verifier it is given, so a node can check smart wallets", async () => {
    const SAFE = "0x5afe00000000000000000000000000000000cafe";
    const asked: unknown[] = [];
    const h = await start({ options: { verifySigner: async (a) => (asked.push(a), a.address.toLowerCase() === SAFE) } });
    const signedAt = nowSec(h);
    const body = { ...good, wallet: SAFE, signedAt, signature: "0x1234" };
    expect((await post(h, body)).json()).toMatchObject({ ok: true, signed: true });
    expect(asked).toEqual([{ address: getAddress(SAFE), message: disputeMessage({ token: good.token, message: good.message, signedAt }), signature: "0x1234" }]);
    expect((await post(h, { ...body, wallet: me.address })).json()).toEqual({ v: 1, error: "bad-signature" });
  });
});

describe("HTTP behaviour", () => {
  it("is open to every origin on every answer: data, errors, 304 and 429", async () => {
    const h = await start({ limits: { get: { burst: 6, perSecond: 1 } } });
    const origin = { origin: "https://kalos.fun" };
    const ok = await get(h, `/v1/token/${fakeToken(1)}`, origin);
    const answers = [
      ok,
      await get(h, `/v1/token/${fakeToken(1)}`, { ...origin, "if-none-match": ok.headers.etag! }),
      await get(h, `/v1/token/${UNKNOWN}`, origin),
      await get(h, "/v1/token/0x1", origin),
      await get(h, "/nope", origin),
      await post(h, "{", origin),
      await get(h, "/v1/health", origin),
      await get(h, "/v1/health", origin),
    ];
    expect(answers.map((a) => a.status)).toEqual([200, 304, 404, 400, 404, 400, 200, 429]);
    for (const a of answers) {
      expect(a.headers["access-control-allow-origin"]).toBe("*");
      expect(a.headers["access-control-expose-headers"]).toBe("ETag, Retry-After");
      expect(a.headers["x-content-type-options"]).toBe("nosniff");
      if (a.status >= 400) expect(() => ERROR_SHAPE.parse(a.json())).not.toThrow();
    }
  });

  it("answers CORS preflights for reads and disputes", async () => {
    const h = await start();
    for (const path of [`/v1/tokens?ids=${fakeToken(1)}`, "/v1/dispute"]) {
      const a = await call(h.base, path, {
        method: "OPTIONS",
        headers: { origin: "https://kalos.fun", "access-control-request-method": path.includes("dispute") ? "POST" : "GET", "access-control-request-headers": "content-type, if-none-match" },
      });
      expect(a.status).toBe(204);
      expect(a.text).toBe("");
      expect(a.headers).toMatchObject({
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, HEAD, POST, OPTIONS",
        "access-control-allow-headers": "Content-Type, If-None-Match",
        "access-control-max-age": "86400",
      });
    }
  });

  it("answers HEAD with the GET's headers and no body", async () => {
    const h = await start();
    const g = await get(h, `/v1/tokens?ids=${fakeToken(1)},${fakeToken(2)}`);
    const hd = await call(h.base, `/v1/tokens?ids=${fakeToken(1)},${fakeToken(2)}`, { method: "HEAD" });
    expect(hd.status).toBe(200);
    expect(hd.text).toBe("");
    expect(hd.headers.etag).toBe(g.headers.etag);
    expect(hd.headers["content-length"]).toBe(g.headers["content-length"]);
    expect(hd.headers["content-type"]).toBe("application/json; charset=utf-8");
  });

  it("refuses writes to read endpoints with 405 and Allow", async () => {
    const h = await start();
    for (const [method, path] of [
      ["POST", `/v1/token/${fakeToken(1)}`],
      ["PUT", "/v1/tokens"],
      ["DELETE", "/v1/health"],
      ["PATCH", "/v1/format"],
    ] as const) {
      const a = await call(h.base, path, { method });
      expect(a.status, `${method} ${path}`).toBe(405);
      expect(a.headers.allow).toBe("GET, HEAD, OPTIONS");
      expect(a.json()).toEqual({ v: 1, error: "method-not-allowed" });
    }
  });

  it.each(["/", "/v1", "/v1/", "/v2/health", "/v1/token", "/v1/tokens/extra", "/v1/health/x", "/v1/unknown", "/v1/token/a/b", "/api/v1/health", "/V1/health", "/v1/../../etc/passwd"])(
    "answers 404 not-found for %s",
    async (path) => {
      const h = await start();
      const a = await get(h, path);
      expect(a.status).toBe(404);
      expect(a.json()).toEqual({ v: 1, error: "not-found" });
    },
  );

  it("refuses a URL over 4 KB", async () => {
    const h = await start();
    const a = await get(h, `/v1/tokens?ids=${"a".repeat(5_000)}`);
    expect(a.status).toBe(414);
    expect(a.json()).toEqual({ v: 1, error: "url-too-long" });
  });

  it("answers headers over 8 KB with 431 in JSON, and malformed HTTP with 400", async () => {
    const h = await start();
    const big = await raw(h.port, `GET /v1/health HTTP/1.1\r\nHost: x\r\nX-Big: ${"a".repeat(10_000)}\r\n\r\n`);
    expect(big.text).toMatch(/^HTTP\/1\.1 431 /);
    expect(big.text).toContain('{"v":1,"error":"bad-request"}');
    expect(big.closed).toBe(true);
    for (const junk of ["GARBAGE\r\n\r\n", "GET /v1/health HTTP/9.9\r\n\r\n", "GET /v1/health HTTP/1.1\r\nHost: x\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\n"]) {
      const a = await raw(h.port, junk);
      expect(a.text, junk).toMatch(/^HTTP\/1\.1 400 /);
      expect(a.text).toContain('{"v":1,"error":"bad-request"}');
      expect(a.text).toContain("Access-Control-Allow-Origin: *");
    }
  });

  it("never shows a stack trace when something breaks inside", async () => {
    const h = await start();
    h.store.close();
    for (const path of [`/v1/token/${fakeToken(1)}`, `/v1/tokens?ids=${fakeToken(1)}`, "/v1/new", `/v1/history/${fakeToken(1)}`]) {
      const a = await get(h, path);
      expect(a.status, path).toBe(500);
      expect(a.text).toBe('{"v":1,"error":"internal"}');
    }
    expect(h.logs.filter((e) => e.kind === "error").length).toBe(4);
    expect(h.logs.find((e) => e.kind === "error")).toMatchObject({ route: "token", message: expect.stringContaining("not open") });
  });

  it("logs each request's route, status and time, never its address or query", async () => {
    const h = await start();
    await get(h, `/v1/tokens?ids=${fakeToken(1)}`);
    await get(h, "/v1/nope?x=<script>");
    const reqs = h.logs.filter((e) => e.kind === "request");
    expect(reqs).toEqual([
      { kind: "request", method: "GET", route: "tokens", status: 200, ms: expect.any(Number) },
      { kind: "request", method: "GET", route: "other", status: 404, ms: expect.any(Number) },
    ]);
  });
});

describe("ETag and 304", () => {
  it("keeps the ETag while only servedAtMs moves, and answers 304 with no body", async () => {
    const h = await start();
    const path = `/v1/tokens?ids=${fakeToken(1)},${fakeToken(2)}`;
    const a = await get(h, path);
    h.clock.t += 1_000;
    const b = await get(h, path);
    expect(b.json().servedAtMs).toBe(h.clock.t);
    expect(b.headers.etag).toBe(a.headers.etag);
    expect(a.headers.etag).toMatch(/^W\/"[A-Za-z0-9_-]{22}"$/);
    const c = await get(h, path, { "if-none-match": a.headers.etag! });
    expect(c.status).toBe(304);
    expect(c.text).toBe("");
    expect(c.headers.etag).toBe(a.headers.etag);
    expect(c.headers["cache-control"]).toBe("public, max-age=5");
  });

  it("changes the ETag when a record changes, and when it goes stale", async () => {
    const h = await start();
    const path = `/v1/token/${fakeToken(1)}`;
    const e1 = (await get(h, path)).headers.etag!;
    h.store.put(fakeRecord(1, { nowMs: T0 }, { checkedAtMs: T0 + 5 }), "rechecked");
    const changed = await get(h, path, { "if-none-match": e1 });
    expect(changed.status).toBe(200);
    const e2 = changed.headers.etag!;
    expect(e2).not.toBe(e1);
    h.clock.t = h.store.get(fakeToken(1))!.expiresAtMs + 1;
    const stale = await get(h, path, { "if-none-match": e2 });
    expect(stale.status).toBe(200);
    expect(stale.json().stale).toBe(true);
    expect(stale.headers.etag).not.toBe(e2);
  });

  it("matches * and lists of ETags, strong or weak", async () => {
    const h = await start();
    const path = `/v1/token/${fakeToken(1)}`;
    const etag = (await get(h, path)).headers.etag!;
    expect((await get(h, path, { "if-none-match": "*" })).status).toBe(304);
    expect((await get(h, path, { "if-none-match": `"nope", ${etag}` })).status).toBe(304);
    expect((await get(h, path, { "if-none-match": etag.slice(2) })).status).toBe(304);
    expect((await get(h, path, { "if-none-match": '"nope"' })).status).toBe(200);
  });

  it("gives every cacheable endpoint an ETag, and a different one for a different batch order", async () => {
    const h = await start();
    for (const path of [`/v1/token/${fakeToken(1)}`, `/v1/tokens?ids=${fakeToken(1)}`, "/v1/new", `/v1/history/${fakeToken(1)}`, "/v1/format"]) {
      const a = await get(h, path);
      expect(a.headers.etag, path).toMatch(/^W\//);
      expect((await get(h, path, { "if-none-match": a.headers.etag! })).status, path).toBe(304);
    }
    const ab = (await get(h, `/v1/tokens?ids=${fakeToken(1)},${fakeToken(2)}`)).headers.etag;
    const ba = (await get(h, `/v1/tokens?ids=${fakeToken(2)},${fakeToken(1)}`)).headers.etag;
    expect(ab).not.toBe(ba);
  });
});

describe("rate limits", () => {
  it("lets each address read 40 at once, then 20 a second, and says when to come back", async () => {
    const h = await start({ limits: { get: { burst: 40, perSecond: 20 } } });
    const statuses = [];
    for (let i = 0; i < 41; i++) statuses.push((await get(h, "/v1/health")).status);
    expect(statuses.slice(0, 40).every((s) => s === 200)).toBe(true);
    const limited = await get(h, "/v1/health");
    expect(limited.status).toBe(429);
    expect(limited.json()).toEqual({ v: 1, error: "rate-limited" });
    expect(limited.headers["retry-after"]).toBe("1");
    expect(limited.headers["cache-control"]).toBe("no-store");
    h.clock.t += 100; // 2 more
    expect((await get(h, "/v1/health")).status).toBe(200);
    expect((await get(h, "/v1/health")).status).toBe(200);
    expect((await get(h, "/v1/health")).status).toBe(429);
    h.clock.t += 60_000; // full again, but never above the burst
    let ok = 0;
    for (let i = 0; i < 45; i++) if ((await get(h, "/v1/health")).status === 200) ok++;
    expect(ok).toBe(40);
  });

  it("counts each client behind the proxy separately, by the address the proxy wrote last", async () => {
    const h = await start({ limits: { get: { burst: 2, perSecond: 0.001 } }, options: { trustProxy: true } });
    const as = (ip: string) => get(h, "/v1/health", { "x-forwarded-for": ip });
    expect([(await as("1.1.1.1")).status, (await as("1.1.1.1")).status, (await as("1.1.1.1")).status]).toEqual([200, 200, 429]);
    expect((await as("2.2.2.2")).status).toBe(200);
    // A client can't dodge it by sending its own X-Forwarded-For: the proxy appends the real address last.
    expect((await as("9.9.9.9, 1.1.1.1")).status).toBe(429);
    // IPv6 clients are counted by /64.
    expect([(await as("2001:db8:1:2::1")).status, (await as("2001:db8:1:2::2")).status, (await as("2001:db8:1:2:ffff::3")).status]).toEqual([200, 200, 429]);
    // Junk in the header falls back to the peer.
    expect((await as("not-an-ip")).status).toBe(200);
  });

  it("ignores X-Forwarded-For unless told it sits behind a local proxy", async () => {
    const h = await start({ limits: { get: { burst: 2, perSecond: 0.001 } } });
    const statuses = [];
    for (const ip of ["1.1.1.1", "2.2.2.2", "3.3.3.3"]) statuses.push((await get(h, "/v1/health", { "x-forwarded-for": ip })).status);
    expect(statuses).toEqual([200, 200, 429]);
  });

  it("takes 5 POSTs an hour from one address, bad ones included, then refills", async () => {
    const h = await start({ limits: { post: { burst: 5, perSecond: 5 / 3600 } } });
    const good = { token: fakeToken(1), contact: "x", message: "a real dispute" };
    expect((await post(h, "{")).status).toBe(400);
    for (let i = 0; i < 4; i++) expect((await post(h, good)).status).toBe(201);
    const limited = await post(h, good);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers["retry-after"])).toBe(720);
    expect(h.store.disputes()).toHaveLength(4);
    expect((await get(h, "/v1/health")).status).toBe(200); // reads are a separate bucket
    h.clock.t += 720_000;
    expect((await post(h, good)).status).toBe(201);
    expect((await post(h, good)).status).toBe(429);
  });

  it("caps disputes from everyone together, so spam from many addresses stays small", async () => {
    const h = await start({ limits: { post: { burst: 5, perSecond: 5 / 3600 }, postAll: { burst: 3, perSecond: 3 / 3600 } }, options: { trustProxy: true } });
    const good = { token: fakeToken(1), contact: "x", message: "spam" };
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await post(h, good, { "x-forwarded-for": `10.0.0.${i}` })).status);
    expect(statuses).toEqual([201, 201, 201, 429, 429]);
    expect(h.store.disputes()).toHaveLength(3);
  });

  it("remembers a bounded number of addresses, and keeps a drained one drained", () => {
    const rl = new RateLimiter({ burst: 2, perSecond: 1 }, 100);
    expect([rl.take("bad", 0), rl.take("bad", 0), rl.take("bad", 0)]).toEqual([0, 0, 1]);
    for (let i = 0; i < 10_000; i++) {
      rl.take(`10.${i >> 8}.${i & 255}.1`, 10);
      if (i % 40 === 0) rl.take("bad", 10);
    }
    expect(rl.size).toBeLessThanOrEqual(100);
    expect(rl.take("bad", 10)).toBeGreaterThan(0);
    // A full bucket is forgotten at the next sweep, since it equals a new one.
    rl.take("later", 200_000);
    expect(rl.size).toBe(1);
  });

  it("keys IPv6 by /64 and IPv4-mapped addresses as IPv4", () => {
    expect(ipKey("1.2.3.4")).toBe("1.2.3.4");
    expect(ipKey("::ffff:1.2.3.4")).toBe("1.2.3.4");
    expect(ipKey("2001:db8:0:1::5")).toBe("2001:db8:0:1::/64");
    expect(ipKey("2001:0db8:0000:0001:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:0:1::/64");
    expect(ipKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(ipKey("fe80::1%en0")).toBe("fe80:0:0:0::/64");
    expect(ipKey("::1")).toBe("0:0:0:0::/64");
    expect(ipKey("64:ff9b::1.2.3.4")).toBe("64:ff9b:0:0::/64");
  });
});

describe("timeouts", () => {
  it("closes a connection whose headers never finish", async () => {
    const h = await start({ limits: { headersTimeoutMs: 200, requestTimeoutMs: 400 } });
    const a = await raw(h.port, "GET /v1/health HTTP/1.1\r\nHost: x\r\n", 3_000);
    expect(a.closed).toBe(true);
    expect(a.ms).toBeLessThan(1_500);
    expect(a.text).toMatch(/^HTTP\/1\.1 408 /);
  });

  it("closes a dispute whose body trickles in too slowly, storing nothing", async () => {
    const h = await start({ limits: { headersTimeoutMs: 200, requestTimeoutMs: 400 } });
    const a = await raw(h.port, `POST /v1/dispute HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 200\r\n\r\n{"token":`, 3_000);
    expect(a.closed).toBe(true);
    expect(a.ms).toBeLessThan(1_500);
    expect(h.store.disputes()).toHaveLength(0);
  });

  it("closes idle keep-alive connections", async () => {
    const h = await start({ limits: { keepAliveTimeoutMs: 150 } });
    const a = await raw(h.port, "GET /v1/health HTTP/1.1\r\nHost: x\r\n\r\n", 3_000);
    expect(a.text).toMatch(/^HTTP\/1\.1 200 /);
    expect(a.closed).toBe(true);
    expect(a.ms).toBeLessThan(1_500);
  });
});

describe("under load", () => {
  it("answers 1,000 batches of 50 at 50 at a time, every one valid", async () => {
    const h = await start({ records: 2_000 });
    let n = 0;
    let bad = 0;
    const times: number[] = [];
    const worker = async () => {
      while (n < 1_000) {
        const k = n++;
        const ids = Array.from({ length: 50 }, (_, i) => fakeToken((k * 37 + i * 41) % 2_100));
        const t0 = performance.now();
        const res = await fetch(`${h.base}/v1/tokens?ids=${ids.join(",")}`);
        const body = (await res.json()) as { items: unknown; missing: string[] };
        times.push(performance.now() - t0);
        if (res.status !== 200) bad++;
        else if (k % 50 === 0) validItems(body.items);
      }
    };
    await Promise.all(Array.from({ length: 50 }, worker));
    expect(bad).toBe(0);
    expect(times).toHaveLength(1_000);
  }, 30_000);

  it("survives 300 connections opened at once", async () => {
    const h = await start();
    const sockets = await Promise.all(
      Array.from({ length: 300 }, () => new Promise<ReturnType<typeof connect>>((resolve) => {
        const s = connect(h.port, "127.0.0.1", () => resolve(s));
        s.on("error", () => resolve(s));
      })),
    );
    expect((await get(h, "/v1/health")).status).toBe(200);
    for (const s of sockets) s.destroy();
  });
});

describe("stored records", () => {
  it("reads expiresAtMs from the stored text the same as parsing it", () => {
    for (let i = 0; i < 50; i++) {
      const r = fakeRecord(i, { nowMs: T0 + i });
      expect(expiresOf(JSON.stringify(FeedRecord.parse(r)))).toBe(r.expiresAtMs);
    }
    const tricky = fakeRecord(1, { nowMs: T0 }, { checks: [{ code: "bundle", result: "info", text: '"expiresAtMs":1 is not the field', evidence: [] }] });
    expect(expiresOf(JSON.stringify(FeedRecord.parse(tricky)))).toBe(tricky.expiresAtMs);
  });

  it("makes fake records that pass the v1 format (seed and load tests rely on it)", () => {
    for (let i = 0; i < 300; i++) expect(FeedRecord.safeParse(fakeRecord(i)).success, `fake ${i}`).toBe(true);
  });
});

describe("scripts/disputes.ts", () => {
  it("lists open disputes with outside text escaped, and records an answer", () => {
    const dir = mkdtempSync(join(tmpdir(), "delphi-disputes-"));
    const db = join(dir, "feed.db");
    try {
      const s = new FeedStore(db);
      s.put(fakeRecord(1, { nowMs: T0 }));
      const esc = String.fromCharCode(27);
      s.addDispute({ token: fakeToken(1), contact: `@me${esc}[31m`, message: `wrong\nflag${esc}]0;title${String.fromCharCode(7)}` }, T0);
      s.close();
      const run = (...args: string[]) => {
        const stdout: string[] = [];
        const stderr: string[] = [];
        const status = runDisputes(args, db, { log: (s: string) => stdout.push(s), error: (s: string) => stderr.push(s) });
        return { status, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
      };
      const list = run();
      expect(list.status).toBe(0);
      expect(list.stdout).toContain("#1");
      expect(list.stdout).toContain("@me\\u001b[31m");
      expect(list.stdout).toContain("\\u0007");
      expect(list.stdout).not.toContain(esc);
      expect(run("answer", "1", "nope", "x").status).toBe(2);
      expect(run("answer", "9", "upheld", "x").status).toBe(1);
      const ans = run("answer", "1", "upheld", "The wallets share a funder: see the report.");
      expect(ans.status).toBe(0);
      expect(run().stdout).toContain("no open disputes");
      expect(run("all").stdout).toContain("The wallets share a funder");
      const after = new FeedStore(db);
      expect(after.disputes()[0]).toMatchObject({ status: "upheld", answer: "The wallets share a funder: see the report." });
      after.close();
      const cli = spawnSync(process.execPath, ["scripts/disputes.ts", "all"], { env: { ...process.env, FEED_DB: db }, encoding: "utf8" });
      expect(cli.status).toBe(0);
      expect(cli.stdout).toContain("The wallets share a funder");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
