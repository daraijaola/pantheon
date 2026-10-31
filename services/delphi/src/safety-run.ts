// Runs the contract and market checks (safety.ts) for many coins and keeps each answer for a day:
// a token's code never changes, and its owner, powers and tax rarely do. The short form is what the
// site and @heyDelph show; the full report, with every fact and its evidence, is saved next to it.
import type { Address } from "viem";
import { mapLimit } from "./chain.ts";
import type { BatchRpc } from "./rpc.ts";
import { checkSafety, type CheckId, type CheckState, type SafetyReport } from "./safety.ts";
import type { Store } from "./store.ts";

const lc = (a: string) => a.toLowerCase();
const DAY = 86_400;

/** What a page or a reply needs: each check's state and one plain sentence, and what is at risk. */
export type SafetySummary = {
  rules: string;
  block: string;
  checkedAt: string;
  risks: CheckId[];
  unknowns: CheckId[];
  checks: Record<CheckId, { state: CheckState; summary: string }>;
  notes: string[];
};

export function summarize(r: SafetyReport): SafetySummary {
  const checks = Object.fromEntries(Object.entries(r.checks).map(([id, c]) => [id, { state: c.state, summary: c.summary }])) as SafetySummary["checks"];
  return { rules: r.rules, block: r.block, checkedAt: r.checkedAt, risks: r.risks, unknowns: r.unknowns, checks, notes: r.notes };
}

/** JSON with bigints as decimal strings (the reports carry raw token amounts). */
export const plainJson = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? x.toString() : x)));

/**
 * Each token's safety report: from the cache when under `maxAgeSec` old, else checked now (a few at a
 * time; about 15 node reads each). A token whose check fails keeps its last report, if it had one.
 */
export async function safetyFor(
  deps: { rpc: BatchRpc; store: Store; log?: (m: string) => void },
  tokens: readonly Address[],
  opts: { maxAgeSec?: number; limit?: number } = {},
): Promise<Map<string, SafetyReport>> {
  const { rpc, store } = deps;
  const out = new Map<string, SafetyReport>();
  const todo: Address[] = [];
  for (const t of tokens) {
    const hit = store.recall<SafetyReport>("safety", lc(t), opts.maxAgeSec ?? DAY);
    if (hit) out.set(lc(t), hit);
    else todo.push(t);
  }
  let failed = 0;
  await mapLimit(todo, opts.limit ?? 3, async (t) => {
    try {
      const r = plainJson(await checkSafety({ rpc }, t)) as SafetyReport;
      store.remember("safety", lc(t), r);
      out.set(lc(t), r);
    } catch (err) {
      failed += 1;
      deps.log?.(`safety check failed for ${t}: ${(err as Error).message.slice(0, 160)}`);
      const old = store.recall<SafetyReport>("safety", lc(t));
      if (old) out.set(lc(t), old);
    }
  });
  if (todo.length) deps.log?.(`safety: ${todo.length - failed} checked now, ${tokens.length - todo.length} from the last day${failed ? `, ${failed} failed` : ""}`);
  return out;
}
