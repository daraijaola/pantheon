// The one file the website reads (out/site.json): every coin's verdict, plus the full report and
// Claude's explanation for the coins that have one. Names are cleaned here; the site adds nothing.
import { RULES } from "../config.ts";
import type { CoinReport } from "../report.ts";
import type { Verdict } from "../types.ts";
import { explanationKey, type Explained } from "./explain.ts";

/**
 * What the site shows about a Kalos coin beyond its checks: who holds it and its pools' liquidity.
 * Shares are of the total supply; HYPE values are plain numbers.
 */
export type KalosExtras = {
  creatorPct: number;
  top5Pct: number;
  /** Read in two windows (at launch and recently), not its whole life. */
  windowed: boolean;
  pools: number;
  tvlHype: number | null;
  lpOwners: number;
  /** Removals of 20% or more of a pool's liquidity. */
  bigRemovals: number;
  /** Set when the contract and market checks ran (src/safety.ts). */
  safety?: unknown;
};

/** What explain.ts saves per coin. Older files carry no report: their key tells whether today's report is the same data. */
export type Saved = Explained & { report?: CoinReport };

const ORDER: Record<Verdict, number> = { FLAG: 0, WATCH: 1, CLEAN: 2, NOT_ENOUGH_DATA: 3 };
const clean = (s: string | null) => (s ? [...s.replace(/[\p{Cc}\p{Cf}]/gu, "")].slice(0, 40).join("") || null : null);

export function siteBundle(input: {
  reports: CoinReport[];
  saved: Saved[];
  explorerWeb: string;
  head: string;
  /** Per coin (lowercase token): wallets that touched it, and the people behind them (graph.ts peopleOf). */
  people?: ReadonlyMap<string, { wallets: number; people: number }>;
  /** Kalos coins' holders and liquidity (lowercase token). Kalos coins are listed apart from Ascend's. */
  kalos?: ReadonlyMap<string, KalosExtras>;
  now?: Date;
}) {
  const current = new Map(input.reports.map((r) => [r.coin.token.toLowerCase(), r]));
  const explained = new Map<string, { report: CoinReport; x: Saved }>();
  for (const x of input.saved) {
    const now = current.get(x.token.toLowerCase());
    // Show an explanation only next to the exact data it explained.
    const report = now && explanationKey(now) === x.key ? now : x.report;
    if (report) explained.set(x.token.toLowerCase(), { report, x });
  }
  const ascend = input.reports.filter((r) => r.coin.market !== "kalos");
  const onKalos = input.reports.filter((r) => r.coin.market === "kalos");
  const sort = (rs: CoinReport[]) => [...rs].sort((a, b) => ORDER[a.verdict] - ORDER[b.verdict] || b.stats.trades - a.stats.trades);
  const sorted = sort(ascend);
  const countIn = (rs: CoinReport[]) => {
    const n = (v: Verdict) => rs.filter((r) => r.verdict === v).length;
    return { coins: rs.length, FLAG: n("FLAG"), WATCH: n("WATCH"), CLEAN: n("CLEAN"), NOT_ENOUGH_DATA: n("NOT_ENOUGH_DATA") };
  };
  const row = (r: CoinReport) => {
    const e = explained.get(r.coin.token.toLowerCase());
    return {
      token: r.coin.token,
      symbol: clean(r.coin.symbol),
      name: clean(r.coin.name),
      verdict: r.verdict,
      trades: r.stats.trades,
      wallets: r.stats.traders,
      holders: r.stats.holders,
      ...(input.people?.has(r.coin.token.toLowerCase()) ? { people: input.people.get(r.coin.token.toLowerCase())! } : {}),
      launched: r.coin.launchTime,
      ...(e ? { headline: e.x.explanation.headline } : {}),
    };
  };
  const scannedAt = input.reports.map((r) => r.generatedAt).sort().at(-1) ?? null;
  return {
    generatedAt: (input.now ?? new Date()).toISOString(),
    scannedAt,
    head: input.head,
    explorer: input.explorerWeb.replace(/\/$/, ""),
    rules: RULES,
    counts: countIn(ascend),
    coins: sorted.map(row),
    ...(onKalos.length
      ? {
          kalos: {
            counts: countIn(onKalos),
            coins: sort(onKalos).map((r) => ({
              ...row(r),
              findings: r.findings.map((f) => ({ detector: f.detector, severity: f.severity, summary: f.summary })),
              ...(input.kalos?.get(r.coin.token.toLowerCase()) ?? {}),
            })),
          },
        }
      : {}),
    explained: Object.fromEntries(
      [...explained].map(([token, { report, x }]) => [
        token,
        {
          report: { ...report, coin: { ...report.coin, name: clean(report.coin.name), symbol: clean(report.coin.symbol) } },
          explanation: x.explanation,
          model: x.model,
          writtenAt: x.generatedAt,
        },
      ]),
    ),
  };
}

export type SiteBundle = ReturnType<typeof siteBundle>;
