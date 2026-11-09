import { profile } from "../../../network.mts";
import { z } from "zod";
import { FeedRecord, type FeedCheck } from "./types.ts";
import type { FeedStore } from "./store.ts";

export const REPORT_TTL_MS = 15 * 60 * 60 * 1000;
const uint = z.string().regex(/^\d+$/).refine((s) => Number.isSafeInteger(Number(s)));
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((s) => s.toLowerCase());
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((s) => s.toLowerCase());
const date = z.iso.datetime();
const detector = z.enum(["bundle", "wash", "concentration"]);
const check = z.enum(["found", "clear", "not-enough-data"]);
const Report = z.object({
  rules: z.string().min(1).max(40),
  generatedAt: date,
  coin: z.object({
    token: address,
    poolId: z.string().regex(/^0x(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/).transform((s) => s.toLowerCase()),
    creator: address,
    name: z.string().nullable(),
    symbol: z.string().nullable(),
    launchTx: hash,
    launchBlock: uint,
    launchTime: date,
    url: z.url(),
    launchUrl: z.url(),
    market: z.enum(["kalos", "perpme"]).optional(),
  }),
  stats: z.object({
    trades: z.number().int().nonnegative(),
    outsideTrades: z.number().int().nonnegative(),
    traders: z.number().int().nonnegative(),
    holders: z.number().int().nonnegative(),
    links: z.number().int().nonnegative(),
    fundingMissing: z.number().int().nonnegative(),
  }),
  verdict: z.enum(["FLAG", "WATCH", "CLEAN", "NOT_ENOUGH_DATA"]),
  checks: z.object({ bundle: check, wash: check, concentration: check }),
  findings: z.array(z.object({
    detector,
    severity: z.enum(["flag", "watch"]),
    summary: z.string(),
    metrics: z.record(z.string(), z.union([z.number(), z.string()])),
    evidence: z.array(z.object({ what: z.string(), tx: hash, url: z.url() })),
  })),
  notes: z.array(z.string()),
}).superRefine((r, ctx) => {
  const worst = r.findings.some((f) => f.severity === "flag") ? "FLAG" : r.findings.length ? "WATCH" : null;
  if ((worst && r.verdict !== worst) || (!worst && ["FLAG", "WATCH"].includes(r.verdict))) {
    ctx.addIssue({ code: "custom", message: "verdict does not match findings" });
  }
  for (const key of detector.options) {
    if ((r.checks[key] === "found") !== r.findings.some((f) => f.detector === key)) {
      ctx.addIssue({ code: "custom", message: `${key} does not match findings` });
    }
  }
});

const Scan = z.object({ network: z.enum(["testnet", "mainnet"]), head: uint, generatedAt: date, reports: z.array(z.unknown()) });
type ScanMeta = Pick<z.infer<typeof Scan>, "network" | "head" | "generatedAt">;
const line = (s: string, max = 160) => s.replace(/[\p{Cc}\p{Cf}]/gu, " ").slice(0, max);

export function reportRecord(input: unknown, meta: ScanMeta, site = "https://pantheonindex.com"): FeedRecord {
  if (meta.network !== (profile().network.testnet ? "testnet" : "mainnet")) throw new Error("report network does not match selected deployment");
  const r = Report.parse(input);
  const checkedAtMs = Date.parse(r.generatedAt);
  if (checkedAtMs > Date.parse(meta.generatedAt) || BigInt(r.coin.launchBlock) > BigInt(meta.head)) throw new Error("report is newer than scan metadata");
  const verdict = r.verdict === "CLEAN" && (r.stats.fundingMissing > 0 || Object.values(r.checks).some((c) => c !== "clear")) ? "NOT_ENOUGH_DATA" : r.verdict;
  const findings = [...r.findings].sort((a, b) => Number(b.severity === "flag") - Number(a.severity === "flag"));
  const checks: FeedCheck[] = findings.map((f) => ({ code: f.detector, result: f.severity, text: line(f.summary), evidence: [...new Set(f.evidence.map((e) => e.tx))].slice(0, 8) }));
  for (const key of detector.options) {
    if (r.checks[key] !== "found") checks.push({ code: key, result: r.checks[key] === "clear" ? "ok" : "not-enough-data", text: `${key}: ${r.checks[key]}.`, evidence: [] });
  }
  checks.push({ code: "creator-buy", result: "not-enough-data", text: "Scanner reports do not include the creator's launch buy. creatorBuyShare=0 is an unknown placeholder, not a measured zero.", evidence: [] });
  if (r.stats.fundingMissing > 0) checks.push({ code: "funding", result: "not-enough-data", text: `Funding history missing for ${r.stats.fundingMissing} wallet(s).`, evidence: [] });
  for (const note of r.notes) checks.push({ code: "context", result: "info", text: line(note), evidence: [] });
  const base = new URL(site);
  if (!["http:", "https:"].includes(base.protocol)) throw new Error("site must be HTTP(S)");
  return FeedRecord.parse({
    v: 1, chainId: profile().chainId,
    token: r.coin.token, venue: r.coin.market ?? "ascend", pool: r.coin.poolId,
    symbol: r.coin.symbol === null ? null : line(r.coin.symbol, 40), name: r.coin.name === null ? null : line(r.coin.name, 40),
    state: verdict === "NOT_ENOUGH_DATA" ? "thin" : "ready", verdict, checks: checks.slice(0, 16),
    holders: null, dev: null, people: null, fakeTickerOf: null,
    launch: { tx: r.coin.launchTx, block: r.coin.launchBlock, timeMs: Date.parse(r.coin.launchTime), creator: r.coin.creator, creatorBuyShare: 0 },
    rules: r.rules, block: meta.head, blockHash: null, checkedAtMs, expiresAtMs: checkedAtMs + REPORT_TTL_MS,
    displayOnly: true, reportUrl: new URL(`/delphi/${r.coin.token}`, base).href,
    disputeUrl: new URL(`/delphi/dispute?token=${r.coin.token}`, base).href,
  });
}

export function publishScan(input: unknown, store: FeedStore, site?: string) {
  const scan = Scan.parse(input);
  if (scan.network !== (profile().network.testnet ? "testnet" : "mainnet")) throw new Error("scan network does not match selected deployment");
  const result = { published: 0, unchanged: 0, skipped: 0, errors: [] as string[] };
  const seen = new Set<string>();
  for (const [i, report] of scan.reports.entries()) {
    let record: FeedRecord;
    try {
      record = reportRecord(report, scan, site);
      if (seen.has(record.token)) throw new Error(`duplicate token ${record.token}`);
      seen.add(record.token);
    } catch (err) {
      result.skipped++;
      result.errors.push(`report ${i}: ${(err as Error).message}`);
      continue;
    }
    const old = store.get(record.token);
    if (old && (old.checkedAtMs > record.checkedAtMs || JSON.stringify(old) === JSON.stringify(record))) {
      result.unchanged++;
      continue;
    }
    const why = record.checks.filter((c) => c.result === "flag" || c.result === "watch" || c.result === "not-enough-data" && c.code !== "creator-buy").map((c) => c.text).join(" ") || "All three behavioral detectors clear.";
    store.put(record, why);
    result.published++;
  }
  return result;
}
