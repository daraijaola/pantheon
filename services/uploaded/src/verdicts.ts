// What DELPHI last said about every coin, held in memory so a lookup never touches the disk. DELPHI's
// scan rewrites its results file in place, so a read can catch it half-written: a file that doesn't
// load changes nothing, and the last good copy keeps answering. A coin DELPHI hasn't read comes back
// UNKNOWN, never CLEAN. A fresh read (see fresh.ts) sits on top of the scan until a newer scan arrives.
// The written explanations are left out on purpose: they can be older than the verdicts (17 of 33 on Nov 1).
import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
import type { Sale, Seen } from "./guard.ts";

const SITE = "https://pantheonindex.com";
/** The scan runs twice a day and can take an hour or two: past this, say the verdicts are old. */
const MAX_AGE_MS = 14 * 3_600_000;

const Evidence = z.object({ what: z.string(), tx: z.string(), url: z.string() });
const Finding = z.object({
  detector: z.string(),
  severity: z.enum(["flag", "watch"]),
  summary: z.string(),
  evidence: z.array(Evidence),
});
const Report = z.object({
  /** The version of DELPHI's rules this verdict came from. */
  rules: z.string().optional(),
  coin: z.object({
    token: z.string(),
    name: z.string().nullable(),
    symbol: z.string().nullable(),
    creator: z.string(),
    launchTime: z.string(),
    /** Set only for coins outside Ascend. */
    market: z.enum(["kalos", "perpme"]).optional(),
  }),
  stats: z.object({ trades: z.number(), holders: z.number() }),
  verdict: z.enum(["FLAG", "WATCH", "CLEAN", "NOT_ENOUGH_DATA"]),
  notes: z.array(z.string()),
  checks: z.record(z.string(), z.string()),
  findings: z.array(Finding),
});
const Scan = z.object({
  network: z.enum(["testnet", "mainnet"]),
  generatedAt: z.iso.datetime(),
  reports: z.array(Report),
  /** Sales by creators' groups. Fresh reads have these; the scan doesn't. */
  creatorSells: z.array(z.object({ token: z.string(), wallet: z.string(), ppm: z.number(), tx: z.string(), url: z.string(), time: z.number() })).optional(),
  /** Each coin's last price of each UTC day: [day number, price]. Fresh reads have these too. */
  dailyPrices: z.record(z.string(), z.array(z.tuple([z.number(), z.number()]))).optional(),
});
type Report = z.infer<typeof Report>;

export type Venue = "ascend" | "kalos" | "perpme";
export type Coin = { token: string; symbol: string | null; name: string | null; venue: Venue };

export type CoinVerdict = {
  known: true;
  token: string;
  symbol: string | null;
  name: string | null;
  creator: string;
  launched: string;
  venue: Venue;
  network: "testnet" | "mainnet";
  verdict: Report["verdict"];
  /** One line: the worst finding, or why there's no judgement yet. */
  reason: string;
  /** Context that isn't a finding, e.g. what the creator's wallet holds. */
  notes: string[];
  /** Every claim, each with the transactions behind it. */
  findings: Array<{ kind: string; severity: "flag" | "watch"; text: string; evidence: Array<{ what: string; tx: string; url: string }> }>;
  checks: Record<string, string>;
  trades: number;
  holders: number;
  reportUrl: string;
  disputeUrl: string;
  scannedAt: string;
  /** True when the scan is older than it should be: show less, not more. */
  stale: boolean;
};

export type UnknownCoin = { known: false; token: string; verdict: "UNKNOWN"; reason: string };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The one line shown next to a coin. CLEAN says "so far": it never means safe. */
export function reasonOf(r: Pick<Report, "verdict" | "findings" | "notes" | "stats">): string {
  const worst = r.findings.find((f) => f.severity === "flag") ?? r.findings.find((f) => f.severity === "watch");
  if (worst) return worst.summary;
  if (r.verdict === "NOT_ENOUGH_DATA") return `Not enough data yet: ${plural(r.stats.trades, "trade")}, ${plural(r.stats.holders, "holder")}.`;
  if (r.verdict === "CLEAN") return "Clean so far: every check passed.";
  return r.notes[0] ?? "See DELPHI's report on this coin.";
}

type Loaded = { network: "testnet" | "mainnet"; scannedAt: string; scannedMs: number; coins: Map<string, Report>; sales: Sale[]; prices: Record<string, Array<[number, number]>> };

function parse(json: string): Loaded {
  const scan = Scan.parse(JSON.parse(json));
  return {
    network: scan.network,
    scannedAt: scan.generatedAt,
    scannedMs: Date.parse(scan.generatedAt),
    coins: new Map(scan.reports.map((r) => [r.coin.token.toLowerCase(), r])),
    sales: scan.creatorSells ?? [],
    prices: scan.dailyPrices ?? {},
  };
}

export class Verdicts {
  readonly #file: string;
  readonly #now: () => number;
  readonly #maxAgeMs: number;
  #loaded: Loaded | null = null;
  /** The latest fresh read, while it's newer than the scan. */
  #fresh: Loaded | null = null;
  /** Which version of the file is loaded, so an unchanged file is never re-read. */
  #seen: string | null = null;
  #error: string | null = null;

  constructor(file: string, opts: { now?: () => number; maxAgeMs?: number } = {}) {
    this.#file = file;
    this.#now = opts.now ?? Date.now;
    this.#maxAgeMs = opts.maxAgeMs ?? MAX_AGE_MS;
  }

  /** Loads the file if it changed. True when new verdicts came in; any failure keeps the last good copy. */
  refresh(): boolean {
    try {
      const st = statSync(this.#file);
      const version = `${st.mtimeMs}:${st.size}`;
      if (version === this.#seen) return false;
      this.#loaded = parse(readFileSync(this.#file, "utf8"));
      if (this.#fresh && this.#fresh.scannedMs <= this.#loaded.scannedMs) this.#fresh = null;
      this.#seen = version;
      this.#error = null;
      return true;
    } catch (err) {
      this.#error = (err instanceof Error ? err.message : String(err)).split("\n")[0]!.slice(0, 200);
      return false;
    }
  }

  /** Puts a fresh read on top of the scan. False if it's no newer than what's held. Throws on a bad read. */
  applyFresh(json: string): boolean {
    const fresh = parse(json);
    if (fresh.scannedMs <= Math.max(this.#loaded?.scannedMs ?? 0, this.#fresh?.scannedMs ?? 0)) return false;
    this.#fresh = fresh;
    return true;
  }

  get(token: string): CoinVerdict | UnknownCoin {
    const key = token.toLowerCase();
    const from = this.#fresh?.coins.has(key) ? this.#fresh : this.#loaded;
    const r = from?.coins.get(key);
    if (!from || !r) return { known: false, token: key, verdict: "UNKNOWN", reason: "DELPHI hasn't read this coin yet." };
    return {
      known: true,
      token: key,
      symbol: r.coin.symbol,
      name: r.coin.name,
      creator: r.coin.creator.toLowerCase(),
      launched: r.coin.launchTime,
      venue: r.coin.market ?? "ascend",
      network: from.network,
      verdict: r.verdict,
      reason: reasonOf(r),
      notes: r.notes,
      findings: r.findings.map((f) => ({ kind: f.detector, severity: f.severity, text: f.summary, evidence: f.evidence })),
      checks: r.checks,
      trades: r.stats.trades,
      holders: r.stats.holders,
      reportUrl: `${SITE}/delphi/${key}`,
      disputeUrl: `${SITE}/delphi/dispute?token=${key}`,
      scannedAt: from.scannedAt,
      stale: this.#stale(from),
    };
  }

  /** Every coin as DELPHI sees it now, for Guard. */
  seen(): Seen[] {
    const all = new Map([...(this.#loaded?.coins ?? []), ...(this.#fresh?.coins ?? [])]);
    return [...all.keys()].flatMap((t) => {
      const s = this.seenOne(t);
      return s ? [s] : [];
    });
  }

  seenOne(token: string): Seen | null {
    const key = token.toLowerCase();
    const r = (this.#fresh?.coins.has(key) ? this.#fresh : this.#loaded)?.coins.get(key);
    const c = this.get(key);
    if (!r || !c.known) return null;
    return {
      token: key,
      symbol: c.symbol,
      venue: c.venue,
      verdict: c.verdict,
      rules: r.rules ?? null,
      reason: c.reason,
      evidence: c.findings.flatMap((f) => f.evidence),
      reportUrl: c.reportUrl,
      disputeUrl: c.disputeUrl,
    };
  }

  /**
   * How a coin's price moved since a moment, in percent, one decimal, from the latest fresh read. Null if
   * it's unknown: no fresh read yet, or no trade by that moment to compare with. Days with no trade carry
   * the last price forward, so this is a change in the last traded price, which can be old on a quiet coin.
   */
  priceChange(token: string, sinceSec: number): number | null {
    const days = this.#fresh?.prices[token.toLowerCase()];
    if (!days?.length) return null;
    const day = Math.floor(sinceSec / 86_400);
    const before = days.filter(([d]) => d <= day).at(-1);
    if (!before || before[1] <= 0) return null;
    return Math.round((days.at(-1)![1] / before[1] - 1) * 1_000) / 10;
  }

  /** Sales by creators' groups, from the latest fresh read. */
  sales(): Sale[] {
    return this.#fresh?.sales ?? [];
  }

  /** The coins this wallet launched, as DELPHI's scan names their creators. */
  launchedBy(wallet: string): CoinVerdict[] {
    const who = wallet.toLowerCase();
    const all = new Map([...(this.#loaded?.coins ?? []), ...(this.#fresh?.coins ?? [])]);
    return [...all].filter(([, r]) => r.coin.creator.toLowerCase() === who).map(([token]) => this.get(token) as CoinVerdict);
  }

  /** Every coin DELPHI has read, and which network they're on. Null until the first scan is loaded. */
  coins(): { network: "testnet" | "mainnet"; coins: Coin[] } | null {
    if (!this.#loaded) return null;
    const all = new Map(this.#loaded.coins);
    for (const [k, r] of this.#fresh?.coins ?? []) all.set(k, r);
    return { network: this.#loaded.network, coins: [...all].map(([token, r]) => ({ token, symbol: r.coin.symbol, name: r.coin.name, venue: r.coin.market ?? "ascend" })) };
  }

  health() {
    const l = this.#loaded;
    return {
      ready: !!l,
      coins: l?.coins.size ?? 0,
      network: l?.network ?? null,
      scannedAt: l?.scannedAt ?? null,
      freshAt: this.#fresh?.scannedAt ?? null,
      stale: l ? this.#stale(l) : null,
      lastError: this.#error,
    };
  }

  #stale(l: Loaded) {
    return this.#now() - l.scannedMs > this.#maxAgeMs;
  }
}
