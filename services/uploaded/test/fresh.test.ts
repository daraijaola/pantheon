// Fresh reads, with a stand-in for DELPHI's script: no chain, no child process.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/api.ts";
import { FreshChecks, runDelphi, type Runner } from "../src/fresh.ts";
import { Verdicts, type CoinVerdict } from "../src/verdicts.ts";

const FIXTURE = new URL("./fixtures/scan.json", import.meta.url).pathname;
const SCAN = JSON.parse(readFileSync(FIXTURE, "utf8"));
const SCANNED = Date.parse(SCAN.generatedAt);
const MINUTE = 60_000;
const PACT = "0x4FAA6142168c6A1126df68CF400839126b3664db"; // Ascend, CLEAN
const KALOS = "0x8a2201953AF29e8BE7700bcB53dA3ce5caD18726";
const PERPME = "0x0b56C35d8Ca0d323F1F871a7e6Ea1b607C1F0e4C";
const NEW_COIN = "0x2222222222222222222222222222222222222222";

/** A read that finishes when told to. */
function controlled() {
  let calls = 0;
  let finish: (json: string) => void = () => {};
  let fail: (err: Error) => void = () => {};
  const run: Runner = () => {
    calls += 1;
    return new Promise((res, rej) => {
      finish = res;
      fail = rej;
    });
  };
  return { run, calls: () => calls, finish: (j: string) => finish(j), fail: (e: Error) => fail(e) };
}
/** The recorded scan, read again later, with this coin's verdict changed (and a coin added, if asked). */
function freshRead(atMs: number, verdict = "WATCH", added?: string) {
  const reports = structuredClone(SCAN.reports).map((r: { coin: { token: string }; verdict: string }) => (r.coin.token === PACT ? { ...r, verdict } : r));
  if (added) reports.push({ ...structuredClone(SCAN.reports[0]), coin: { ...SCAN.reports[0].coin, token: added } });
  return JSON.stringify({ network: "testnet", generatedAt: new Date(atMs).toISOString(), reports });
}
const settle = () => new Promise((r) => setImmediate(r));

function setup(startAt = SCANNED + 31 * MINUTE) {
  let t = startAt;
  const v = new Verdicts(FIXTURE, { now: () => t });
  v.refresh();
  const c = controlled();
  const logs: string[] = [];
  const fresh = new FreshChecks(v, c.run, { now: () => t, log: (m) => logs.push(m) });
  return { v, c, fresh, logs, advance: (ms: number) => (t += ms), at: () => t };
}

describe("when a fresh read starts", () => {
  it("leaves a recent verdict alone", () => {
    const { v, c, fresh } = setup(SCANNED + 29 * MINUTE);
    expect(fresh.ask(v.get(PACT))).toBe(false);
    expect(c.calls()).toBe(0);
  });

  it("refreshes a verdict over 30 minutes old, and a coin it hasn't read", () => {
    const a = setup();
    expect(a.fresh.ask(a.v.get(PACT))).toBe(true);
    expect(a.c.calls()).toBe(1);
    const b = setup(SCANNED);
    expect(b.fresh.ask(b.v.get(NEW_COIN))).toBe(true);
    expect(b.c.calls()).toBe(1);
  });

  it("never starts one for Kalos or PerpMe coins, because a read doesn't cover them", () => {
    const { v, c, fresh } = setup(SCANNED + 24 * 60 * MINUTE);
    expect(fresh.ask(v.get(KALOS))).toBe(false);
    expect(fresh.ask(v.get(PERPME))).toBe(false);
    expect(c.calls()).toBe(0);
  });

  it("runs one at a time, however many ask", () => {
    const { v, c, fresh } = setup();
    for (let i = 0; i < 20; i++) expect(fresh.ask(v.get(PACT))).toBe(true);
    expect(c.calls()).toBe(1);
  });

  it("waits out the gap before the next one, even after a read finds nothing", async () => {
    const { v, c, fresh, advance, at } = setup();
    fresh.ask(v.get(NEW_COIN));
    c.finish(freshRead(at()));
    await settle();
    advance(4 * MINUTE);
    expect(fresh.ask(v.get(NEW_COIN))).toBe(false);
    expect(c.calls()).toBe(1);
    advance(MINUTE);
    expect(fresh.ask(v.get(NEW_COIN))).toBe(true);
    expect(c.calls()).toBe(2);
  });
});

describe("when a fresh read finishes", () => {
  it("replaces the old verdict, with the new time", async () => {
    const { v, c, fresh, at } = setup();
    fresh.ask(v.get(PACT));
    expect(v.get(PACT).verdict).toBe("CLEAN"); // still the held one while it runs
    c.finish(freshRead(at()));
    await settle();
    const coin = v.get(PACT) as CoinVerdict;
    expect(coin.verdict).toBe("WATCH");
    expect(coin.scannedAt).toBe(new Date(at()).toISOString());
    expect(v.health().freshAt).toBe(coin.scannedAt);
  });

  it("makes a coin launched after the scan known", async () => {
    const { v, c, fresh, at } = setup();
    expect(v.get(NEW_COIN).verdict).toBe("UNKNOWN");
    fresh.ask(v.get(NEW_COIN));
    c.finish(freshRead(at(), "WATCH", NEW_COIN));
    await settle();
    expect(v.get(NEW_COIN).known).toBe(true);
  });

  it("gives way to a newer scan, so an older fresh read never outranks it", () => {
    const dir = mkdtempSync(join(tmpdir(), "uploaded-"));
    try {
      const file = join(dir, "scan.json");
      const v = new Verdicts(file, { now: () => SCANNED });
      writeFileSync(file, freshRead(SCANNED, "CLEAN"));
      utimesSync(file, new Date(1_800_000_000_000), new Date(1_800_000_000_000));
      v.refresh();
      expect(v.applyFresh(freshRead(SCANNED + MINUTE, "WATCH"))).toBe(true);
      expect(v.get(PACT).verdict).toBe("WATCH");
      writeFileSync(file, freshRead(SCANNED + 2 * MINUTE, "FLAG"));
      utimesSync(file, new Date(1_800_000_001_000), new Date(1_800_000_001_000));
      expect(v.refresh()).toBe(true);
      expect(v.get(PACT).verdict).toBe("FLAG");
      expect(v.health().freshAt).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("doesn't touch Kalos or PerpMe coins it didn't read", async () => {
    const { v, c, fresh, at } = setup();
    const before = v.get(KALOS) as CoinVerdict;
    fresh.ask(v.get(PACT));
    const only = JSON.parse(freshRead(at()));
    only.reports = only.reports.filter((r: { coin: { market?: string } }) => !r.coin.market);
    c.finish(JSON.stringify(only));
    await settle();
    expect(v.get(KALOS)).toEqual(before);
  });

  it("ignores a read older than what's held", () => {
    const { v } = setup();
    expect(v.applyFresh(freshRead(SCANNED - MINUTE))).toBe(false);
    expect(v.get(PACT).verdict).toBe("CLEAN");
  });

  it("keeps what it has when a read fails or prints nonsense, and tries again later", async () => {
    const { v, c, fresh, logs, advance } = setup();
    fresh.ask(v.get(PACT));
    c.fail(new Error("Command failed: node scripts/fresh-read.ts\nlong stack here"));
    await settle();
    expect(v.get(PACT).verdict).toBe("CLEAN");
    expect(logs[0]).toContain("fresh read failed");
    expect(logs[0]).not.toContain("long stack");
    advance(5 * MINUTE);
    fresh.ask(v.get(PACT));
    c.finish("{half a fi");
    await settle();
    expect(v.get(PACT).verdict).toBe("CLEAN");
    expect(logs).toHaveLength(2);
    advance(5 * MINUTE);
    expect(fresh.ask(v.get(PACT))).toBe(true); // not stuck
  });
});

describe("shutting down", () => {
  it("stops a running read and starts no more", () => {
    let signal: AbortSignal | undefined;
    const v = new Verdicts(FIXTURE, { now: () => SCANNED + 31 * MINUTE });
    v.refresh();
    const fresh = new FreshChecks(v, (s) => ((signal = s), new Promise(() => {})), { now: () => SCANNED + 31 * MINUTE });
    fresh.ask(v.get(PACT));
    expect(signal?.aborted).toBe(false);
    fresh.stop();
    expect(signal?.aborted).toBe(true);
    expect(fresh.ask(v.get(PACT))).toBe(false);
  });
});

describe("the real script runner", () => {
  /** A stand-in for DELPHI's folder: its fresh-read script is whatever the test says. */
  function delphiDir(script: string) {
    const dir = mkdtempSync(join(tmpdir(), "uploaded-"));
    mkdirSync(join(dir, "scripts"));
    writeFileSync(join(dir, "scripts", "fresh-read.ts"), script);
    return dir;
  }

  it("hands back what the script printed", async () => {
    const dir = delphiDir(`process.stdout.write('{"ok":true}');`);
    try {
      await expect(runDelphi(dir)(new AbortController().signal)).resolves.toBe('{"ok":true}');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a script that fails or can't run, instead of hanging", async () => {
    const dir = delphiDir(`process.exit(3);`);
    try {
      await expect(runDelphi(dir)(new AbortController().signal)).rejects.toThrow();
      await expect(runDelphi("/nowhere")(new AbortController().signal)).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("really stops a script when told to", async () => {
    const dir = delphiDir(`setTimeout(() => {}, 60_000);`);
    try {
      const stop = new AbortController();
      const t0 = Date.now();
      const run = runDelphi(dir)(stop.signal);
      setTimeout(() => stop.abort(), 100);
      await expect(run).rejects.toThrow();
      expect(Date.now() - t0).toBeLessThan(5_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("asking the server", () => {
  it("answers at once with what it holds, says a read is on its way, then gives the fresh verdict", async () => {
    const { v, c, fresh, at } = setup();
    const app = buildApp(v, { fresh });
    const first = (await app.inject({ url: `/coins/${PACT}` })).json();
    expect(first).toMatchObject({ verdict: "CLEAN", checking: true });
    c.finish(freshRead(at()));
    await settle();
    expect((await app.inject({ url: `/coins/${PACT}` })).json()).toMatchObject({ verdict: "WATCH", checking: false });
  });

  it("says nothing is on its way for a Kalos coin, or when fresh reads are off", async () => {
    const { v, fresh } = setup();
    expect((await buildApp(v, { fresh }).inject({ url: `/coins/${KALOS}` })).json()).toMatchObject({ checking: false });
    expect((await buildApp(v).inject({ url: `/coins/${PACT}` })).json()).toMatchObject({ checking: false });
  });
});
