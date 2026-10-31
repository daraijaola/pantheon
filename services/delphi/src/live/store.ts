// Where the live feed keeps what it serves: one record per coin (the latest), every verdict change
// with its time (the public record), and disputes waiting for a person. SQLite, separate from the
// scan's cache, so the feed server can read it while the watcher writes.
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { FeedRecord, type Dispute, type Venue } from "./types.ts";

export type VerdictChange = { token: string; atMs: number; verdict: FeedRecord["verdict"]; rules: string; why: string };
export type StoredDispute = Dispute & { id: number; atMs: number; status: "open" | "answered" | "changed" | "upheld"; answer: string | null };

export class FeedStore {
  readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS feed (
        token TEXT PRIMARY KEY, venue TEXT NOT NULL, launch_block INTEGER NOT NULL,
        verdict TEXT NOT NULL, record TEXT NOT NULL, updated_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS feed_new ON feed (venue, launch_block DESC);
      CREATE TABLE IF NOT EXISTS verdicts (
        token TEXT NOT NULL, at_ms INTEGER NOT NULL, verdict TEXT NOT NULL, rules TEXT NOT NULL, why TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS verdicts_token ON verdicts (token, at_ms);
      CREATE TABLE IF NOT EXISTS disputes (
        id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT NOT NULL, contact TEXT NOT NULL, message TEXT NOT NULL,
        at_ms INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open', answer TEXT
      );
    `);
  }

  /**
   * Saves a coin's latest record (checked against the v1 format first: a bad record never reaches
   * anyone). A new verdict is added to the coin's history with the reason it changed.
   */
  put(record: FeedRecord, why = ""): void {
    const r = FeedRecord.parse(record);
    const prev = this.db.prepare("SELECT verdict FROM feed WHERE token = ?").get(r.token) as { verdict: string } | undefined;
    this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO feed (token, venue, launch_block, verdict, record, updated_ms) VALUES (?, ?, ?, ?, ?, ?) " +
            "ON CONFLICT(token) DO UPDATE SET venue = excluded.venue, launch_block = excluded.launch_block, verdict = excluded.verdict, record = excluded.record, updated_ms = excluded.updated_ms",
        )
        .run(r.token, r.venue, Number(r.launch.block), r.verdict, JSON.stringify(r), r.checkedAtMs);
      if (prev?.verdict !== r.verdict) {
        this.db.prepare("INSERT INTO verdicts (token, at_ms, verdict, rules, why) VALUES (?, ?, ?, ?, ?)").run(r.token, r.checkedAtMs, r.verdict, r.rules, why.slice(0, 300));
      }
    })();
  }

  get(token: string): FeedRecord | null {
    const row = this.db.prepare("SELECT record FROM feed WHERE token = ?").get(token.toLowerCase()) as { record: string } | undefined;
    return row ? (JSON.parse(row.record) as FeedRecord) : null;
  }

  /** Many at once, in the order asked; unknown tokens are left out. */
  many(tokens: readonly string[]): FeedRecord[] {
    return tokens.map((t) => this.get(t)).filter((r): r is FeedRecord => r !== null);
  }

  /** The newest coins first, from one venue or all, before a launch block (for paging). */
  recent(opts: { venue?: Venue; limit?: number; beforeBlock?: bigint } = {}): FeedRecord[] {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (opts.venue) {
      where.push("venue = ?");
      args.push(opts.venue);
    }
    if (opts.beforeBlock !== undefined) {
      where.push("launch_block < ?");
      args.push(Number(opts.beforeBlock));
    }
    const sql = `SELECT record FROM feed ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY launch_block DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...args, Math.min(opts.limit ?? 50, 200)) as Array<{ record: string }>;
    return rows.map((r) => JSON.parse(r.record) as FeedRecord);
  }

  /** Every verdict a coin has had, oldest first: DELPHI's public record. */
  history(token: string): VerdictChange[] {
    const rows = this.db.prepare("SELECT token, at_ms, verdict, rules, why FROM verdicts WHERE token = ? ORDER BY at_ms").all(token.toLowerCase()) as Array<{
      token: string;
      at_ms: number;
      verdict: FeedRecord["verdict"];
      rules: string;
      why: string;
    }>;
    return rows.map((r) => ({ token: r.token, atMs: r.at_ms, verdict: r.verdict, rules: r.rules, why: r.why }));
  }

  addDispute(d: Dispute, atMs = Date.now()): number {
    const info = this.db.prepare("INSERT INTO disputes (token, contact, message, at_ms) VALUES (?, ?, ?, ?)").run(d.token.toLowerCase(), d.contact, d.message, atMs);
    return Number(info.lastInsertRowid);
  }

  disputes(status?: StoredDispute["status"]): StoredDispute[] {
    const rows = (
      status
        ? this.db.prepare("SELECT * FROM disputes WHERE status = ? ORDER BY at_ms").all(status)
        : this.db.prepare("SELECT * FROM disputes ORDER BY at_ms").all()
    ) as Array<{ id: number; token: string; contact: string; message: string; at_ms: number; status: StoredDispute["status"]; answer: string | null }>;
    return rows.map((r) => ({ id: r.id, token: r.token, contact: r.contact, message: r.message, atMs: r.at_ms, status: r.status, answer: r.answer }));
  }

  answerDispute(id: number, status: Exclude<StoredDispute["status"], "open">, answer: string): void {
    this.db.prepare("UPDATE disputes SET status = ?, answer = ? WHERE id = ?").run(status, answer.slice(0, 1200), id);
  }

  close(): void {
    this.db.close();
  }
}
