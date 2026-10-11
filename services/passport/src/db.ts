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

// ---------------------------------------------------------------- bindings, checks, attestations (§7.1)

export type Binding = {
  hlKey: Hex;
  hl: Address;
  elysium: Address;
  linkedAt: number;
  hlSig: Hex;
  elySig: Hex | null;
  firstSeenMs: number | null;
  genesis: boolean;
  roleCheckedAt: number | null;
  nextCheckAt: number | null;
  status: "active" | "unlinked";
};

export type CheckRow = { at: number; scoreE8: bigint; tier: number; stamps: number };

export type AttestationRow = {
  elysium: Address;
  hlKey: Hex;
  tier: number;
  stamps: number;
  issuedAt: number;
  expiry: number;
  deadline: number;
  sig: Hex;
  txHash: Hex | null;
  status: "signed" | "submitted" | "confirmed" | "failed";
};

type BindingRow = {
  hl_key: string;
  hl: string;
  elysium: string;
  linked_at: number;
  hl_sig: string;
  ely_sig: string | null;
  first_seen_ms: number | null;
  genesis: number | null;
  role_checked_at: number | null;
  next_check_at: number | null;
  status: string;
};

const toBinding = (r: BindingRow): Binding => ({
  hlKey: r.hl_key as Hex,
  hl: r.hl as Address,
  elysium: r.elysium as Address,
  linkedAt: r.linked_at,
  hlSig: r.hl_sig as Hex,
  elySig: r.ely_sig as Hex | null,
  firstSeenMs: r.first_seen_ms,
  genesis: r.genesis === 1,
  roleCheckedAt: r.role_checked_at,
  nextCheckAt: r.next_check_at,
  status: r.status === "unlinked" ? "unlinked" : "active",
});

/** Addresses are stored checksummed and hlKeys lowercase, so lookups compare exactly. */
export class PassportStore {
  #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  /**
   * Record the current link for an hlKey. Rows that would break 1:1 (the same HL or Elysium address
   * under another hlKey, e.g. an old link the chain has since freed) are dropped in the same transaction.
   */
  upsertBinding(b: Omit<Binding, "status">): void {
    const key = b.hlKey.toLowerCase();
    this.#db.transaction(() => {
      this.#db.prepare("DELETE FROM bindings WHERE hl_key <> ? AND (hl = ? OR elysium = ?)").run(key, b.hl, b.elysium);
      this.#db
        .prepare(
          `INSERT INTO bindings (hl_key, hl, elysium, linked_at, hl_sig, ely_sig, first_seen_ms, genesis, role_checked_at, next_check_at, status)
           VALUES (@key, @hl, @elysium, @linkedAt, @hlSig, @elySig, @firstSeenMs, @genesis, @roleCheckedAt, @nextCheckAt, 'active')
           ON CONFLICT (hl_key) DO UPDATE SET hl = excluded.hl, elysium = excluded.elysium, hl_sig = excluded.hl_sig,
             ely_sig = excluded.ely_sig, first_seen_ms = excluded.first_seen_ms, genesis = excluded.genesis,
             role_checked_at = excluded.role_checked_at, next_check_at = excluded.next_check_at, status = 'active',
             linked_at = CASE WHEN bindings.elysium = excluded.elysium AND bindings.status = 'active' THEN bindings.linked_at ELSE excluded.linked_at END`,
        )
        .run({ ...b, key, genesis: b.genesis ? 1 : 0 });
    })();
  }

  bindingByElysium(elysium: Address): Binding | undefined {
    const r = this.#db.prepare<[string], BindingRow>("SELECT * FROM bindings WHERE elysium = ? AND status = 'active'").get(elysium);
    return r ? toBinding(r) : undefined;
  }

  insertCheck(hlKey: Hex, c: CheckRow): void {
    this.#db
      .prepare("INSERT INTO checks (hl_key, at, score_e8, tier, stamps) VALUES (?, ?, ?, ?, ?)")
      .run(hlKey.toLowerCase(), c.at, c.scoreE8, c.tier, c.stamps);
  }

  /** Checks for an hlKey, oldest first. */
  checks(hlKey: Hex): CheckRow[] {
    return this.#db
      .prepare<[string], { at: number; score_e8: number | bigint; tier: number; stamps: number }>(
        "SELECT at, score_e8, tier, stamps FROM checks WHERE hl_key = ? ORDER BY at, id",
      )
      .all(hlKey.toLowerCase())
      .map((r) => ({ at: r.at, scoreE8: BigInt(r.score_e8), tier: r.tier, stamps: r.stamps }));
  }

  insertAttestation(a: AttestationRow): number {
    return Number(
      this.#db
        .prepare(
          `INSERT INTO attestations (elysium, hl_key, tier, stamps, issued_at, expiry, deadline, sig, tx_hash, status)
           VALUES (@elysium, @hlKey, @tier, @stamps, @issuedAt, @expiry, @deadline, @sig, @txHash, @status)`,
        )
        .run({ ...a, hlKey: a.hlKey.toLowerCase() }).lastInsertRowid,
    );
  }

  setAttestationStatus(id: number, status: AttestationRow["status"], txHash: Hex | null = null): void {
    this.#db.prepare("UPDATE attestations SET status = ?, tx_hash = COALESCE(?, tx_hash) WHERE id = ?").run(status, txHash, id);
  }

  /** Highest issuedAt we ever signed for an account (the registry needs strictly newer ones). */
  lastIssuedAt(elysium: Address): number {
    const r = this.#db.prepare<[string], { m: number | null }>("SELECT MAX(issued_at) AS m FROM attestations WHERE elysium = ?").get(elysium);
    return r?.m ?? 0;
  }

  /** The latest signed attestation of every active binding (for /passport/stats). */
  latestPerActiveBinding(): Array<{ tier: number; stamps: number; expiry: number }> {
    return this.#db
      .prepare<[], { tier: number; stamps: number; expiry: number }>(
        `SELECT a.tier, a.stamps, a.expiry FROM bindings b
         JOIN attestations a ON a.id = (SELECT id FROM attestations x WHERE x.elysium = b.elysium AND x.hl_key = b.hl_key
                                        ORDER BY issued_at DESC, id DESC LIMIT 1)
         WHERE b.status = 'active'`,
      )
      .all();
  }

  activeBindingCount(): number {
    return this.#db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM bindings WHERE status = 'active'").get()!.n;
  }
}
