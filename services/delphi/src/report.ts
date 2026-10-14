// Verdicts and reports. A report says what was checked, what was found, and the transactions
// behind every claim, so anyone can verify it on the explorer without trusting DELPHI.
import { RULES } from "./config.ts";
import { balances, detectBundle, detectConcentration, detectWash, type DetectorResult } from "./detect.ts";
import type { CoinData, Finding, Verdict } from "./types.ts";

export type CheckState = "found" | "clear" | "not-enough-data";
export type Detector = Finding["detector"];

export type CoinReport = {
  rules: string;
  generatedAt: string;
  coin: {
    token: string;
    name: string | null;
    symbol: string | null;
    poolId: string;
    creator: string;
    launchTx: string;
    launchBlock: string;
    launchTime: string;
    url: string;
    launchUrl: string;
  };
  stats: { trades: number; traders: number; holders: number; links: number; fundingMissing: number };
  verdict: Verdict;
  /** What limits this report (missing data), in plain words. */
  notes: string[];
  checks: Record<Detector, CheckState>;
  findings: Array<Finding & { evidence: Array<{ what: string; tx: string; url: string }> }>;
};

const DETECTORS: Array<[Detector, (d: CoinData) => DetectorResult]> = [
  ["bundle", detectBundle],
  ["wash", detectWash],
  ["concentration", detectConcentration],
];

/** FLAG or WATCH if anything was found; CLEAN only if every check had enough data to say so. */
export function verdictOf(results: DetectorResult[]): Verdict {
  const found = results.flatMap((r) => (r.finding ? [r.finding.severity] : []));
  if (found.includes("flag")) return "FLAG";
  if (found.includes("watch")) return "WATCH";
  return results.every((r) => r.enough) ? "CLEAN" : "NOT_ENOUGH_DATA";
}

export function analyze(d: CoinData, opts: { explorerWeb: string; now?: Date }): CoinReport {
  const web = opts.explorerWeb.replace(/\/$/, "");
  const results = DETECTORS.map(([name, run]) => [name, run(d)] as const);
  const checks = Object.fromEntries(
    results.map(([name, r]) => [name, r.finding ? "found" : r.enough ? "clear" : "not-enough-data"]),
  ) as Record<Detector, CheckState>;
  const c = d.coin;
  let verdict = verdictOf(results.map(([, r]) => r));
  const notes: string[] = [];
  if (d.fundingMissing > 0) {
    notes.push(`Funding history missing for ${d.fundingMissing} wallet(s): links through shared funders may be incomplete.`);
    // Nothing found is not the same as clean when part of the picture is missing.
    if (verdict === "CLEAN") verdict = "NOT_ENOUGH_DATA";
  }
  return {
    rules: RULES.version,
    generatedAt: (opts.now ?? new Date()).toISOString(),
    coin: {
      token: c.token,
      name: c.name,
      symbol: c.symbol,
      poolId: c.poolId,
      creator: c.creator,
      launchTx: c.launchTx,
      launchBlock: c.launchBlock.toString(),
      launchTime: new Date(c.launchTime * 1000).toISOString(),
      url: `${web}/token/${c.token}`,
      launchUrl: `${web}/tx/${c.launchTx}`,
    },
    stats: {
      trades: d.trades.length,
      traders: new Set(d.trades.map((t) => t.trader.toLowerCase())).size,
      holders: balances(d).size,
      links: d.links.length,
      fundingMissing: d.fundingMissing,
    },
    verdict,
    notes,
    checks,
    findings: results
      .flatMap(([, r]) => (r.finding ? [r.finding] : []))
      .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "flag" ? -1 : 1))
      .map((f) => ({ ...f, evidence: f.evidence.map((e) => ({ ...e, url: `${web}/tx/${e.tx}` })) })),
  };
}

/**
 * On-chain names are chosen by whoever launched the coin: treat them as hostile. Strip control
 * characters, escape everything markdown or HTML could act on, and cap the length.
 */
export function mdText(s: string | null, max = 40): string {
  if (!s) return "?";
  const clean = [...s.replace(/[\p{Cc}\p{Cf}]/gu, "")].slice(0, max).join("");
  return clean.replace(/[\\`*_{}[\]()<>#+\-.!|~&"']/g, (ch) => `\\${ch}`) || "?";
}

const LABEL: Record<Detector, string> = {
  bundle: "Launch bundle",
  wash: "Wash trading",
  concentration: "Hidden concentration",
};
const STATE: Record<CheckState, string> = { found: "found", clear: "clear", "not-enough-data": "not enough data" };

export function toMarkdown(r: CoinReport): string {
  const c = r.coin;
  const lines = [
    `# ${mdText(c.symbol, 16)}: ${r.verdict.replaceAll("_", " ")}`,
    "",
    `${mdText(c.name)} · [${c.token}](${c.url}) · launched ${c.launchTime} in [this transaction](${c.launchUrl})`,
    "",
    `${r.stats.trades} trades by ${r.stats.traders} wallets · ${r.stats.holders} holders · ${r.stats.links} wallet links found`,
    "",
    "| Check | Result |",
    "| --- | --- |",
    ...(Object.keys(LABEL) as Detector[]).map((k) => `| ${LABEL[k]} | ${STATE[r.checks[k]]} |`),
    "",
    ...r.notes.flatMap((n) => [`> ${n}`, ""]),
  ];
  for (const f of r.findings) {
    lines.push(`## ${LABEL[f.detector]} (${f.severity})`, "", f.summary, "");
    for (const e of f.evidence) lines.push(`- ${e.what}: [${e.tx.slice(0, 10)}…](${e.url})`);
    lines.push("");
  }
  lines.push(
    `_DELPHI ${r.rules}, ${r.generatedAt}. It reports on-chain patterns, not intent: check every claim against the linked transactions._`,
    "",
  );
  return lines.join("\n");
}

const ORDER: Record<Verdict, number> = { FLAG: 0, WATCH: 1, CLEAN: 2, NOT_ENOUGH_DATA: 3 };

/** One table for all scanned coins, worst first. */
export function toIndexMarkdown(reports: CoinReport[], file: (r: CoinReport) => string): string {
  const sorted = [...reports].sort((a, b) => ORDER[a.verdict] - ORDER[b.verdict] || b.stats.trades - a.stats.trades);
  const count = (v: Verdict) => reports.filter((r) => r.verdict === v).length;
  return [
    "# DELPHI scan",
    "",
    `${reports.length} coins · ${count("FLAG")} flagged · ${count("WATCH")} to watch · ${count("CLEAN")} clean · ${count("NOT_ENOUGH_DATA")} without enough data`,
    "",
    "| Coin | Verdict | Trades | Holders | Top finding |",
    "| --- | --- | --- | --- | --- |",
    ...sorted.map(
      (r) =>
        `| [${mdText(r.coin.symbol, 16)}](${file(r)}) | ${r.verdict.replaceAll("_", " ")} | ${r.stats.trades} | ${r.stats.holders} | ${r.findings[0]?.summary.replaceAll("|", "\\|") ?? ""} |`,
    ),
    "",
    `_Rules ${RULES.version}. Patterns, not intent: every finding links to its transactions._`,
    "",
  ].join("\n");
}
