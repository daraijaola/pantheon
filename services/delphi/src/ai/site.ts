// The one file the website reads (out/site.json): every coin's verdict, plus the full report and
// Claude's explanation for the coins that have one. Names are cleaned here; the site adds nothing.
import { RULES } from "../config.ts";
import type { CoinReport } from "../report.ts";
import type { Verdict } from "../types.ts";
import { explanationKey, type Explained } from "./explain.ts";

/** What explain.ts saves per coin. Older files carry no report: their key tells whether today's report is the same data. */
export type Saved = Explained & { report?: CoinReport };

const ORDER: Record<Verdict, number> = { FLAG: 0, WATCH: 1, CLEAN: 2, NOT_ENOUGH_DATA: 3 };
const clean = (s: string | null) => (s ? [...s.replace(/[\p{Cc}\p{Cf}]/gu, "")].slice(0, 40).join("") || null : null);

export function siteBundle(input: { reports: CoinReport[]; saved: Saved[]; explorerWeb: string; head: string; now?: Date }) {
  const current = new Map(input.reports.map((r) => [r.coin.token.toLowerCase(), r]));
  const explained = new Map<string, { report: CoinReport; x: Saved }>();
  for (const x of input.saved) {
    const now = current.get(x.token.toLowerCase());
    // Show an explanation only next to the exact data it explained.
    const report = now && explanationKey(now) === x.key ? now : x.report;
    if (report) explained.set(x.token.toLowerCase(), { report, x });
  }
  const sorted = [...input.reports].sort((a, b) => ORDER[a.verdict] - ORDER[b.verdict] || b.stats.trades - a.stats.trades);
  const count = (v: Verdict) => input.reports.filter((r) => r.verdict === v).length;
  const scannedAt = input.reports.map((r) => r.generatedAt).sort().at(-1) ?? null;
  return {
    generatedAt: (input.now ?? new Date()).toISOString(),
    scannedAt,
    head: input.head,
    explorer: input.explorerWeb.replace(/\/$/, ""),
    rules: RULES,
    counts: { coins: input.reports.length, FLAG: count("FLAG"), WATCH: count("WATCH"), CLEAN: count("CLEAN"), NOT_ENOUGH_DATA: count("NOT_ENOUGH_DATA") },
    coins: sorted.map((r) => {
      const e = explained.get(r.coin.token.toLowerCase());
      return {
        token: r.coin.token,
        symbol: clean(r.coin.symbol),
        name: clean(r.coin.name),
        verdict: r.verdict,
        trades: r.stats.trades,
        wallets: r.stats.traders,
        holders: r.stats.holders,
        launched: r.coin.launchTime,
        ...(e ? { headline: e.x.explanation.headline } : {}),
      };
    }),
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
