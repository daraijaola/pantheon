// DELPHI's live feed over HTTP: what DELPHI knows about each new coin, for apps to show in their own design
// (Kalos's Sniper first). Read-only except for disputes. Plain node:http, no framework.
//
// Every answer is JSON, open to any origin (CORS *), no key. Records are served exactly as the watcher
// stored them (FeedStore checked each against the v1 format on the way in); this server only wraps them in
// an envelope, documented in format.ts:
//   {v:1, stale, record, servedAtMs}                     GET /v1/token/{address}
//   {v:1, items:[{stale, record}], missing, servedAtMs}   GET /v1/tokens?ids=a,b,c
//   {v:1, venue, items:[{stale, record}], next, ...}      GET /v1/new
// `stale` is true once the server's clock is past the record's expiresAtMs. `servedAtMs` is when the answer
// left; it is not part of the weak ETag, so an unchanged answer still gets 304 Not Modified.
//
// Records are spliced into answers as the JSON text the store keeps, never parsed and re-written: a batch
// of 50 costs about a quarter of a millisecond, which keeps p99 low with many callers on one thread.
//
// A dispute can come signed by the wallet a finding names (EIP-191 over disputeMessage(), types.ts):
// the server checks the signature and the time, keeps the wallet for the person who answers, and says
// only `signed: true` back. The unsigned form is answered exactly as before.
import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { createServer, STATUS_CODES, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { dirname } from "node:path";
import type { Duplex } from "node:stream";
import { getAddress, verifyMessage, type Address, type Hex } from "viem";
import { FEED_SERVER_VERSION, formatDescription } from "./format.ts";
import type { FeedStore, StoredDispute } from "./store.ts";
import { Dispute, disputeMessage, DisputeSignature, SIGNATURE_WINDOW_SEC, type Venue } from "./types.ts";

/** A token bucket: `burst` requests at once, refilled at `perSecond`. */
export type Bucket = { burst: number; perSecond: number };

export type FeedLimits = {
  /** Most tokens in one /v1/tokens call (Kalos's pages are 50 rows). */
  maxIds: number;
  /** Most records in one /v1/new call. */
  maxNew: number;
  maxBodyBytes: number;
  maxUrlBytes: number;
  maxHeaderBytes: number;
  /** Per client address: every GET, HEAD and OPTIONS. */
  get: Bucket;
  /** Per client address: every POST. */
  post: Bucket;
  /** Everyone together: disputes accepted (a cap on what spam can make a person read). */
  postAll: Bucket;
  /** How many client addresses the rate limits remember at most. */
  maxTrackedIps: number;
  headersTimeoutMs: number;
  requestTimeoutMs: number;
  keepAliveTimeoutMs: number;
  maxConnections: number;
  cacheSeconds: number;
};

export const DEFAULT_LIMITS: FeedLimits = {
  maxIds: 50,
  maxNew: 100,
  maxBodyBytes: 4096,
  maxUrlBytes: 4096,
  maxHeaderBytes: 8192,
  get: { burst: 40, perSecond: 20 },
  post: { burst: 5, perSecond: 5 / 3600 },
  postAll: { burst: 100, perSecond: 100 / 3600 },
  maxTrackedIps: 50_000,
  headersTimeoutMs: 5_000,
  requestTimeoutMs: 10_000,
  keepAliveTimeoutMs: 5_000,
  maxConnections: 1_000,
  cacheSeconds: 5,
};

export type FeedRoute = "token" | "tokens" | "new" | "history" | "health" | "format" | "dispute" | "other";

export type FeedLogEvent =
  | { kind: "request"; method: string; route: FeedRoute; status: number; ms: number }
  | { kind: "error"; route: FeedRoute; message: string }
  | { kind: "dispute"; id: number; token: string; signed?: true };

/** True if `address` signed `message` (EIP-191 personal_sign). */
export type VerifySigner = (args: { address: Address; message: string; signature: Hex }) => Promise<boolean>;

/** Plain wallets, by viem's verifyMessage, with no chain read. Something that isn't a signature is not the wallet's. */
export const verifyPlainWallet: VerifySigner = (a) => verifyMessage(a).catch(() => false);

export type FeedServerOptions = {
  store: FeedStore;
  /** The clock, in ms (tests pass a fake one). */
  now?: () => number;
  limits?: Partial<FeedLimits>;
  log?: (e: FeedLogEvent) => void;
  /** Told about each new dispute after it is stored. Default: a line in out/disputes.log. */
  notifyDispute?: (d: StoredDispute) => void | Promise<void>;
  /**
   * Checks a signed dispute's signature. Default: verifyPlainWallet. scripts/feed.ts passes a chain
   * client's verifyMessage when DISPUTE_RPC is set, which also checks smart wallets (ERC-1271, ERC-6492).
   */
  verifySigner?: VerifySigner;
  /**
   * Behind a reverse proxy on this machine (Caddy): take the client's address from the last
   * X-Forwarded-For entry, which the proxy itself wrote. Only honoured for loopback peers.
   */
  trustProxy?: boolean;
};

/** The default dispute notice: one JSON line per dispute (JSON escapes control characters, so it is safe to cat). */
export function appendDisputeLog(path = "out/disputes.log"): (d: StoredDispute) => void {
  return (d) => {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify({ at: new Date(d.atMs).toISOString(), ...d })}\n`);
  };
}

// ---------------------------------------------------------------------------------------------------
// Rate limits

/** Token buckets per key, remembering at most `maxKeys` (least recently seen are forgotten first). */
export class RateLimiter {
  readonly burst: number;
  readonly perMs: number;
  readonly maxKeys: number;
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private sweptAt = 0;

  constructor(b: Bucket, maxKeys = DEFAULT_LIMITS.maxTrackedIps) {
    this.burst = b.burst;
    this.perMs = b.perSecond / 1000;
    this.maxKeys = maxKeys;
  }

  /** Takes one request from `key`'s bucket: 0 if allowed, else the seconds to wait. */
  take(key: string, now: number): number {
    let b = this.buckets.get(key);
    if (b) {
      b.tokens = Math.min(this.burst, b.tokens + Math.max(0, now - b.at) * this.perMs);
      b.at = now;
      this.buckets.delete(key);
    } else {
      if (this.buckets.size >= this.maxKeys || now - this.sweptAt > 60_000) this.sweep(now);
      b = { tokens: this.burst, at: now };
    }
    this.buckets.set(key, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 0;
    }
    return Math.max(1, Math.ceil((1 - b.tokens) / this.perMs / 1000));
  }

  get size(): number {
    return this.buckets.size;
  }

  /** Forgets full buckets (the same as new ones), then, if still too many, the least recently seen half. */
  private sweep(now: number): void {
    this.sweptAt = now;
    for (const [k, b] of this.buckets) if (b.tokens + Math.max(0, now - b.at) * this.perMs >= this.burst) this.buckets.delete(k);
    if (this.buckets.size < this.maxKeys) return;
    let drop = this.buckets.size - Math.floor(this.maxKeys / 2);
    for (const k of this.buckets.keys()) {
      if (drop-- <= 0) break;
      this.buckets.delete(k);
    }
  }
}

/** The rate-limit key for an address: IPv4 as is, IPv6 by its /64 (one home or server gets a whole /64). */
export function ipKey(ip: string): string {
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : "";
  if (v4 && isIP(v4) === 4) return v4;
  const a = ip.split("%")[0]!.toLowerCase();
  if (isIP(a) !== 6) return ip;
  let groups: string[];
  if (a.includes("::")) {
    const [l = "", r = ""] = a.split("::");
    const left = l ? l.split(":") : [];
    const right = r ? r.split(":") : [];
    const rightLen = right.reduce((n, g) => n + (g.includes(".") ? 2 : 1), 0);
    groups = [...left, ...Array<string>(Math.max(0, 8 - left.length - rightLen)).fill("0"), ...right];
  } else groups = a.split(":");
  return `${groups
    .slice(0, 4)
    .map((g) => parseInt(g, 16).toString(16))
    .join(":")}::/64`;
}

const isLoopback = (ip: string) => ip === "::1" || ip.startsWith("127.") || ip.startsWith("::ffff:127.");

function clientAddress(req: IncomingMessage, trustProxy: boolean): string {
  const peer = req.socket.remoteAddress ?? "unknown";
  if (!trustProxy || !isLoopback(peer)) return peer;
  const xff = req.headers["x-forwarded-for"];
  const last = (typeof xff === "string" ? xff : "").split(",").pop()?.trim() ?? "";
  return last && isIP(last) ? last : peer;
}

// ---------------------------------------------------------------------------------------------------
// Reading records as stored text

const EXPIRES = '"expiresAtMs":';

/**
 * A record's expiresAtMs, read from its stored JSON without parsing it all. The store writes records with
 * JSON.stringify after schema-checking them, so the unescaped key appears exactly once, at the top level.
 */
export function expiresOf(json: string): number {
  const i = json.lastIndexOf(EXPIRES);
  if (i >= 0) {
    const n = parseInt(json.slice(i + EXPIRES.length, i + EXPIRES.length + 24), 10);
    if (Number.isSafeInteger(n)) return n;
  }
  const r = JSON.parse(json) as { expiresAtMs?: unknown };
  return typeof r.expiresAtMs === "number" ? r.expiresAtMs : 0;
}

type Statement = Database.Statement<unknown[], unknown>;

/** The feed table FeedStore writes, read as text: the same rows FeedStore.get/many/recent return parsed. */
class RawFeed {
  private readonly db: Database.Database;
  private readonly oneStmt: Statement;
  private readonly inStmts = new Map<number, Statement>();
  private readonly recentStmts = new Map<string, Statement>();
  private readonly newestStmt: Statement;

  constructor(db: Database.Database) {
    this.db = db;
    this.oneStmt = db.prepare("SELECT record FROM feed WHERE token = ?").pluck(true);
    this.newestStmt = db.prepare("SELECT MAX(updated_ms) FROM feed").pluck(true);
  }

  one(token: string): string | undefined {
    return this.oneStmt.get(token) as string | undefined;
  }

  /** Records by token (lowercase), in one query. */
  many(tokens: readonly string[]): Map<string, string> {
    if (!tokens.length) return new Map();
    let s = this.inStmts.get(tokens.length);
    if (!s) {
      s = this.db.prepare(`SELECT token, record FROM feed WHERE token IN (${tokens.map(() => "?").join(",")})`).raw(true);
      this.inStmts.set(tokens.length, s);
    }
    return new Map(s.all(...tokens) as Array<[string, string]>);
  }

  /** Newest launches first, like FeedStore.recent: [record, launch block]. */
  recent(venue: Venue | null, before: number | null, limit: number): Array<[string, number]> {
    const k = `${venue ? "v" : ""}${before !== null ? "b" : ""}`;
    let s = this.recentStmts.get(k);
    if (!s) {
      const where = [venue ? "venue = ?" : "", before !== null ? "launch_block < ?" : ""].filter(Boolean);
      s = this.db.prepare(`SELECT record, launch_block FROM feed ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY launch_block DESC LIMIT ?`).raw(true);
      this.recentStmts.set(k, s);
    }
    const args: Array<string | number> = [];
    if (venue) args.push(venue);
    if (before !== null) args.push(before);
    return s.all(...args, limit) as Array<[string, number]>;
  }

  newest(): number | null {
    return (this.newestStmt.get() as number | null) ?? null;
  }
}

// ---------------------------------------------------------------------------------------------------
// The server

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ROUTE = /^(?:\/api\/delphi)?\/v1\/([a-z]+)(?:\/([^/]*))?\/?$/;
const VENUES = new Set<string>(["perpme", "kalos", "ascend"]);
const JSON_TYPE = /^application\/json\s*(?:;|$)/i;
/** Control characters (except tab and line breaks) and text-direction overrides: never part of a real dispute. */
// eslint-disable-next-line no-control-regex -- finding control characters is the point
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const READS = new Set<FeedRoute>(["token", "tokens", "new", "history", "health", "format"]);
/** A dispute's fields in the order a bad-dispute answer names them; the last three make the signed form. */
const DISPUTE_FIELDS = ["token", "contact", "message", "wallet", "signedAt", "signature"] as const;
const SIGNED = ["wallet", "signedAt", "signature"] as const;
const TOO_LARGE = Symbol("too-large");
const GONE = Symbol("gone");

const COMMON_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers": "ETag, Retry-After",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
};

class HttpFail {
  readonly status: number;
  readonly body: Record<string, unknown>;
  constructor(status: number, error: string, extra: Record<string, unknown> = {}) {
    this.status = status;
    this.body = { v: 1, error, ...extra };
  }
}

/** Reads a request body up to `max` bytes. */
function readBody(req: IncomingMessage, max: number): Promise<string | typeof TOO_LARGE | typeof GONE> {
  return new Promise((resolve) => {
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > max) return resolve(TOO_LARGE);
    const chunks: Buffer[] = [];
    let n = 0;
    const onData = (c: Buffer) => {
      n += c.length;
      if (n > max) {
        req.off("data", onData);
        req.pause();
        resolve(TOO_LARGE);
      } else chunks.push(c);
    };
    req.on("data", onData);
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(GONE));
    req.on("close", () => resolve(GONE));
  });
}

function matchesEtag(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === "*") return true;
  const bare = etag.slice(2);
  return header.split(",").some((t) => t.trim().replace(/^W\//, "") === bare);
}

/** Creates the feed server (not listening yet). */
export function createFeedServer(opts: FeedServerOptions): Server {
  const limits: FeedLimits = { ...DEFAULT_LIMITS, ...opts.limits };
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  const notify = opts.notifyDispute ?? appendDisputeLog();
  const verifySigner = opts.verifySigner ?? verifyPlainWallet;
  const trustProxy = opts.trustProxy ?? false;
  const store = opts.store;
  const raw = new RawFeed(store.db);
  const getLimit = new RateLimiter(limits.get, limits.maxTrackedIps);
  const postLimit = new RateLimiter(limits.post, limits.maxTrackedIps);
  const postAll = new RateLimiter(limits.postAll, 1);
  const cacheControl = `public, max-age=${limits.cacheSeconds}`;
  const formatCore = JSON.stringify(
    formatDescription({
      maxIds: limits.maxIds,
      maxNew: limits.maxNew,
      maxBodyBytes: limits.maxBodyBytes,
      getPerSecond: limits.get.perSecond,
      getBurst: limits.get.burst,
      postPerHour: Math.round(limits.post.perSecond * 3600),
      cacheSeconds: limits.cacheSeconds,
    }),
  );

  const item = (json: string, t: number) => `{"stale":${t > expiresOf(json)},"record":${json}}`;

  function send(req: IncomingMessage, res: ServerResponse, status: number, body: string, cache = "no-store"): void {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Length", Buffer.byteLength(body));
    res.setHeader("Cache-Control", cache);
    res.end(req.method === "HEAD" ? undefined : body);
  }

  /** A cacheable answer: `core` is a JSON object without servedAtMs; the weak ETag covers only it. */
  function sendData(req: IncomingMessage, res: ServerResponse, core: string, t: number): void {
    const etag = `W/"${createHash("sha1").update(core).digest("base64url").slice(0, 22)}"`;
    res.setHeader("ETag", etag);
    if (matchesEtag(req.headers["if-none-match"], etag)) {
      res.statusCode = 304;
      res.setHeader("Cache-Control", cacheControl);
      res.end();
      return;
    }
    send(req, res, 200, `${core.slice(0, -1)},"servedAtMs":${t}}`, cacheControl);
  }

  function address(s: string | undefined): string {
    if (!s || !ADDRESS.test(s)) throw new HttpFail(400, "bad-address");
    return s.toLowerCase();
  }

  function token(req: IncomingMessage, res: ServerResponse, param: string | undefined, t: number): void {
    const a = address(param);
    const json = raw.one(a);
    if (json === undefined) throw new HttpFail(404, "unknown", { token: a });
    sendData(req, res, `{"v":1,"stale":${t > expiresOf(json)},"record":${json}}`, t);
  }

  function tokens(req: IncomingMessage, res: ServerResponse, q: URLSearchParams, t: number): void {
    const list = q.get("ids") ?? q.get("addresses");
    const parts = (list ?? "").split(",").map((s) => s.trim());
    const asked = parts.filter(Boolean);
    if (!asked.length) throw new HttpFail(400, "bad-ids");
    if (asked.length > limits.maxIds) throw new HttpFail(400, "too-many", { max: limits.maxIds });
    const ids: string[] = [];
    const seen = new Set<string>();
    asked.forEach((s, index) => {
      if (!ADDRESS.test(s)) throw new HttpFail(400, "bad-address", { index });
      const a = s.toLowerCase();
      if (!seen.has(a)) ids.push(a);
      seen.add(a);
    });
    const found = raw.many(ids);
    const items: string[] = [];
    const missing: string[] = [];
    for (const a of ids) {
      const json = found.get(a);
      if (json === undefined) missing.push(a);
      else items.push(item(json, t));
    }
    sendData(req, res, `{"v":1,"items":[${items.join(",")}],"missing":${JSON.stringify(missing)}}`, t);
  }

  function recent(req: IncomingMessage, res: ServerResponse, q: URLSearchParams, t: number): void {
    const venue = q.get("venue") || null;
    if (venue !== null && !VENUES.has(venue)) throw new HttpFail(400, "bad-venue");
    const l = q.get("limit");
    const limit = l === null ? Math.min(50, limits.maxNew) : /^\d{1,4}$/.test(l) ? Number(l) : 0;
    if (limit < 1 || limit > limits.maxNew) throw new HttpFail(400, "bad-limit", { max: limits.maxNew });
    const b = q.get("before");
    if (b !== null && !/^\d{1,15}$/.test(b)) throw new HttpFail(400, "bad-before");
    const rows = raw.recent(venue as Venue | null, b === null ? null : Number(b), limit);
    const next = rows.length === limit ? String(rows[rows.length - 1]![1]) : null;
    sendData(req, res, `{"v":1,"venue":${JSON.stringify(venue)},"items":[${rows.map(([json]) => item(json, t)).join(",")}],"next":${JSON.stringify(next)}}`, t);
  }

  function history(req: IncomingMessage, res: ServerResponse, param: string | undefined, t: number): void {
    const a = address(param);
    const items = store.history(a).map(({ atMs, verdict, rules, why }) => ({ atMs, verdict, rules, why }));
    if (!items.length && raw.one(a) === undefined) throw new HttpFail(404, "unknown", { token: a });
    sendData(req, res, JSON.stringify({ v: 1, token: a, items }), t);
  }

  function health(req: IncomingMessage, res: ServerResponse, t: number): void {
    let newestUpdateMs: number | null = null;
    let ok = true;
    try {
      newestUpdateMs = raw.newest();
    } catch (e) {
      ok = false;
      log({ kind: "error", route: "health", message: e instanceof Error ? e.message : String(e) });
    }
    send(req, res, ok ? 200 : 503, JSON.stringify({ v: 1, ok, version: FEED_SERVER_VERSION, newestUpdateMs, servedAtMs: t }));
  }

  async function dispute(req: IncomingMessage, res: ServerResponse, t: number): Promise<void> {
    if (!JSON_TYPE.test(req.headers["content-type"] ?? "")) throw new HttpFail(415, "bad-content-type");
    const body = await readBody(req, limits.maxBodyBytes);
    if (body === GONE) return;
    if (body === TOO_LARGE) {
      res.setHeader("Connection", "close");
      throw new HttpFail(413, "too-large", { max: limits.maxBodyBytes });
    }
    let input: unknown;
    try {
      input = JSON.parse(body);
    } catch {
      throw new HttpFail(400, "bad-json");
    }
    if (typeof input !== "object" || input === null || Array.isArray(input)) throw new HttpFail(400, "bad-dispute", { fields: ["token", "contact", "message"] });
    const o = input as Record<string, unknown>;
    const lower = (v: unknown) => (typeof v === "string" && ADDRESS.test(v) ? v.toLowerCase() : v);
    const parsed = Dispute.safeParse({ token: lower(o.token), contact: o.contact, message: o.message });
    const bad = new Set<string>(parsed.success ? [] : parsed.error.issues.map((i) => String(i.path[0])));
    if (parsed.success) {
      if (!parsed.data.message.trim()) bad.add("message");
      if (CONTROL.test(parsed.data.message)) bad.add("message");
      if (CONTROL.test(parsed.data.contact)) bad.add("contact");
    }
    // The signed form: wallet, signedAt and signature together, or none of them (null counts as none).
    const signing = SIGNED.some((k) => o[k] !== undefined && o[k] !== null);
    const sig = signing ? DisputeSignature.safeParse({ wallet: lower(o.wallet), signedAt: o.signedAt, signature: o.signature }) : null;
    if (sig && !sig.success) for (const i of sig.error.issues) bad.add(String(i.path[0]));
    if (!parsed.success || bad.size) throw new HttpFail(400, "bad-dispute", { fields: DISPUTE_FIELDS.filter((f) => bad.has(f)) });
    const d = parsed.data;
    if (raw.one(d.token) === undefined) throw new HttpFail(404, "unknown", { token: d.token });
    // Checked before the shared cap, so bad signatures can't use up everyone's disputes.
    const wallet = sig?.success ? sig.data.wallet : null;
    if (sig?.success) {
      if (Math.abs(Math.floor(t / 1000) - sig.data.signedAt) > SIGNATURE_WINDOW_SEC) throw new HttpFail(400, "stale-signature");
      const message = disputeMessage({ token: d.token, message: d.message, signedAt: sig.data.signedAt });
      if (!(await verifySigner({ address: getAddress(sig.data.wallet), message, signature: sig.data.signature as Hex }))) throw new HttpFail(400, "bad-signature");
    }
    const wait = postAll.take("all", t);
    if (wait) {
      res.setHeader("Retry-After", String(wait));
      throw new HttpFail(429, "rate-limited");
    }
    const id = store.addDispute({ ...d, ...(wallet ? { wallet } : {}) }, t);
    const stored: StoredDispute = { id, token: d.token, contact: d.contact, message: d.message, atMs: t, status: "open", answer: null, ...(wallet ? { wallet } : {}) };
    log({ kind: "dispute", id, token: d.token, ...(wallet ? { signed: true as const } : {}) });
    Promise.resolve()
      .then(() => notify(stored))
      .catch((e: unknown) => log({ kind: "error", route: "dispute", message: `notifyDispute: ${e instanceof Error ? e.message : String(e)}` }));
    // The wallet itself is never sent back: only that the dispute was signed by it.
    send(req, res, 201, JSON.stringify({ v: 1, ok: true, id, status: "open", ...(wallet ? { signed: true } : {}) }));
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<FeedRoute> {
    const t = now();
    const method = req.method ?? "GET";
    for (const [k, v] of Object.entries(COMMON_HEADERS)) res.setHeader(k, v);
    let route: FeedRoute = "other";
    try {
      const wait = (method === "POST" ? postLimit : getLimit).take(ipKey(clientAddress(req, trustProxy)), t);
      if (wait) {
        res.setHeader("Retry-After", String(wait));
        throw new HttpFail(429, "rate-limited");
      }
      if ((req.url ?? "").length > limits.maxUrlBytes) throw new HttpFail(414, "url-too-long");
      let url: URL;
      try {
        url = new URL(req.url ?? "/", "http://feed.invalid");
      } catch {
        throw new HttpFail(400, "bad-request");
      }
      const m = ROUTE.exec(url.pathname);
      const name = m?.[1] as FeedRoute | undefined;
      const param = m?.[2] || undefined;
      const withParam = name === "token" || name === "history";
      if (!m || !name || !(READS.has(name) || name === "dispute") || withParam !== (param !== undefined)) throw new HttpFail(404, "not-found");
      route = name;
      const allow = route === "dispute" ? "POST, OPTIONS" : "GET, HEAD, OPTIONS";
      if (method === "OPTIONS") {
        res.statusCode = 204;
        res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, If-None-Match");
        res.setHeader("Access-Control-Max-Age", "86400");
        res.setHeader("Allow", allow);
        res.setHeader("Content-Length", "0");
        res.end();
        return route;
      }
      if (route === "dispute" ? method !== "POST" : method !== "GET" && method !== "HEAD") {
        res.setHeader("Allow", allow);
        throw new HttpFail(405, "method-not-allowed");
      }
      const q = url.searchParams;
      if (route === "token") token(req, res, param, t);
      else if (route === "tokens") tokens(req, res, q, t);
      else if (route === "new") recent(req, res, q, t);
      else if (route === "history") history(req, res, param, t);
      else if (route === "health") health(req, res, t);
      else if (route === "format") sendData(req, res, formatCore, t);
      else await dispute(req, res, t);
    } catch (e) {
      if (e instanceof HttpFail) {
        if (!res.headersSent && !res.writableEnded) send(req, res, e.status, JSON.stringify(e.body));
      } else {
        log({ kind: "error", route, message: e instanceof Error ? e.message : String(e) });
        if (!res.headersSent && !res.writableEnded) send(req, res, 500, '{"v":1,"error":"internal"}');
        else res.destroy();
      }
    }
    return route;
  }

  const server = createServer(
    {
      maxHeaderSize: limits.maxHeaderBytes,
      headersTimeout: limits.headersTimeoutMs,
      requestTimeout: limits.requestTimeoutMs,
      connectionsCheckingInterval: Math.max(25, Math.min(1000, Math.floor(limits.headersTimeoutMs / 4))),
    },
    (req, res) => {
      const t0 = performance.now();
      void handle(req, res).then((route) => log({ kind: "request", method: req.method ?? "?", route, status: res.writableEnded ? res.statusCode : 0, ms: performance.now() - t0 }));
    },
  );
  server.keepAliveTimeout = limits.keepAliveTimeoutMs;
  server.maxConnections = limits.maxConnections;

  // Malformed requests, headers too large and timeouts: a short JSON answer, then the connection closes.
  server.on("clientError", (err: NodeJS.ErrnoException, socket: Duplex) => {
    const pending = (socket as Duplex & { _httpMessage?: ServerResponse | null })._httpMessage;
    if (err.code === "ECONNRESET" || !socket.writable || pending?.headersSent) {
      socket.destroy();
      return;
    }
    const status = err.code === "HPE_HEADER_OVERFLOW" ? 431 : err.code === "ERR_HTTP_REQUEST_TIMEOUT" ? 408 : 400;
    const body = '{"v":1,"error":"bad-request"}';
    const head = [`HTTP/1.1 ${status} ${STATUS_CODES[status]}`, "Content-Type: application/json; charset=utf-8", `Content-Length: ${body.length}`, "Cache-Control: no-store", ...Object.entries(COMMON_HEADERS).map(([k, v]) => `${k}: ${v}`), "Connection: close"];
    socket.end(`${head.join("\r\n")}\r\n\r\n${body}`);
  });
  return server;
}
