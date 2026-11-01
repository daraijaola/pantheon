// Load and soak tests for the feed server (src/live/server.ts), on this machine, with no extra tools.
//   node scripts/feed-load.ts           load: 5,000 fake records; batches of 50 ids, 50 at a time, for 30 s
//   node scripts/feed-load.ts --soak    soak: 10 minutes at a steady 100 requests a second, memory every 30 s
// Options: --seconds N, --concurrency N (load), --rate N a second (soak), --records N, --writes N a second
// (record updates while it runs, as the watcher would make; default 5), --json out/feed-load.json.
//
// The server runs alone in a child process (so the client never slows it down), with the real rate limits.
// Each request carries a random X-Forwarded-For from a pool of addresses, as Caddy would send them, so the
// limiter is exercised too. Latency is measured by the client, request start to last byte; the server also
// reports its own handler times, CPU, garbage-collection pauses and event-loop delay, to say where time went.
// "--soak --seconds 30 --rate 1000" gives latency at a fixed open-loop rate instead of a closed loop.
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { Agent, request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";
import { fakeRecord, fakeToken } from "../src/live/fake.ts";
import { createFeedServer } from "../src/live/server.ts";
import { FeedStore } from "../src/live/store.ts";
import { FeedRecord } from "../src/live/types.ts";

const args = process.argv.slice(2);
const opt = (name: string, dflt: number) => {
  const v = args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  if (v !== undefined && !/^\d+(\.\d+)?$/.test(v)) {
    console.error(`${name} needs a number`);
    process.exit(2);
  }
  return v === undefined ? dflt : Number(v);
};

type Mem = { rss: number; heapUsed: number; external: number; arrayBuffers: number };
type Stall = { atS: number; ms: number; what: string };
type ServerStats = { n: number; p50: number; p99: number; max: number; cpuMs: number; gc: { count: number; totalMs: number; maxMs: number; over10ms: number }; loopDelayMs: { p99: number; max: number }; stalls: Stall[] };
type FromChild = { port: number } | { mem: Mem } | { server: ServerStats };

// ---------------------------------------------------------------------------------------------------
// The child: just the server.

if (args[0] === "--serve") {
  const store = new FeedStore(args[1]!);
  const times: number[] = [];
  let cpu = process.cpuUsage();
  // Where stalls come from: garbage collection pauses and event-loop delay.
  let gc = { count: 0, totalMs: 0, maxMs: 0, over10ms: 0 };
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      gc.count++;
      gc.totalMs += e.duration;
      gc.maxMs = Math.max(gc.maxMs, e.duration);
      if (e.duration > 10) gc.over10ms++;
      if (e.duration > 100) stall(e.duration, "garbage collection");
    }
  }).observe({ entryTypes: ["gc"] });
  const loop = monitorEventLoopDelay({ resolution: 5 });
  loop.enable();
  // Every pause over 100 ms: a slow request (by route) or a gap in the event loop (anything blocking it).
  const born = Date.now();
  let stalls: Stall[] = [];
  const stall = (ms: number, what: string) => stalls.length < 200 && stalls.push({ atS: Math.round((Date.now() - born) / 100) / 10, ms: Math.round(ms), what });
  // Each gap also says how many page faults (major: read back from disk or swap) and forced context switches
  // it saw, which tells a busy or swapping machine apart from the server's own work.
  let beat = performance.now();
  let ru = process.resourceUsage();
  setInterval(() => {
    const t = performance.now();
    const now = process.resourceUsage();
    if (t - beat > 150) {
      const faults = `${now.majorPageFault - ru.majorPageFault} major / ${now.minorPageFault - ru.minorPageFault} minor faults, ${now.involuntaryContextSwitches - ru.involuntaryContextSwitches} forced switches`;
      stall(t - beat - 50, `event loop (${faults})`);
    }
    beat = t;
    ru = now;
  }, 50).unref();
  const server = createFeedServer({
    store,
    trustProxy: true,
    notifyDispute: () => {},
    log: (e) => {
      if (e.kind !== "request") return;
      if (times.length < 2_000_000) times.push(e.ms);
      if (e.ms > 100) stall(e.ms, `${e.method} ${e.route} ${e.status}`);
    },
  });
  server.listen(0, "127.0.0.1", () => process.send!({ port: (server.address() as AddressInfo).port } satisfies FromChild));
  process.on("message", (m: string) => {
    if (m === "mem") {
      (globalThis as { gc?: () => void }).gc?.();
      const u = process.memoryUsage();
      process.send!({ mem: { rss: u.rss, heapUsed: u.heapUsed, external: u.external, arrayBuffers: u.arrayBuffers } } satisfies FromChild);
    } else if (m === "stats") {
      const s = times.sort((a, b) => a - b);
      const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
      const c = process.cpuUsage(cpu);
      cpu = process.cpuUsage();
      const loopDelayMs = { p99: loop.percentile(99) / 1e6, max: loop.max / 1e6 };
      process.send!({ server: { n: s.length, p50: q(0.5), p99: q(0.99), max: s.at(-1) ?? 0, cpuMs: (c.user + c.system) / 1000, gc, loopDelayMs, stalls } } satisfies FromChild);
      stalls = [];
      times.length = 0;
      gc = { count: 0, totalMs: 0, maxMs: 0, over10ms: 0 };
      loop.reset();
    } else if (m === "stop") {
      server.closeAllConnections();
      server.close(() => {
        store.close();
        process.exit(0);
      });
    }
  });
} else await main();

// ---------------------------------------------------------------------------------------------------
// The parent: seed, start the child, fire requests, report.

async function main(): Promise<void> {
  const soak = args.includes("--soak");
  const seconds = opt("--seconds", soak ? 600 : 30);
  const concurrency = opt("--concurrency", 50);
  const rate = opt("--rate", 100);
  const records = opt("--records", 5_000);
  const writes = opt("--writes", 5);
  const jsonOut = args.includes("--json") ? args[args.indexOf("--json") + 1] : undefined;

  const dir = mkdtempSync(join(tmpdir(), "delphi-feed-load-"));
  const db = join(dir, "feed.db");
  const store = new FeedStore(db);
  const t0 = Date.now();
  store.db.transaction(() => {
    for (let i = 0; i < records; i++) store.put(fakeRecord(i, { nowMs: t0 }), "seeded");
  })();
  console.log(`seeded ${records} fake records in ${Date.now() - t0} ms`);

  const child: ChildProcess = fork(import.meta.filename, ["--serve", db], { execArgv: [...process.execArgv, "--expose-gc"] });
  const ask = <K extends string>(m: string, key: K) =>
    new Promise<Extract<FromChild, Record<K, unknown>>>((resolve) => {
      const on = (r: FromChild) => {
        if (key in r) {
          child.off("message", on);
          resolve(r as Extract<FromChild, Record<K, unknown>>);
        }
      };
      child.on("message", on);
      if (m) child.send(m);
    });
  const { port } = await ask("", "port");
  // Idle sockets are dropped after 4 s, under the server's 5 s keep-alive, as Caddy's `keepalive 4s` does.
  const agent = new Agent({ keepAlive: true, maxSockets: soak ? 256 : concurrency, timeout: 4_000 });
  const pool = Array.from({ length: soak ? 20_000 : 5_000 }, (_, i) => `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`);
  const pick = <T>(a: readonly T[]) => a[Math.floor(Math.random() * a.length)]!;
  let total = records;

  // The watcher's side: records rechecked (and a few new coins) while the server reads.
  let wrote = 0;
  const writer = setInterval(() => {
    const now = Date.now();
    const isNew = Math.random() < 0.2;
    const i = isNew ? total++ : Math.floor(Math.random() * total);
    store.put(fakeRecord(i, { nowMs: now }, { checkedAtMs: now, expiresAtMs: now + 90_000 }), isNew ? "launched" : "rechecked");
    wrote++;
  }, 1000 / Math.max(writes, 0.001));
  if (!writes) clearInterval(writer);

  const lat: number[] = [];
  const status = new Map<string, number>();
  let bytes = 0;
  let checked = 0;
  const etags: string[] = [];
  const count = (k: string) => status.set(k, (status.get(k) ?? 0) + 1);

  const batch = () => `/v1/tokens?ids=${Array.from({ length: 50 }, () => fakeToken(Math.floor(Math.random() * total * 1.02))).join(",")}`;
  function once1(path: string, headers: Record<string, string> = {}, validate = false): Promise<void> {
    const start = performance.now();
    return new Promise((resolve) => {
      const req = request({ host: "127.0.0.1", port, path, agent, headers: { "x-forwarded-for": pick(pool), ...headers } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => {
          bytes += c.length;
          if (validate) chunks.push(c);
        });
        res.on("end", () => {
          lat.push(performance.now() - start);
          count(String(res.statusCode));
          const etag = res.headers.etag;
          if (etag && etags.length < 200 && path.startsWith("/v1/token/")) etags.push(`${path} ${etag}`);
          if (validate && res.statusCode === 200) {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { items: Array<{ record: unknown }> };
            for (const it of body.items) FeedRecord.parse(it.record);
            checked += body.items.length;
          }
          resolve();
        });
      });
      req.on("error", (e: NodeJS.ErrnoException) => {
        count(`error ${e.code ?? e.message}`);
        resolve();
      });
      req.end();
    });
  }

  const mem: Array<{ s: number } & Mem> = [];
  const sampleMem = async () => mem.push({ s: Math.round((Date.now() - started) / 1000), ...(await ask("mem", "mem")).mem });
  await ask("stats", "server"); // clears the seeding-time numbers
  const started = Date.now();
  const clientCpu = process.cpuUsage();
  const deadline = started + seconds * 1000;
  await sampleMem();

  if (!soak) {
    let n = 0;
    const worker = async () => {
      while (Date.now() < deadline) await once1(batch(), {}, n++ % 500 === 0);
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
  } else {
    // A steady mix, close to what many Sniper viewers would send, plus some junk and one abusive address.
    let inflight = 0;
    let dropped = 0;
    let fired = 0;
    const memTimer = setInterval(() => void sampleMem(), 30_000); // each sample forces a full GC, so not too often
    let lastReport = Date.now();
    await new Promise<void>((resolve) => {
      const tick = setInterval(() => {
        const due = Math.floor(((Date.now() - started) / 1000) * rate) - fired;
        for (let k = 0; k < due; k++) {
          fired++;
          if (inflight > 500) {
            dropped++;
            continue;
          }
          const r = Math.random();
          let p: Promise<void>;
          if (r < 0.7) p = once1(batch(), {}, fired % 1_000 === 0);
          else if (r < 0.8) p = once1(`/v1/token/${fakeToken(Math.floor(Math.random() * total))}`);
          else if (r < 0.85) p = once1(`/v1/new?venue=${pick(["perpme", "kalos", "ascend"])}`);
          else if (r < 0.9) p = once1(`/v1/history/${fakeToken(Math.floor(Math.random() * total))}`);
          else if (r < 0.93) p = once1("/v1/health");
          else if (r < 0.97 && etags.length) {
            const [path, etag] = pick(etags).split(" ") as [string, string];
            p = once1(path, { "if-none-match": etag });
          } else p = once1(`/v1/token/0x${"z".repeat(40)}`);
          inflight++;
          void p.then(() => inflight--);
          // Every 10 s one address sends 60 at once: its burst of 40 passes, the other 20 get 429.
          if (fired % (rate * 10) === 0) {
            for (let b = 0; b < 60; b++) {
              inflight++;
              void once1("/v1/health", { "x-forwarded-for": "203.0.113.66" }).then(() => inflight--);
            }
          }
        }
        if (Date.now() - lastReport > 60_000) {
          lastReport = Date.now();
          const m = mem.at(-1)!;
          console.log(`  ${Math.round((Date.now() - started) / 1000)} s: ${lat.length} answers, heap ${(m.heapUsed / 2 ** 20).toFixed(1)} MB, rss ${(m.rss / 2 ** 20).toFixed(1)} MB`);
        }
        if (Date.now() >= deadline) {
          clearInterval(tick);
          clearInterval(memTimer);
          const wait = setInterval(() => {
            if (inflight === 0) {
              clearInterval(wait);
              resolve();
            }
          }, 20);
        }
      }, 10);
    });
    if (dropped) count(`not sent (over 500 in flight) ${dropped}`);
  }

  const elapsed = (Date.now() - started) / 1000;
  const cc = process.cpuUsage(clientCpu);
  clearInterval(writer);
  await sampleMem();
  const srv = (await ask("stats", "server")).server;
  child.send("stop");
  await once(child, "exit");
  agent.destroy();
  store.close();
  rmSync(dir, { recursive: true, force: true });

  const s = lat.sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
  const ok = (status.get("200") ?? 0) + (status.get("304") ?? 0);
  const expectedErrors = soak ? (status.get("400") ?? 0) + (status.get("429") ?? 0) : 0;
  const errors = s.length - ok - expectedErrors + [...status].filter(([k]) => k.startsWith("error")).reduce((n, [, v]) => n + v, 0);
  const mb = (b: number) => Math.round((b / 2 ** 20) * 10) / 10;
  const warm = mem.find((m) => m.s >= Math.min(60, seconds / 4)) ?? mem[0]!;
  const last = mem.at(-1)!;
  const report = {
    mode: soak ? "soak" : "load",
    records,
    seconds: Math.round(elapsed),
    ...(soak ? { ratePerSecond: rate } : { concurrency, batch: 50 }),
    requests: s.length,
    perSecond: Math.round(s.length / elapsed),
    status: Object.fromEntries(status),
    errors,
    latencyMs: { p50: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2), p99: +q(0.99).toFixed(2), max: +(s.at(-1) ?? 0).toFixed(2) },
    serverHandlerMs: { p50: +srv.p50.toFixed(3), p99: +srv.p99.toFixed(3), max: +srv.max.toFixed(2) },
    serverGc: { pauses: srv.gc.count, totalMs: Math.round(srv.gc.totalMs), maxMs: +srv.gc.maxMs.toFixed(1), over10ms: srv.gc.over10ms },
    serverEventLoopDelayMs: { p99: +srv.loopDelayMs.p99.toFixed(1), max: +srv.loopDelayMs.max.toFixed(1) },
    serverStallsOver100ms: srv.stalls,
    cpuOfOneCore: { server: `${Math.round(srv.cpuMs / 10 / elapsed)}%`, client: `${Math.round((cc.user + cc.system) / 1e4 / elapsed)}%` },
    avgAnswerKB: Math.round(bytes / Math.max(1, s.length) / 102.4) / 10,
    recordsSchemaChecked: checked,
    writesDuringRun: wrote,
    memoryMB: {
      start: { heap: mb(mem[0]!.heapUsed), rss: mb(mem[0]!.rss) },
      afterWarmup: { atS: warm.s, heap: mb(warm.heapUsed), rss: mb(warm.rss) },
      end: { heap: mb(last.heapUsed), rss: mb(last.rss) },
      heapGrowthAfterWarmup: mb(last.heapUsed - warm.heapUsed),
      rssGrowthAfterWarmup: mb(last.rss - warm.rss),
      maxRss: mb(Math.max(...mem.map((m) => m.rss))),
    },
    ...(soak ? { memorySamples: mem.map((m) => ({ s: m.s, heapMB: mb(m.heapUsed), rssMB: mb(m.rss) })) } : {}),
  };
  const { memorySamples: _samples, ...brief } = report as typeof report & { memorySamples?: unknown };
  console.log(JSON.stringify(brief, null, 2));
  if (jsonOut) {
    mkdirSync(dirname(jsonOut), { recursive: true });
    writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (errors > 0) process.exitCode = 1;
}
