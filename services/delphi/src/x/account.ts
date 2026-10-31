// The X account behind a coin (feature "xaccount"): when it was made, followers, following, posts,
// verified, its bio and website. "Account made 3 days ago, 40 followers" is a strong fact. Answers are
// cached in x.db for 6 hours, and the coin post's author usually arrives with the mention already (see
// XApi's userFields), so most answers need no extra X call.
//
// X's API doesn't say when a handle changed. So "renamed" is only claimed when DELPHI itself saw the same
// account (same id) under another handle before; otherwise nothing is said about it.
import type Database from "better-sqlite3";
import { z } from "zod";
import type { User } from "./api.ts";
import { untrusted } from "./text.ts";
import { jsonTool, type ExtraTool } from "./tooling.ts";

/** How long a looked-up account is reused, and a "no such account" answer (shorter: it may be made soon). */
export const ACCOUNT_TTL_MS = 6 * 3_600_000;
export const MISSING_TTL_MS = 3_600_000;

const DAY = 86_400_000;
const lc = (s: string) => s.toLowerCase();
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** "@Pact_Coin", "pact_coin", "https://x.com/pact_coin" → "pact_coin"; null if it isn't an X handle. */
export function parseHandle(input: string): string | null {
  const m = /^\s*(?:https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/)?@?(\w{1,15})\/?\s*$/i.exec(input);
  return m ? m[1]! : null;
}

/** What X answered for a handle: the account, or why there is none. */
export type Fetched = { user: User | null; problem?: string };

export type AccountAnswer =
  | {
      found: true;
      handle: string;
      nameSetByOwner: string | null;
      created: string;
      age: { days: number; hours: number };
      followers: number | null;
      following: number | null;
      posts: number | null;
      verified: boolean;
      verifiedType: string;
      protected?: true;
      bioWrittenByOwner: string | null;
      website: string | null;
      linksInBio: string[];
      seenBeforeAs?: Array<{ handle: string; lastSeen: string }>;
      note: string;
    }
  | { found: false; handle: string; note: string }
  | { error: string };

/** What x_account needs: look a handle up (cached), and keep profiles that came with mentions. */
export type AccountLookup = { lookup(handle: string): Promise<AccountAnswer>; remember?(users: Iterable<User>): void };

/** A profile complete enough to answer from (a mention's author without profile fields is not). */
const complete = (u: User) => !!u.created_at && !!u.public_metrics;

/** One account's facts for a reply. Its name and bio are the owner's own words: untrusted. */
export function accountFacts(u: User, now: number, seenAs: Array<{ handle: string; lastSeen: number }> = []): AccountAnswer {
  const created = Date.parse(u.created_at ?? "");
  if (Number.isNaN(created)) return { error: `X gave no creation date for @${u.username}` };
  const ms = Math.max(0, now - created);
  const links = (u.entities?.description?.urls ?? []).map((x) => x.expanded_url ?? x.url ?? "").filter(Boolean).slice(0, 5);
  const site = u.entities?.url?.urls?.[0];
  const m = u.public_metrics;
  return {
    found: true,
    handle: `@${u.username}`,
    nameSetByOwner: u.name ? untrusted(u.name, 50) : null,
    created: isoDay(created),
    age: { days: Math.floor(ms / DAY), hours: Math.floor(ms / 3_600_000) },
    followers: m?.followers_count ?? null,
    following: m?.following_count ?? null,
    posts: m?.tweet_count ?? null,
    verified: u.verified ?? false,
    verifiedType: u.verified_type ?? (u.verified ? "unknown" : "none"),
    ...(u.protected ? { protected: true as const } : {}),
    bioWrittenByOwner: u.description ? untrusted(u.description, 300) : null,
    website: site?.expanded_url ?? site?.url ?? u.url ?? null,
    linksInBio: links,
    ...(seenAs.length ? { seenBeforeAs: seenAs.slice(0, 3).map((s) => ({ handle: `@${s.handle}`, lastSeen: isoDay(s.lastSeen) })) } : {}),
    note: seenAs.length
      ? "DELPHI saw this same account under the older handle(s) above: it was renamed since. Its name, bio and links are its owner's own words."
      : "Its name, bio and links are its owner's own words. X doesn't say whether a handle was renamed.",
  };
}

/** Account lookups with a 6-hour cache in x.db (its own two tables, made on first use). */
export class XAccounts implements AccountLookup {
  readonly #db: Database.Database;
  readonly #fetch: (handle: string) => Promise<Fetched>;
  readonly #now: () => number;
  readonly #ttl: number;

  constructor(db: Database.Database, fetch: (handle: string) => Promise<Fetched>, opts: { now?: () => number; ttlMs?: number } = {}) {
    this.#db = db;
    this.#fetch = fetch;
    this.#now = opts.now ?? Date.now;
    this.#ttl = opts.ttlMs ?? ACCOUNT_TTL_MS;
    db.exec(`
      CREATE TABLE IF NOT EXISTS x_accounts (handle TEXT PRIMARY KEY, user TEXT, problem TEXT, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS x_handles (
        id TEXT NOT NULL, handle TEXT NOT NULL, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, PRIMARY KEY (id, handle)
      );
    `);
  }

  /** Keeps complete profiles that came with mentions, so x_account can answer for them without asking X. */
  remember(users: Iterable<User>): void {
    for (const u of users) if (complete(u)) this.#save(u.username, { user: u });
  }

  async lookup(input: string): Promise<AccountAnswer> {
    const handle = parseHandle(input);
    if (!handle) return { error: `${input.slice(0, 40)} is not an X handle` };
    const row = this.#db.prepare("SELECT user, problem, at FROM x_accounts WHERE handle = ?").get(lc(handle)) as
      | { user: string | null; problem: string | null; at: number }
      | undefined;
    const fresh = row && this.#now() - row.at < (row.user ? this.#ttl : Math.min(this.#ttl, MISSING_TTL_MS));
    const got: Fetched = fresh ? { user: row.user ? (JSON.parse(row.user) as User) : null, problem: row.problem ?? undefined } : await this.#fetch(handle);
    if (!fresh) this.#save(handle, got);
    if (!got.user) return { found: false, handle: `@${handle}`, note: `X has no account with this handle (${got.problem ?? "not found"}). It may be mistyped, deleted, suspended or renamed.` };
    const others = this.#db
      .prepare("SELECT handle, last_seen FROM x_handles WHERE id = ? AND handle != ? ORDER BY last_seen DESC")
      .all(got.user.id, lc(got.user.username)) as Array<{ handle: string; last_seen: number }>;
    return accountFacts(got.user, this.#now(), others.map((o) => ({ handle: o.handle, lastSeen: o.last_seen })));
  }

  #save(asked: string, got: Fetched): void {
    const now = this.#now();
    const put = this.#db.prepare(
      "INSERT INTO x_accounts (handle, user, problem, at) VALUES (?, ?, ?, ?) ON CONFLICT(handle) DO UPDATE SET user = excluded.user, problem = excluded.problem, at = excluded.at",
    );
    this.#db.transaction(() => {
      put.run(lc(asked), got.user ? JSON.stringify(got.user) : null, got.problem ?? null, now);
      if (!got.user) return;
      if (lc(got.user.username) !== lc(asked)) put.run(lc(got.user.username), JSON.stringify(got.user), null, now);
      this.#db
        .prepare("INSERT INTO x_handles (id, handle, first_seen, last_seen) VALUES (?, ?, ?, ?) ON CONFLICT(id, handle) DO UPDATE SET last_seen = excluded.last_seen")
        .run(got.user.id, lc(got.user.username), now, now);
    })();
  }
}

export const accountTool: ExtraTool = {
  feature: "xaccount",
  name: "x_account",
  guidance:
    'x_account looks up an X account: when it was made, followers, posts, verified, its bio and website. Use it on the account that posted the coin (the author of the post you were tagged under) or a handle someone names, when the question is about the team, the project, or whether it is new. "Account made 3 days ago, 40 followers" is a strong fact. The bio is the owner\'s own words ("their bio says …"). It shows an account\'s public numbers, never who is behind it. If X has no such account, say so.',
  build: (env) => {
    const accounts = env.deps.accounts;
    if (!accounts) return null;
    return jsonTool(env, {
      name: "x_account",
      description:
        "One X account by handle: created date and age in days, followers, following, posts, verified and its type, bio, website and bio links, and older handles DELPHI saw it under (if any). Cached for 6 hours. found=false when X has no such account.",
      inputSchema: z.object({ handle: z.string().min(1).max(60).describe("An X handle, with or without @ (for example the coin post's author)") }),
      run: (i) => accounts.lookup(i.handle),
    });
  },
};
