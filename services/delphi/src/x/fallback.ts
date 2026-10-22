// The safety net: when Claude can't produce a reply that passes the checks (or can't be reached),
// a coin question still gets an answer, built straight from DELPHI's report with no model at all.
// Same rules as every reply: plain words, rounded numbers, no links, tags, advice or PANTHEON.
import { coinReport } from "../ai/tools.ts";
import type { Verdict } from "../types.ts";
import { replyProblems, knownNumbers } from "./text.ts";
import type { Snapshot } from "./xtools.ts";

const lc = (a: string) => a.toLowerCase();
/** "72.04%" → "72%". */
const round = (s: string) => s.replace(/\d+(?:\.\d+)?%/g, (m) => `${Math.round(Number(m.slice(0, -1)))}%`);

const CHECK: Record<string, string> = { bundle: "launch bundle", wash: "fake volume", concentration: "hidden concentration" };

export function fallbackReply(snap: Snapshot, token: string): { text: string; verdict: Verdict } | null {
  const r = snap.ws.reports.get(lc(token));
  if (!r) return null;
  const full = coinReport(snap.ws, { token });
  const lines: string[] = [];
  if (r.verdict === "FLAG" || r.verdict === "WATCH") {
    const f = r.findings.find((x) => x.severity === (r.verdict === "FLAG" ? "flag" : "watch")) ?? r.findings[0];
    lines.push(`${r.verdict === "FLAG" ? "Flagged" : "On watch"}: ${CHECK[f?.detector ?? ""] ?? "a pattern"} found.`, "");
    if (f) lines.push(`• ${round(f.summary.replace(/\.$/, "")).replace(/^\w/, (c) => c.toLowerCase())}`);
  } else if (r.verdict === "CLEAN") {
    lines.push("Clean so far: every check passed.", "", `• ${r.stats.trades} trades from ${r.stats.traders} wallets`);
  } else {
    lines.push(`Too early to tell: ${r.stats.trades} trades from ${r.stats.traders} wallets so far.`, "");
    const m = full.missing ?? {};
    if (m.washTrading) lines.push(`• fake-volume check ${m.washTrading}`);
    if (m.hiddenConcentration) lines.push(`• concentration check ${m.hiddenConcentration}`);
  }
  for (const [k, v] of Object.entries(r.checks)) if (v === "clear") lines.push(`• no ${CHECK[k]}`);
  const known = knownNumbers([JSON.stringify(full), JSON.stringify(r)]);
  const ok = (t: string) => replyProblems(t, { known, addresses: new Set([lc(token)]), maxLength: 270 }).length === 0;
  // Longest version that passes every check, dropping bullets from the end.
  for (let n = lines.length; n >= 1; n--) {
    const text = lines.slice(0, n).join("\n").trim();
    if (ok(text)) return { text, verdict: r.verdict };
  }
  return null;
}
