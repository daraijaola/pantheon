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

  close(): void {
    this.db.close();
  }
}
