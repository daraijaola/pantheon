import { readFile } from "node:fs/promises";
import path from "node:path";
import { cacheLife } from "next/cache";
import round1 from "@/lib/chain/deployments/trials-round-1.json";
import round2 from "@/lib/chain/deployments/trials-round-2.json";
import round3 from "@/lib/chain/deployments/trials-round-3.json";

// DELPHI's published data (services/delphi/out/site.json): every coin's verdict, plus the full
// report and Claude's explanation for the coins that have one. Re-read every few minutes, so a new
// scan shows up without a new deploy.

export type Verdict = "FLAG" | "WATCH" | "CLEAN" | "NOT_ENOUGH_DATA";
export type CheckState = "found" | "clear" | "not-enough-data";
export type Check = "bundle" | "wash" | "concentration";

export type CoinRow = {
  token: string;
  symbol: string | null;
  name: string | null;
  verdict: Verdict;
  trades: number;
  wallets: number;
  holders: number;
  /** Wallets that traded, held or moved the coin, and the people behind them (linked wallets count once). */
  people?: { wallets: number; people: number };
  launched: string;
  headline?: string;
};

export type Report = {
  rules: string;
  generatedAt: string;
  coin: { token: string; name: string | null; symbol: string | null; creator: string; launchTx: string; launchTime: string; url: string; launchUrl: string };
  stats: { trades: number; outsideTrades: number; traders: number; holders: number; links: number; fundingMissing: number };
  verdict: Verdict;
  notes: string[];
  checks: Record<Check, CheckState>;
  findings: Array<{ detector: Check; severity: "watch" | "flag"; summary: string }>;
};

export type Explanation = {
  verdict: Verdict;
  headline: string;
  summary: string;
  points: Array<{ text: string; evidence: string[] }>;
  caveats: string[];
};

export type Delphi = {
  generatedAt: string;
  scannedAt: string | null;
  explorer: string;
  rules: {
    version: string;
    bundle: { windowSec: number; watchPct: number; flagPct: number };
    wash: { pairWindowSec: number; watchPct: number; flagPct: number; minTrades: number };
    concentration: { watchPct: number; flagPct: number; minHolders: number };
  };
  counts: Record<Verdict, number> & { coins: number };
  coins: CoinRow[];
  explained: Record<string, { report: Report; explanation: Explanation; model: string; writtenAt: string }>;
};

/** The published scan, or null before DELPHI has published one. */
export async function readDelphi(): Promise<Delphi | null> {
  "use cache";
  cacheLife("minutes");
  const file = process.env.DELPHI_SITE_JSON ?? path.join(process.cwd(), "..", "services", "delphi", "out", "site.json");
  try {
    // Read at run time from outside the app, so the build must not try to bundle it.
    return JSON.parse(await readFile(/*turbopackIgnore: true*/ file, "utf8")) as Delphi;
  } catch {
    return null;
  }
}

// Every basket list proposed so far. Which one is live is read from the chain (the indexer's active
// list), so the pages switch by themselves when a new list starts.
type RoundFile = { symbols: string[]; tokens: string[]; excluded: Array<{ symbol: string; token: string; why: string }> };
const ROUND_FILES: Array<{ round: number; file: RoundFile }> = [
  { round: 1, file: round1 as RoundFile },
  { round: 2, file: round2 as RoundFile },
  { round: 3, file: round3 as RoundFile },
];
const same = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.some((y) => y.toLowerCase() === x.toLowerCase()));

/** The round whose list is live on-chain, from the live basket's tokens; null if unknown. */
export function liveRound(liveTokens: string[] | null): number | null {
  if (!liveTokens?.length) return null;
  return ROUND_FILES.find((r) => same(r.file.tokens, liveTokens))?.round ?? null;
}

/** Where a coin stands with PANTHEON's basket: in the live list, in an earlier one, or kept out (and why). */
export function basketNote(token: string, current: number | null): { in: boolean; round: number; was?: number; why?: string } | null {
  const cur = ROUND_FILES.find((r) => r.round === current);
  if (!cur) return null;
  const t = token.toLowerCase();
  const has = (f: RoundFile) => f.tokens.some((x) => x.toLowerCase() === t);
  if (has(cur.file)) return { in: true, round: cur.round };
  const why = cur.file.excluded.find((x) => x.token.toLowerCase() === t)?.why;
  const was = ROUND_FILES.filter((r) => r.round < cur.round && has(r.file)).at(-1)?.round;
  if (was) return { in: false, round: cur.round, was, why };
  return why ? { in: false, round: cur.round, why } : null;
}

/** The live list and the one before it, for the side text. */
export function rounds(current: number | null) {
  const cur = ROUND_FILES.find((r) => r.round === current);
  const prev = ROUND_FILES.find((r) => r.round === (current ?? 0) - 1);
  return cur ? { current: { round: cur.round, symbols: cur.file.symbols }, previous: prev ? { round: prev.round, symbols: prev.file.symbols } : null } : null;
}

export const VERDICT: Record<Verdict, string> = { FLAG: "Flagged", WATCH: "Watch", CLEAN: "Clean", NOT_ENOUGH_DATA: "Not enough data" };

/** "14 Oct, 20:47 UTC" */
export function when(iso: string): string {
  const d = new Date(iso);
  const day = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
  return `${day}, ${time} UTC`;
}

export const shortHash = (h: string) => `${h.slice(0, 6)}…${h.slice(-4)}`;

/** The page shows the verdict as a pill, so a headline that opens with it ("FLAG: …") drops that part. */
export function headline(h: string): string {
  const rest = h.replace(/^(FLAG|WATCH|CLEAN|NOT ENOUGH DATA)\s*[:—–-]\s*/, "");
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}
