import { readFile } from "node:fs/promises";
import path from "node:path";
import { cacheLife } from "next/cache";
import round1 from "@/lib/chain/deployments/trials-round-1.json";
import round2 from "@/lib/chain/deployments/trials-round-2.json";

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

// The basket list that's live now (round 2, since Oct 16 12:00 UTC) and the one before it.
type RoundFile = { symbols: string[]; tokens: string[]; excluded: Array<{ symbol: string; token: string; why: string }> };
const CURRENT = { round: 2, file: round2 as RoundFile };
const PREVIOUS = { round: 1, file: round1 as RoundFile };

/** Where a coin stands with PANTHEON's basket: in the live list, in the list before it, or kept out (and why). */
export function basketNote(token: string): { in: boolean; round: number; was?: number; why?: string } | null {
  const t = token.toLowerCase();
  const has = (f: RoundFile) => f.tokens.some((x) => x.toLowerCase() === t);
  if (has(CURRENT.file)) return { in: true, round: CURRENT.round };
  const why = CURRENT.file.excluded.find((x) => x.token.toLowerCase() === t)?.why;
  if (has(PREVIOUS.file)) return { in: false, round: CURRENT.round, was: PREVIOUS.round, why };
  return why ? { in: false, round: CURRENT.round, why } : null;
}

export const ROUNDS = {
  current: { round: CURRENT.round, symbols: CURRENT.file.symbols },
  previous: { round: PREVIOUS.round, symbols: PREVIOUS.file.symbols },
};

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
