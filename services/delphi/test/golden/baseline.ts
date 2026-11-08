import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { RULES, supplyOf, rulesVersion } from "../../src/config.ts";
import { balances, detectBundle, detectWash, detectConcentration, pct, roundTrips } from "../../src/detect.ts";
import { groupsOf, isSystem } from "../../src/graph.ts";
import { analyze } from "../../src/report.ts";
import { inputs, NOW, type GoldenInput } from "./inputs.ts";

export const detectors = { bundle: detectBundle, wash: detectWash, concentration: detectConcentration };
export const fixture = new URL("../fixtures/golden/", import.meta.url);
export const version = () => rulesVersion("testnet");
export const digest = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
export function measure(input: GoldenInput) {
  const d = input.data;
  const r = analyze(d, { explorerWeb: "https://test-explorer.elysium.kinetiq.xyz", now: NOW });
  const held = [...balances(d).values()];
  const trades = d.trades.filter(t => t.tokens > 0n && !isSystem(d, t.holder));
  const volume = trades.reduce((s, t) => s + t.tokens, 0n);
  const matched = roundTrips(d);
  const early = d.trades.filter(t => t.side === "buy" && t.time <= d.coin.launchTime + RULES.bundle.windowSec && !isSystem(d, t.holder));
  return {
    token: d.coin.token, symbol: d.coin.symbol, venue: d.coin.market ?? "ascend", verdict: r.verdict,
    checks: r.checks, stats: r.stats,
    detectors: Object.fromEntries(Object.entries(detectors).map(([name, run]) => {
      const result = run(d);
      return [name, { enough: result.enough, severity: result.finding?.severity ?? null,
        metrics: result.finding?.metrics ?? {}, notes: result.notes ?? [] }];
    })),
    numbers: {
      earlyBuyers: new Set(early.map(t => t.holder.toLowerCase())).size,
      earlySupplyPct: pct(early.reduce((s, t) => s + t.tokens, 0n), supplyOf(d.coin)),
      maxHolderSupplyPct: pct(held.reduce((a, b) => a > b ? a : b, 0n), supplyOf(d.coin)),
      walletHeldSupplyPct: pct(held.reduce((a, b) => a + b, 0n), supplyOf(d.coin)),
      roundTripTrades: matched.size, washVolumePct: pct([...matched.values()].reduce((a, b) => a + b, 0n), volume),
      groups: groupsOf(d.links).length,
    },
  };
}
export type Measurement = ReturnType<typeof measure>;
export type Baseline = { rules: string; reason: string; inputHash: string; coins: Record<string, Measurement> };
export function current(): Record<string, Measurement> {
  return Object.fromEntries(inputs().map(input => [input.id, measure(input)]));
}
export function inputHash(): string {
  const paths = ["golden/cache.json.gz", "live-trades.json", "kalos/ta.json", "kalos/elant.json", "kalos/sign.json", "perpme/coin.json"];
  return digest(Buffer.concat(paths.flatMap(path => [Buffer.from(path), readFileSync(new URL(`../fixtures/${path}`, import.meta.url))])));
}
export function changes(expected: unknown, actual: unknown, path = ""): string[] {
  if (typeof expected === "number" && typeof actual === "number") {
    const same = Number.isInteger(expected) ? actual === expected : Math.abs(actual - expected) <= 1e-9;
    return same ? [] : [`${path}: ${expected} -> ${actual}`];
  }
  if (expected !== null && actual !== null && typeof expected === "object" && typeof actual === "object") {
    const a = expected as Record<string, unknown>, b = actual as Record<string, unknown>;
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap(key => changes(a[key], b[key], path ? `${path}.${key}` : key));
  }
  return expected === actual ? [] : [`${path}: ${JSON.stringify(expected)} -> ${JSON.stringify(actual)}`];
}
export function regressionMessage(baseline: Baseline, actual: Record<string, Measurement>): string {
  const diff = [...new Set([...Object.keys(baseline.coins), ...Object.keys(actual)])].flatMap(id => {
    const lines = changes(baseline.coins[id], actual[id]);
    return lines.length ? [`${baseline.coins[id]?.symbol ?? actual[id]?.symbol ?? "?"} (${id}):\n  ${lines.join("\n  ")}`] : [];
  });
  return diff.length ? `Golden verdict regression under ${version()}:\n${diff.join("\n")}\nDo not overwrite an approved baseline. Review evidence, bump RULES.version in src/config.ts, then run:\nnode test/golden/rebaseline.ts --accept-rules <new-version> --reason "reviewed explanation"\nKeep old version files and their ledger entries immutable.` : "";
}
