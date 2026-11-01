import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FeedStore } from "../src/live/store.ts";
import { disputeMessage, FeedRecord } from "../src/live/types.ts";

const T = "0x00000000000000000000000000000000000000a3";
const C = "0x00000000000000000000000000000000000000c0";
const TX = `0x${"1".repeat(64)}`;

/** A valid v1 record; `over` changes any field. */
export function record(over: Partial<FeedRecord> = {}): FeedRecord {
  return {
    v: 1,
    chainId: 99801,
    token: T,
    venue: "perpme",
    pool: "0x00000000000000000000000000000000000000b0",
    symbol: "TEST",
    name: "Test Coin",
    state: "pending",
    verdict: "CHECKING",
    checks: [{ code: "bundle", result: "pending", text: "Checking the first buyers.", evidence: [] }],
    holders: null,
    dev: { address: C, share: 0.02, sold: false },
    people: null,
    fakeTickerOf: null,
    launch: { tx: TX, block: "1000", timeMs: 1_760_000_000_000, creator: C, creatorBuyShare: 0.02 },
    rules: "delphi-v0.5",
    block: "1000",
    blockHash: null,
    checkedAtMs: 1_760_000_001_000,
    expiresAtMs: 1_760_000_061_000,
    displayOnly: true,
    reportUrl: "https://pantheonindex.com/delphi/0x00000000000000000000000000000000000000a3",
    disputeUrl: "https://pantheonindex.com/delphi/dispute?token=0x00000000000000000000000000000000000000a3",
    ...over,
  };
}

describe("FeedStore", () => {
  it("keeps the latest record and logs each verdict change once, with why", () => {
    const s = new FeedStore(":memory:");
    s.put(record(), "launched");
    s.put(record({ checkedAtMs: 1_760_000_002_000 }), "still checking");
    s.put(record({ state: "ready", verdict: "FLAG", checkedAtMs: 1_760_000_030_000 }), "3 linked wallets bought 18% at launch");
    expect(s.get(T.toUpperCase().replace("0X", "0x"))?.verdict).toBe("FLAG");
    expect(s.history(T).map((h) => [h.verdict, h.why])).toEqual([
      ["CHECKING", "launched"],
      ["FLAG", "3 linked wallets bought 18% at launch"],
    ]);
  });

  it("refuses a record that breaks the v1 format, so nobody is ever served one", () => {
    const s = new FeedStore(":memory:");
    expect(() => s.put(record({ token: "0xABC" }))).toThrow();
    expect(() => s.put({ ...record(), displayOnly: false } as unknown as FeedRecord)).toThrow();
    expect(s.get(T)).toBeNull();
  });

  it("lists the newest coins first, per venue, and pages by launch block", () => {
    const s = new FeedStore(":memory:");
    for (let i = 0; i < 5; i++) {
      const token = `0x${(0xa0 + i).toString(16).padStart(40, "0")}`;
      s.put(record({ token, venue: i % 2 ? "kalos" : "perpme", launch: { ...record().launch, block: String(1000 + i) } }));
    }
    expect(s.recent({ limit: 2 }).map((r) => r.launch.block)).toEqual(["1004", "1003"]);
    expect(s.recent({ venue: "kalos" }).map((r) => r.launch.block)).toEqual(["1003", "1001"]);
    expect(s.recent({ beforeBlock: 1002n }).map((r) => r.launch.block)).toEqual(["1001", "1000"]);
    expect(s.many([`0x${(0xa1).toString(16).padStart(40, "0")}`, "0x0000000000000000000000000000000000000fff"])).toHaveLength(1);
  });

  it("keeps disputes until a person answers them", () => {
    const s = new FeedStore(":memory:");
    const id = s.addDispute({ token: T, contact: "@someone", message: "those two wallets are a market maker, not the dev" });
    expect(s.disputes("open")).toHaveLength(1);
    s.answerDispute(id, "changed", "right: rules v0.5 treat it as a market maker now");
    expect(s.disputes("open")).toHaveLength(0);
    expect(s.disputes()[0]).toMatchObject({ status: "changed", answer: expect.stringContaining("market maker") });
  });

  it("adds the wallet column to a feed database made before signed disputes, and keeps its disputes", () => {
    const dir = mkdtempSync(join(tmpdir(), "delphi-feed-old-"));
    const path = join(dir, "feed.db");
    try {
      // the disputes table as it was before signed disputes
      const old = new Database(path);
      old.exec("CREATE TABLE disputes (id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT NOT NULL, contact TEXT NOT NULL, message TEXT NOT NULL, at_ms INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open', answer TEXT)");
      old.prepare("INSERT INTO disputes (token, contact, message, at_ms) VALUES (?, ?, ?, ?)").run(T, "@before", "an old dispute", 1);
      old.close();
      const s = new FeedStore(path);
      expect(s.disputes()).toEqual([{ id: 1, token: T, contact: "@before", message: "an old dispute", atMs: 1, status: "open", answer: null }]);
      s.addDispute({ token: T, contact: "@after", message: "signed", wallet: "0x00000000000000000000000000000000000000AB" }, 2);
      expect(s.disputes()[1]).toMatchObject({ id: 2, wallet: "0x00000000000000000000000000000000000000ab" });
      s.close();
      // opening it again (the server and the watcher both do) changes nothing
      const again = new FeedStore(path);
      expect(again.disputes().map((d) => d.wallet)).toEqual([undefined, "0x00000000000000000000000000000000000000ab"]);
      expect((again.db.prepare("PRAGMA table_info(disputes)").all() as Array<{ name: string }>).filter((c) => c.name === "wallet")).toHaveLength(1);
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("signs a dispute over a fixed, plain message", () => {
    expect(disputeMessage({ token: "0x00000000000000000000000000000000000000A3", message: "hi", signedAt: 1_793_750_400 })).toBe(
      "PANTHEON dispute\ncoin: 0x00000000000000000000000000000000000000a3\nmessage sha256: 8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4\nsigned at: 1793750400",
    );
    // the message's UTF-8 bytes, whatever the language
    expect(disputeMessage({ token: T, message: "Ces deux portefeuilles — 做市商", signedAt: 1 })).toContain("message sha256: 7222c2a8b72784f6c66723d0f5789cc5ec2a7b2cfea4f0e8c46883a3ba015dd2");
  });

  it("accepts every field the format promises, and nothing looser", () => {
    expect(FeedRecord.safeParse(record()).success).toBe(true);
    expect(FeedRecord.safeParse(record({ checks: [{ code: "Bad Code!", result: "flag", text: "x", evidence: [] }] })).success).toBe(false);
    expect(FeedRecord.safeParse(record({ dev: { address: C, share: 1.5, sold: false } })).success).toBe(false);
  });
});
