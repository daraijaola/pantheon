// SQLite storage (spec §7.1). Schema is created on open; queries for bindings, checks and
// attestations arrive with the API (P7). Times are unix SECONDS unless the column says _ms.
import Database from "better-sqlite3";
import type { Address, Hex } from "viem";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS challenges (nonce TEXT PRIMARY KEY, elysium TEXT NOT NULL, hl TEXT NOT NULL,
  deadline INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS bindings (hl_key TEXT PRIMARY KEY, hl TEXT NOT NULL UNIQUE, elysium TEXT NOT NULL UNIQUE,
  linked_at INTEGER NOT NULL, hl_sig TEXT NOT NULL, ely_sig TEXT, first_seen_ms INTEGER, genesis INTEGER,
  role_checked_at INTEGER, next_check_at INTEGER, status TEXT NOT NULL DEFAULT 'active');
CREATE TABLE IF NOT EXISTS checks (id INTEGER PRIMARY KEY, hl_key TEXT NOT NULL, at INTEGER NOT NULL,
  score_e8 INTEGER NOT NULL, tier INTEGER NOT NULL, stamps INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS attestations (id INTEGER PRIMARY KEY, elysium TEXT NOT NULL, hl_key TEXT NOT NULL,
  tier INTEGER, stamps INTEGER, issued_at INTEGER, expiry INTEGER, deadline INTEGER, sig TEXT, tx_hash TEXT, status TEXT);
`;

export type Db = Database.Database;

/** Open (or create) the database. `:memory:` for tests. */
export function openDatabase(path: string): Db {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  return db;
}

export type Challenge = {
  nonce: Hex;
  elysium: Address;
  hl: Address;
  /** Unix seconds; the signed Link carries the same value. */
  deadline: number;
  used: boolean;
  createdAt: number;
};

export interface ChallengeStore {
  insert(c: Omit<Challenge, "used">): void;
  get(nonce: Hex): Challenge | undefined;
  /** Atomically flip used 0 → 1 while unexpired. True only for the single caller that wins. */
  consume(nonce: Hex, nowSec: number): boolean;
  /** Drop challenges whose deadline passed before `beforeSec`. Returns how many. */
  purgeExpired(beforeSec: number): number;
}

type ChallengeRow = { nonce: string; elysium: string; hl: string; deadline: number; used: number; created_at: number };

export class SqliteChallengeStore implements ChallengeStore {
  #insert;
  #get;
  #consume;
  #purge;

  constructor(db: Db) {
    this.#insert = db.prepare(
      "INSERT INTO challenges (nonce, elysium, hl, deadline, used, created_at) VALUES (?, ?, ?, ?, 0, ?)",
    );
    this.#get = db.prepare<[string], ChallengeRow>("SELECT * FROM challenges WHERE nonce = ?");
    this.#consume = db.prepare("UPDATE challenges SET used = 1 WHERE nonce = ? AND used = 0 AND deadline >= ?");
    this.#purge = db.prepare("DELETE FROM challenges WHERE deadline < ?");
  }

  insert(c: Omit<Challenge, "used">): void {
    this.#insert.run(c.nonce.toLowerCase(), c.elysium, c.hl, c.deadline, c.createdAt);
  }

  get(nonce: Hex): Challenge | undefined {
    const r = this.#get.get(nonce.toLowerCase());
    if (!r) return undefined;
    return {
      nonce: r.nonce as Hex,
      elysium: r.elysium as Address,
      hl: r.hl as Address,
      deadline: r.deadline,
      used: r.used === 1,
      createdAt: r.created_at,
    };
  }

  consume(nonce: Hex, nowSec: number): boolean {
    return this.#consume.run(nonce.toLowerCase(), nowSec).changes === 1;
  }

  purgeExpired(beforeSec: number): number {
    return this.#purge.run(beforeSec).changes;
  }
}
