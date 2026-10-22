// What DELPHI-on-X remembers (SQLite, its own file): every mention she saw and what she did with it,
// her replies (so a follow-up knows which coin it was about), and where she stopped reading. A
// mention is recorded before she answers, and marked "posting" before her reply is sent: once a
// reply may have gone out (a timeout, a crash, an X server error), that mention is never tried
// again, so she can't answer the same post twice.
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Status = "pending" | "posting" | "unsure" | "replied" | "drafted" | "silent" | "skipped" | "failed";
/** Outcomes that count as an answer for the caps: a reply that went out, or may have. */
const ANSWERED = "('replied', 'drafted', 'posting', 'unsure')";

export type Row = {
  id: string;
  author: string;
  text: string;
  status: Status;
  reason: string | null;
  reply_id: string | null;
  reply_text: string | null;
  token: string | null;
  cost: number;
  attempts: number;
  at: number;
};

export class XState {
  readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mentions (
        id TEXT PRIMARY KEY, author TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL,
        reason TEXT, reply_id TEXT, reply_text TEXT, token TEXT, cost REAL NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS mentions_author_at ON mentions (author, at);
      CREATE INDEX IF NOT EXISTS mentions_reply ON mentions (reply_id);
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  get(id: string): Row | undefined {
    return this.db.prepare("SELECT * FROM mentions WHERE id = ?").get(id) as Row | undefined;
  }

  /**
   * Claims a mention for an attempt. False if it was already handled, tried too often, or a reply may
   * already be out ("posting" left by a crash, "unsure" after a timeout): those are never retried.
   */
  claim(id: string, author: string, text: string, now: number, maxAttempts = 2): boolean {
    const row = this.get(id);
    if (row && (row.status !== "failed" && row.status !== "pending")) return false;
    if (row && row.attempts >= maxAttempts) return false;
    this.db
      .prepare(
        `INSERT INTO mentions (id, author, text, status, attempts, at) VALUES (?, ?, ?, 'pending', 1, ?)
         ON CONFLICT(id) DO UPDATE SET status = 'pending', attempts = attempts + 1`,
      )
      .run(id, author.toLowerCase(), text, now);
    return true;
  }

  /** Just before the reply is sent: from here on, a crash leaves "posting" and the mention is not retried. */
  posting(id: string): void {
    this.db.prepare("UPDATE mentions SET status = 'posting' WHERE id = ?").run(id);
  }

  finish(id: string, status: Exclude<Status, "pending" | "posting">, f: { reason?: string; replyId?: string; replyText?: string; token?: string | null; cost?: number } = {}): void {
    this.db
      .prepare("UPDATE mentions SET status = ?, reason = ?, reply_id = ?, reply_text = ?, token = ?, cost = cost + ? WHERE id = ?")
      .run(status, f.reason ?? null, f.replyId ?? null, f.replyText ?? null, f.token ?? null, f.cost ?? 0, id);
  }

  /** X said "too many requests" before anything went out: try again later, without using up a try. */
  retryLater(id: string, f: { reason: string; cost?: number }): void {
    this.db.prepare("UPDATE mentions SET status = 'failed', reason = ?, attempts = MAX(0, attempts - 1), cost = cost + ? WHERE id = ?").run(f.reason, f.cost ?? 0, id);
  }

  /** Her reply with this id, if it is one of hers (for follow-up questions). */
  reply(replyId: string): Row | undefined {
    return this.db.prepare("SELECT * FROM mentions WHERE reply_id = ?").get(replyId) as Row | undefined;
  }

  /** Replies (or drafts) since a time: for the daily cap. */
  answeredSince(since: number): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM mentions WHERE status IN ${ANSWERED} AND at >= ?`).get(since) as { n: number }).n;
  }

  /** Answers to one person since a time: for the per-person cap. */
  answeredForSince(author: string, since: number): number {
    return (
      this.db.prepare(`SELECT COUNT(*) AS n FROM mentions WHERE author = ? AND status IN ${ANSWERED} AND at >= ?`).get(author.toLowerCase(), since) as {
        n: number;
      }
    ).n;
  }

  spentSince(since: number): number {
    return (this.db.prepare("SELECT COALESCE(SUM(cost), 0) AS c FROM mentions WHERE at >= ?").get(since) as { c: number }).c;
  }

  value(key: string): string | null {
    return (this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? null;
  }

  setValue(key: string, value: string): void {
    this.db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  close(): void {
    this.db.close();
  }
}
