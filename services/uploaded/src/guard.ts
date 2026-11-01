// Guard: it watches the coins a wallet holds and speaks only when a coin drops from CLEAN to WATCH or FLAG,
// or its creator's group sells. Otherwise it stays silent, so an empty list is the normal answer. DELPHI
// keeps only the latest verdict, so Guard remembers what each coin's verdict was, in its own file, which
// survives a restart. How alerts reach people (web, Telegram) is still undecided, so this only keeps the list.
// - A rules change isn't news about a coin: if DELPHI's rules changed, a new verdict alerts nobody.
// - Guard says nothing about what it hasn't watched: the first read only sets the starting point, and
//   sales older than 2 days are history.
// - 1% of supply in a day: on Nov 1 every coin-day of creator-group sales was either under 0.5% or over 1%.
//   Sales are only seen on Ascend, because a fresh read covers Ascend only.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { Holdings, HoldingsReader } from "./holdings.ts";
import type { Venue } from "./verdicts.ts";

const DAY_SEC = 86_400;
const MIN_SOLD_PPM = 10_000;
const RECENT_SALE_SEC = 2 * DAY_SEC;
const KEEP_DAYS = 30;
const MAX_ALERTS = 5_000;
const MAX_EVIDENCE = 5;
/** How far back a wallet's list goes unless it asks otherwise. */
const DEFAULT_WINDOW_MS = 7 * DAY_SEC * 1000;

const Evidence = z.object({ what: z.string(), tx: z.string(), url: z.string() });
const Alert = z.object({
  id: z.string(),
  kind: z.enum(["verdict-drop", "creator-sold"]),
  token: z.string(),
  symbol: z.string().nullable(),
  venue: z.enum(["ascend", "kalos", "perpme"]),
  /** When Guard noticed. */
  at: z.string(),
  from: z.string().optional(),
  to: z.string().optional(),
  /** One line, for the screen. */
  reason: z.string(),
  /** Share of the supply sold that day, in percent. */
  soldPct: z.number().optional(),
  evidence: z.array(Evidence),
  reportUrl: z.string(),
  disputeUrl: z.string(),
});
export type Alert = z.infer<typeof Alert>;

const Saved = z.object({
  since: z.string(),
  verdicts: z.record(z.string(), z.object({ verdict: z.string(), rules: z.string().nullable() })),
  alerts: z.array(Alert),
});

/** One coin as DELPHI sees it now. */
export type Seen = {
  token: string;
  symbol: string | null;
  venue: Venue;
  verdict: string;
  rules: string | null;
  reason: string;
  evidence: Array<{ what: string; tx: string; url: string }>;
  reportUrl: string;
  disputeUrl: string;
};

/** One sale by a creator's group. `ppm`: millionths of the supply. */
export type Sale = { token: string; wallet: string; ppm: number; tx: string; url: string; time: number };

export class Guard {
  readonly #file: string;
  readonly #now: () => number;
  readonly #log: (msg: string) => void;
  #since: string;
  #verdicts = new Map<string, { verdict: string; rules: string | null }>();
  #alerts: Alert[] = [];

  constructor(file: string, opts: { now?: () => number; log?: (msg: string) => void } = {}) {
    this.#file = file;
    this.#now = opts.now ?? Date.now;
    this.#log = opts.log ?? (() => {});
    this.#since = new Date(this.#now()).toISOString();
    this.#load();
  }

  #load() {
    let text: string;
    try {
      text = readFileSync(this.#file, "utf8");
    } catch {
      return; // first run
    }
    try {
      const s = Saved.parse(JSON.parse(text));
      this.#since = s.since;
      this.#verdicts = new Map(Object.entries(s.verdicts));
      this.#alerts = s.alerts;
    } catch (err) {
      // Keep the bad file for a person to look at, and start over rather than guess.
      this.#log(`guard file unusable, starting over: ${(err as Error).message.split("\n")[0]}`);
      try {
        renameSync(this.#file, `${this.#file}.bad`);
      } catch {
        // nothing more to do
      }
    }
  }

  #save() {
    mkdirSync(dirname(this.#file), { recursive: true });
    const tmp = `${this.#file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ since: this.#since, verdicts: Object.fromEntries(this.#verdicts), alerts: this.#alerts }));
    renameSync(tmp, this.#file); // never half-written
  }

  #trim() {
    const oldest = this.#now() - KEEP_DAYS * DAY_SEC * 1000;
    this.#alerts = this.#alerts.filter((a) => Date.parse(a.at) >= oldest).slice(-MAX_ALERTS);
  }

  /** New verdicts have arrived. A coin seen for the first time sets its starting point and alerts no one. */
  observe(coins: readonly Seen[]): number {
    let added = 0;
    let changed = false;
    const at = new Date(this.#now()).toISOString();
    for (const c of coins) {
      const was = this.#verdicts.get(c.token);
      if (was?.verdict === c.verdict && was.rules === c.rules) continue;
      changed = true;
      this.#verdicts.set(c.token, { verdict: c.verdict, rules: c.rules });
      if (!was || was.verdict !== "CLEAN" || (c.verdict !== "WATCH" && c.verdict !== "FLAG")) continue;
      if (was.rules !== c.rules) {
        this.#log(`${c.token}: ${was.verdict} to ${c.verdict} after a rules change, no alert`);
        continue;
      }
      this.#alerts.push({
        id: `drop:${c.token}:${at}`,
        kind: "verdict-drop",
        token: c.token,
        symbol: c.symbol,
        venue: c.venue,
        at,
        from: was.verdict,
        to: c.verdict,
        reason: c.reason,
        evidence: c.evidence.slice(0, MAX_EVIDENCE),
        reportUrl: c.reportUrl,
        disputeUrl: c.disputeUrl,
      });
      added += 1;
    }
    if (changed) {
      this.#trim();
      this.#save();
    }
    return added;
  }

  /** Sales seen in a fresh read. Each coin-day over the line is one alert, which grows if more is sold that day. */
  observeSales(sales: readonly Sale[], coinOf: (token: string) => Seen | null): number {
    const cutoff = this.#now() / 1000 - RECENT_SALE_SEC;
    const days = new Map<string, Sale[]>();
    for (const s of sales) {
      if (s.time < cutoff) continue;
      const key = `${s.token}:${Math.floor(s.time / DAY_SEC)}`;
      days.set(key, [...(days.get(key) ?? []), s]);
    }
    let added = 0;
    let changed = false;
    for (const [key, list] of days) {
      const ppm = list.reduce((a, s) => a + s.ppm, 0);
      if (ppm < MIN_SOLD_PPM) continue;
      const id = `sold:${key}`;
      const coin = coinOf(list[0]!.token);
      if (!coin) continue;
      const soldPct = ppm / 10_000;
      const old = this.#alerts.find((a) => a.id === id);
      if (old?.soldPct === soldPct) continue;
      changed = true;
      const wallets = new Set(list.map((s) => s.wallet)).size;
      const evidence = [...list].sort((a, b) => b.ppm - a.ppm).slice(0, MAX_EVIDENCE).map((s) => ({ what: `${s.wallet.slice(0, 6)}…${s.wallet.slice(-4)} sold ${s.ppm / 10_000}% of the supply`, tx: s.tx, url: s.url }));
      const fields = { soldPct, evidence, reason: `The creator's group sold ${soldPct}% of the supply${wallets > 1 ? ` across ${wallets} wallets` : ""}.` };
      if (old) Object.assign(old, fields);
      else {
        this.#alerts.push({ id, kind: "creator-sold", token: coin.token, symbol: coin.symbol, venue: coin.venue, at: new Date(this.#now()).toISOString(), reportUrl: coin.reportUrl, disputeUrl: coin.disputeUrl, ...fields });
        added += 1;
      }
    }
    if (changed) {
      this.#trim();
      this.#save();
    }
    return added;
  }

  /** When Guard started watching. It can't speak for anything before this. */
  get since() {
    return this.#since;
  }

  for(tokens: ReadonlySet<string>, sinceMs: number): Alert[] {
    return this.#alerts.filter((a) => tokens.has(a.token) && Date.parse(a.at) >= sinceMs).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  }
}

export type WalletGuard = {
  wallet: string;
  network: Holdings["network"];
  readAt: string;
  /** Newest first. Empty is the normal answer. */
  alerts: Alert[];
  coinsWatched: number;
  /** When Guard started watching: it can't speak for anything earlier. */
  watchingSince: string;
  /** Markets where creator sales are seen. */
  salesSeenOn: Venue[];
  /** Coins that couldn't be read, so an alert on them could be missing. */
  unread: string[];
  /** False if a coin couldn't be read, so this list could be missing something. */
  complete: boolean;
};

export class GuardReader {
  readonly #guard: Pick<Guard, "for" | "since">;
  readonly #holdings: Pick<HoldingsReader, "read">;
  readonly #now: () => number;

  constructor(guard: Pick<Guard, "for" | "since">, holdings: Pick<HoldingsReader, "read">, opts: { now?: () => number } = {}) {
    this.#guard = guard;
    this.#holdings = holdings;
    this.#now = opts.now ?? Date.now;
  }

  async read(wallet: string, sinceMs?: number): Promise<WalletGuard> {
    const h = await this.#holdings.read(wallet);
    const held = new Set(h.holdings.map((c) => c.token));
    return {
      wallet: h.wallet,
      network: h.network,
      readAt: h.readAt,
      alerts: this.#guard.for(held, sinceMs ?? this.#now() - DEFAULT_WINDOW_MS),
      coinsWatched: held.size,
      watchingSince: this.#guard.since,
      salesSeenOn: ["ascend"],
      unread: h.unread,
      complete: h.unread.length === 0,
    };
  }
}
