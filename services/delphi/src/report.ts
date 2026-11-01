// Verdicts and reports. A report says what was checked, what was found, and the transactions
// behind every claim, so anyone can verify it on the explorer without trusting DELPHI.
import { RULES, rulesVersion } from "./config.ts";
import { balances, contractHoldings, detectBundle, detectConcentration, detectWash, type DetectorResult } from "./detect.ts";
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
    /** Set only for coins outside Ascend: Ascend reports stay exactly as they were. */
    market?: "kalos" | "perpme";
  };
  stats: { trades: number; outsideTrades: number; traders: number; holders: number; links: number; fundingMissing: number };
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
  // What the checks saw that is context, not cheating (v0.5): said first, in plain words.
  // Who holds the coin comes first: it's the context people need most.
  const order: Detector[] = ["concentration", "bundle", "wash"];
  const notes: string[] = order.flatMap((k) => results.find(([name]) => name === k)?.[1].notes ?? []);
  if (d.fundingMissing > 0) {
    notes.push(`Funding history missing for ${d.fundingMissing} wallet(s): links through shared funders may be incomplete.`);
    // Nothing found is not the same as clean when part of the picture is missing.
    if (verdict === "CLEAN") verdict = "NOT_ENOUGH_DATA";
  }
  if (c.windowFrom !== undefined) {
    notes.push(
      `Too busy to read in full: trades and transfers are read at launch and since block ${c.windowFrom}, and holders come from ` +
        "the balances of every wallet seen in those windows. Wash trading describes that recent window.",
    );
  }
  const parked = contractHoldings(d);
  if (parked) {
    const top = parked.top.map((x) => `${x.contract.slice(0, 6)}…${x.contract.slice(-4)} ${x.pct}%`).join(", ");
    notes.push(
      `Contracts hold ${parked.share}% of the tokens outside the pool (${top}). DELPHI checks wallets, so tokens in a contract ` +
        "(staking, a locker, a faucet) are nobody's holding and link no one. Check what a contract is before trusting it.",
    );
  }
  return {
    rules: rulesVersion(d.network),
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
      ...(c.market === "kalos" || c.market === "perpme" ? { market: c.market } : {}),
    },
    stats: {
      trades: d.trades.length,
      outsideTrades: d.trades.filter((t) => t.outside).length,
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
    `${r.stats.trades} trades by ${r.stats.traders} wallets${r.stats.outsideTrades ? ` (${r.stats.outsideTrades} in pools outside Ascend, which pay no Ascend fee)` : ""} · ${r.stats.holders} holders · ${r.stats.links} wallet links found`,
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
    `_Rules ${[...new Set(reports.map((r) => r.rules))].join(", ") || RULES.version}. Patterns, not intent: every finding links to its transactions._`,
    "",
  ].join("\n");
}
