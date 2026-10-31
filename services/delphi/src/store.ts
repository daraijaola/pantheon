// Local cache (SQLite): raw chain logs with a resume point per stream, plus remembered lookups
// (who sent a transaction, block times, explorer answers). Only public data is ever stored here.
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Hex } from "viem";

export type RawLog = { block: bigint; logIndex: number; tx: Hex; address: Hex; topics: Hex[]; data: Hex };

export class Store {
  readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS logs (
        stream TEXT NOT NULL, block INTEGER NOT NULL, log_index INTEGER NOT NULL,
        tx TEXT NOT NULL, address TEXT NOT NULL, topics TEXT NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY (stream, block, log_index)
      );
      CREATE TABLE IF NOT EXISTS cursors (stream TEXT PRIMARY KEY, next_block INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS memo (
        kind TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, at INTEGER NOT NULL,
        PRIMARY KEY (kind, key)
      );
    `);
  }

  /** The first block not yet scanned for a stream. */
  cursor(stream: string, start: bigint): bigint {
    const row = this.db.prepare("SELECT next_block FROM cursors WHERE stream = ?").get(stream) as { next_block: number } | undefined;
    return row ? BigInt(row.next_block) : start;
  }

  /** Saves a chunk of logs and moves the stream's cursor past it, atomically. */
  saveLogs(stream: string, logs: RawLog[], nextBlock: bigint): void {
    const ins = this.db.prepare(
      "INSERT OR REPLACE INTO logs (stream, block, log_index, tx, address, topics, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const cur = this.db.prepare(
      "INSERT INTO cursors (stream, next_block) VALUES (?, ?) ON CONFLICT(stream) DO UPDATE SET next_block = excluded.next_block",
    );
    this.db.transaction(() => {
      for (const l of logs) {
        ins.run(stream, Number(l.block), l.logIndex, l.tx, l.address.toLowerCase(), JSON.stringify(l.topics), l.data);
      }
      cur.run(stream, Number(nextBlock));
    })();
  }

  /**
   * Forgets a stream's logs before `before` and starts its cursor there if it was behind: for a window
   * of recent history that moves forward with the chain. Logs at or after `before` are kept.
   */
  trimLogs(stream: string, before: bigint): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM logs WHERE stream = ? AND block < ?").run(stream, Number(before));
      this.db
        .prepare(
          "INSERT INTO cursors (stream, next_block) VALUES (?, ?) ON CONFLICT(stream) DO UPDATE SET next_block = MAX(next_block, excluded.next_block)",
        )
        .run(stream, Number(before));
    })();
  }

  /** How many logs a stream holds. */
  countLogs(stream: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM logs WHERE stream = ?").get(stream) as { n: number }).n;
  }

  logs(stream: string): RawLog[] {
    const rows = this.db
      .prepare("SELECT block, log_index, tx, address, topics, data FROM logs WHERE stream = ? ORDER BY block, log_index")
      .all(stream) as Array<{ block: number; log_index: number; tx: Hex; address: Hex; topics: string; data: Hex }>;
    return rows.map((r) => ({ block: BigInt(r.block), logIndex: r.log_index, tx: r.tx, address: r.address, topics: JSON.parse(r.topics) as Hex[], data: r.data }));
  }

  /** A remembered answer, if younger than `maxAgeSec` (default: forever). */
  recall<T>(kind: string, key: string, maxAgeSec = Infinity, now = Date.now()): T | undefined {
    const row = this.db.prepare("SELECT value, at FROM memo WHERE kind = ? AND key = ?").get(kind, key.toLowerCase()) as
      | { value: string; at: number }
      | undefined;
    if (!row || now - row.at > maxAgeSec * 1000) return undefined;
    return JSON.parse(row.value) as T;
  }

  remember(kind: string, key: string, value: unknown, now = Date.now()): void {
    this.db
      .prepare("INSERT OR REPLACE INTO memo (kind, key, value, at) VALUES (?, ?, ?, ?)")
      .run(kind, key.toLowerCase(), JSON.stringify(value), now);
  }

  /** Remembered answers for many keys at once (no age limit); keys not remembered are left out. */
  recallMany<T>(kind: string, keys: Iterable<string>): Map<string, T> {
    const out = new Map<string, T>();
    const all = [...new Set([...keys].map((k) => k.toLowerCase()))];
    for (let i = 0; i < all.length; i += 500) {
      const chunk = all.slice(i, i + 500);
      const rows = this.db
        .prepare(`SELECT key, value FROM memo WHERE kind = ? AND key IN (${chunk.map(() => "?").join(",")})`)
        .all(kind, ...chunk) as Array<{ key: string; value: string }>;
      for (const r of rows) out.set(r.key, JSON.parse(r.value) as T);
    }
    return out;
  }

  /** Remembers many answers in one transaction. */
  rememberMany(kind: string, entries: Iterable<readonly [string, unknown]>, now = Date.now()): void {
    const ins = this.db.prepare("INSERT OR REPLACE INTO memo (kind, key, value, at) VALUES (?, ?, ?, ?)");
    this.db.transaction(() => {
      for (const [k, v] of entries) ins.run(kind, k.toLowerCase(), JSON.stringify(v), now);
    })();
  }

  close(): void {
    this.db.close();
  }
}
