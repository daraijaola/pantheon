import { assertRpcChain, backendEnv, configured } from "../../network.mts";
// Runs DELPHI's live feed server (src/live/server.ts) on 127.0.0.1, for Caddy to put on
// pantheonindex.com/api/delphi/. Read-only, except that disputes are stored for a person to answer.
//   node scripts/feed.ts                 serve FEED_DB (default data/feed.db) on 127.0.0.1:${PORT:-3310}
//   node scripts/feed.ts --seed 500      serve a scratch db of 500 fake records instead (local testing only;
//                                        it never touches FEED_DB and is deleted on exit)
// Logs one summary line a minute, plus every server error and every dispute. Stops cleanly on SIGTERM.
// A dispute signed by a plain wallet is checked with no chain read. With DISPUTE_RPC set (an RPC address),
// smart wallets can sign too: their signature is checked on chain (ERC-1271, or ERC-6492 if not deployed).
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, http } from "viem";
import { fakeRecord } from "../src/live/fake.ts";
import { appendDisputeLog, createFeedServer, verifyPlainWallet, type FeedLogEvent, type VerifySigner } from "../src/live/server.ts";
import { FeedStore } from "../src/live/store.ts";

Object.assign(process.env, backendEnv(process.env, "feed"));

configured(process.env, "feed", {});
const args = process.argv.slice(2);
const seedArg = args.includes("--seed") ? args[args.indexOf("--seed") + 1] : undefined;
if (args.includes("--seed") && !/^\d{1,6}$/.test(seedArg ?? "")) {
  console.error("--seed needs a number of fake records");
  process.exit(2);
}
const port = Number(process.env.PORT ?? 3310);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("PORT must be a port number");
  process.exit(2);
}

const scratch = seedArg !== undefined ? join(tmpdir(), `delphi-feed-seed-${process.pid}.db`) : null;
const dbPath = scratch ?? (process.env.FEED_DB || "data/feed.db");
const store = new FeedStore(dbPath);
const say = (m: string) => console.log(`[feed] ${m}`);

if (scratch) {
  const n = Number(seedArg);
  const t = Date.now();
  store.db.transaction(() => {
    for (let i = 0; i < n; i++) store.put(fakeRecord(i, { nowMs: t }), "seeded");
  })();
  say(`seeded ${n} fake records into ${scratch} (local testing only)`);
}

// One line a minute: how many answers, by status, and how fast.
let counts = new Map<number, number>();
let times: number[] = [];
const onLog = (e: FeedLogEvent) => {
  if (e.kind === "request") {
    counts.set(e.status, (counts.get(e.status) ?? 0) + 1);
    if (times.length < 100_000) times.push(e.ms);
  } else if (e.kind === "error") say(`error in ${e.route}: ${e.message}`);
  else say(`dispute #${e.id} about ${e.token}${e.signed ? " (signed by the wallet)" : ""}`);
};
const summary = setInterval(() => {
  if (!times.length) return;
  const s = times.sort((a, b) => a - b);
  const p = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))]!.toFixed(1);
  const by = [...counts].sort(([a], [b]) => a - b).map(([k, v]) => `${k}: ${v}`).join(", ");
  say(`last minute: ${s.length} requests (${by}); p50 ${p(0.5)} ms, p99 ${p(0.99)} ms`);
  counts = new Map();
  times = [];
}, 60_000);
summary.unref();

const disputeRpc = process.env.DISPUTE_RPC;
const chain = disputeRpc ? createPublicClient({ transport: http(disputeRpc, { timeout: 5_000, retryCount: 0 }) }) : null;
if (chain) await assertRpcChain(chain);
// A node that fails is an error on our side (500), never a "bad signature"; viem falls back to plain wallets by itself.
const verifySigner: VerifySigner = chain ? (a) => chain.verifyMessage(a) : verifyPlainWallet;
if (chain) say("signed disputes: smart wallets are checked on chain too");
const server = createFeedServer({ store, log: onLog, trustProxy: true, notifyDispute: appendDisputeLog(process.env.DISPUTE_LOG || "out/disputes.log"), verifySigner });
server.listen(port, "127.0.0.1", () => {
  const newest = store.db.prepare("SELECT COUNT(*) AS n, MAX(updated_ms) AS t FROM feed").get() as { n: number; t: number | null };
  say(`serving ${dbPath} on http://127.0.0.1:${port}/v1/ (${newest.n} records${newest.t ? `, newest ${new Date(newest.t).toISOString()}` : ""})`);
  if (!newest.n) say("the feed is empty: is the watcher writing to this FEED_DB?");
});
server.on("error", (e) => {
  say(`cannot serve: ${e.message}`);
  process.exit(1);
});

let stopping = false;
function stop(signal: string) {
  if (stopping) return;
  stopping = true;
  say(`${signal}: finishing open requests`);
  const force = setTimeout(() => server.closeAllConnections(), 5_000);
  force.unref();
  server.close(() => {
    store.close();
    if (scratch) for (const f of [scratch, `${scratch}-wal`, `${scratch}-shm`]) rmSync(f, { force: true });
    say("stopped");
    process.exit(0);
  });
  server.closeIdleConnections();
}
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
