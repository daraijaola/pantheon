// The verdict lookup, on a small file recorded from DELPHI's real scan of Nov 1 (one coin of each kind).
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reasonOf, Verdicts, type CoinVerdict } from "../src/verdicts.ts";

const FIXTURE = new URL("./fixtures/scan.json", import.meta.url).pathname;
const SCANNED = Date.parse(JSON.parse(readFileSync(FIXTURE, "utf8")).generatedAt);
const SNPTEST = "0x8444bf31e9648C97e3736560171dEC3180D77645"; // FLAG
const KITTIQ = "0x34Cc866cC3a2afD5967334CB36d8E6629a6e5174"; // WATCH
const TROLOLO = "0x7856a274D83d2F367966b033c757aCf453A19E20"; // CLEAN, with notes
const PACT = "0x4FAA6142168c6A1126df68CF400839126b3664db"; // CLEAN, no notes
const SNPT = "0xf1BfF5dBc3Fa6b0185C3295b2Cb1c8dE8be654ce"; // NOT_ENOUGH_DATA, 1 trade
const KALOS = "0x8a2201953AF29e8BE7700bcB53dA3ce5caD18726"; // on Kalos
const HDRCHK = "0x0b56C35d8Ca0d323F1F871a7e6Ea1b607C1F0e4C"; // on PerpMe, no trades
const NEVER_READ = "0x1111111111111111111111111111111111111111";

function loaded(opts: { now?: () => number; maxAgeMs?: number } = {}) {
  const v = new Verdicts(FIXTURE, { now: () => SCANNED, ...opts });
  expect(v.refresh()).toBe(true);
  return v;
}
const known = (v: Verdicts, token: string) => {
  const c = v.get(token);
  expect(c.known).toBe(true);
  return c as CoinVerdict;
};

describe("looking up a coin", () => {
  it("gives a flagged coin's verdict, its worst finding as the reason, and the transactions behind it", () => {
    const c = known(loaded(), SNPTEST);
    expect(c.verdict).toBe("FLAG");
    expect(c.reason).toBe(c.findings[0]!.text);
    expect(c.findings[0]!.severity).toBe("flag");
    expect(c.findings[0]!.evidence.length).toBeGreaterThan(0);
  });

  it("links every claim to a transaction", () => {
    for (const token of [SNPTEST, KITTIQ]) {
      for (const f of known(loaded(), token).findings) {
        for (const e of f.evidence) {
          expect(e.tx).toMatch(/^0x[0-9a-f]{64}$/);
          expect(e.url).toContain(e.tx);
        }
      }
    }
  });

  it("says a clean coin is clean so far, and keeps what it noted", () => {
    const v = loaded();
    const noted = known(v, TROLOLO);
    expect(noted.verdict).toBe("CLEAN");
    expect(noted.reason).toBe("Clean so far: every check passed.");
    expect(noted.notes.length).toBeGreaterThan(0);
    expect(known(v, PACT).notes).toEqual([]);
  });

  it("says what's missing when there isn't enough data, with the right word for one", () => {
    const v = loaded();
    expect(known(v, SNPT).reason).toBe("Not enough data yet: 1 trade, 1 holder.");
    expect(known(v, HDRCHK).reason).toBe("Not enough data yet: 0 trades, 0 holders.");
  });

  it("marks where each coin lives, and that this is testnet", () => {
    const v = loaded();
    expect(known(v, PACT).venue).toBe("ascend");
    expect(known(v, KALOS).venue).toBe("kalos");
    expect(known(v, HDRCHK).venue).toBe("perpme");
    expect(known(v, PACT).network).toBe("testnet");
  });

  it("finds a coin however its address is written, and gives it report and dispute links", () => {
    const v = loaded();
    const lower = PACT.toLowerCase();
    expect(known(v, PACT.toUpperCase().replace("0X", "0x")).token).toBe(lower);
    expect(known(v, lower).reportUrl).toBe(`https://pantheonindex.com/delphi/${lower}`);
    expect(known(v, lower).disputeUrl).toBe(`https://pantheonindex.com/delphi/dispute?token=${lower}`);
  });

  it("never calls a coin it hasn't read clean", () => {
    expect(loaded().get(NEVER_READ)).toEqual({ known: false, token: NEVER_READ, verdict: "UNKNOWN", reason: "DELPHI hasn't read this coin yet." });
    expect(new Verdicts(FIXTURE).get(PACT).verdict).toBe("UNKNOWN"); // nothing loaded yet
  });
});

describe("the one-line reason", () => {
  const finding = (severity: "flag" | "watch", summary: string) => ({ detector: "wash", severity, summary, evidence: [] });
  const stats = { trades: 40, holders: 9 };

  it("picks a flag over a watch, wherever it sits in the list", () => {
    expect(reasonOf({ verdict: "FLAG", notes: [], stats, findings: [finding("watch", "mild"), finding("flag", "serious")] })).toBe("serious");
  });

  it("still says something true if a flagged coin has no finding to quote", () => {
    expect(reasonOf({ verdict: "WATCH", notes: ["one big wallet"], stats, findings: [] })).toBe("one big wallet");
    expect(reasonOf({ verdict: "FLAG", notes: [], stats, findings: [] })).toBe("See DELPHI's report on this coin.");
  });
});

describe("how old the verdicts are", () => {
  const HOUR = 3_600_000;

  it("says so once the scan is over 14 hours old, and still answers", () => {
    expect(known(loaded({ now: () => SCANNED + 14 * HOUR }), PACT).stale).toBe(false);
    const old = loaded({ now: () => SCANNED + 14 * HOUR + 1 });
    expect(known(old, PACT).stale).toBe(true);
    expect(known(old, PACT).verdict).toBe("CLEAN");
    expect(old.health().stale).toBe(true);
  });
});

describe("reading DELPHI's file", () => {
  const good = readFileSync(FIXTURE, "utf8");
  let dir: string;
  let file: string;
  let tick = 0;
  /** Writes the file with a new modified time, the way a new scan would. */
  const write = (text: string) => {
    writeFileSync(file, text);
    const t = new Date(1_800_000_000_000 + ++tick * 1000);
    utimesSync(file, t, t);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "uploaded-"));
    file = join(dir, "scan.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("doesn't read an unchanged file again", () => {
    write(good);
    const v = new Verdicts(file);
    expect(v.refresh()).toBe(true);
    expect(v.refresh()).toBe(false);
  });

  it("picks up a new scan, and a coin gone from it is unknown, not clean", () => {
    write(good);
    const v = new Verdicts(file);
    v.refresh();
    const scan = JSON.parse(good);
    scan.reports = scan.reports.filter((r: { coin: { token: string } }) => r.coin.token !== PACT);
    scan.reports[0].verdict = "WATCH";
    write(JSON.stringify(scan));
    expect(v.refresh()).toBe(true);
    expect(v.get(PACT).verdict).toBe("UNKNOWN");
    expect(v.get(SNPTEST).verdict).toBe("WATCH");
    expect(v.health().coins).toBe(6);
  });

  it("keeps the last good copy when it catches the file half-written, then recovers", () => {
    write(good);
    const v = new Verdicts(file);
    v.refresh();
    write(good.slice(0, good.length / 2));
    expect(v.refresh()).toBe(false);
    expect(v.get(PACT).verdict).toBe("CLEAN");
    expect(v.health().lastError).toBeTruthy();
    write(good);
    expect(v.refresh()).toBe(true);
    expect(v.health().lastError).toBeNull();
  });

  it("keeps the last good copy when the file changes shape, instead of guessing", () => {
    write(good);
    const v = new Verdicts(file);
    v.refresh();
    write(good.replaceAll('"verdict": "CLEAN"', '"verdict": "SAFE"'));
    expect(v.refresh()).toBe(false);
    expect(v.get(PACT).verdict).toBe("CLEAN");
    expect(v.health().lastError).toBeTruthy();
  });

  it("starts without the file, answers unknown, and loads it once it appears", () => {
    const v = new Verdicts(file);
    expect(v.refresh()).toBe(false);
    expect(v.health()).toMatchObject({ ready: false, coins: 0, scannedAt: null, stale: null });
    expect(v.get(PACT).verdict).toBe("UNKNOWN");
    write(good);
    expect(v.refresh()).toBe(true);
    expect(v.health()).toMatchObject({ ready: true, coins: 7, network: "testnet" });
  });
});
