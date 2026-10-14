// The keeper's decisions, as pure functions: which boosts to refresh, whether a simulated call is
// worth its gas, and how to say what it does in plain words.
import { formatUnits, type Address } from "viem";
import type { Effects } from "./chain.ts";

export type Staker = { account: Address; staked: bigint; working: bigint; next: bigint };

/**
 * Boosts to refresh. A boost that would FALL is always refreshed: a lapsed or downgraded Passport
 * must stop earning more than its share right away (fair to every other staker). One that would
 * RISE (the time bonus grows every second) is refreshed only once it has grown by `riseBps`, so the
 * keeper doesn't pay gas every few minutes for crumbs.
 */
export function choosePokes(stakers: readonly Staker[], riseBps: number): Address[] {
  const out: Address[] = [];
  const seen = new Set<string>();
  for (const s of stakers) {
    const key = s.account.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (s.next < s.working) out.push(s.account);
    else if (s.next > s.working && (s.working === 0n || (s.next - s.working) * 10_000n >= s.working * BigInt(riseBps))) out.push(s.account);
  }
  return out;
}

export type Kind = "run" | "rebalance" | "poke";
export type Simulated = { kind: Kind; ok: boolean; gasUsed: bigint; effects: Effects; error?: string };

/** Send a call only if its simulation succeeded and it would actually move something. */
export function useful(s: Simulated): boolean {
  if (!s.ok) return false;
  switch (s.kind) {
    case "run":
      return s.effects.legs.some((l) => l.amount > 0n);
    case "rebalance":
      return s.effects.buys.length > 0 || s.effects.streamed.length > 0;
    case "poke":
      return s.effects.poked.length > 0;
  }
}

/** Splits accounts into poke transactions of at most `size`. */
export const batches = <T>(items: readonly T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

export type Names = { usdc: Address; pnth: Address; symbols?: ReadonlyMap<string, string> };

const fmt = (amount: bigint, decimals: number) => {
  const [whole, frac = ""] = formatUnits(amount, decimals).split(".");
  return `${BigInt(whole!).toLocaleString("en-US")}${frac ? `.${frac.slice(0, 4).replace(/0+$/, "")}` : ""}`.replace(/\.$/, "");
};
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** One plain-English line per thing a call does (or would do). */
export function describe(s: Simulated, n: Names): string[] {
  const usdc = n.usdc.toLowerCase();
  const name = (t: Address) => (t.toLowerCase() === usdc ? "USDC" : t.toLowerCase() === n.pnth.toLowerCase() ? "PNTH" : (n.symbols?.get(t.toLowerCase()) ?? short(t)));
  const amount = (t: Address, v: bigint) => `${fmt(v, t.toLowerCase() === usdc ? 6 : 18)} ${name(t)}`;
  if (!s.ok) return [`${s.kind}: would fail (${s.error ?? "reverted"}), not sent`];
  const e = s.effects;
  const lines: string[] = [];
  if (s.kind === "run") {
    for (const l of e.legs) {
      const what = l.side === "token" ? `${fmt(l.amount, 18)} PNTH` : `${fmt(l.amount, 6)} USDC`;
      lines.push(l.job === "BURN" ? `burn ${what} from PNTH's fees` : l.job === "INDEX" ? `send ${what} of PNTH's fees to the basket` : `${l.job.toLowerCase()} ${what} to ${short(l.to)}`);
    }
    for (const d of e.deferred) lines.push(`a ${d.side} leg of ${d.amount} could not be delivered and waits for the next run`);
    if (lines.length === 0) lines.push("no new fees to route");
  }
  if (s.kind === "rebalance") {
    for (const b of e.buys) lines.push(`basket buys ${amount(b.token, b.tokensOut)} for ${fmt(b.quoteIn, 6)} USDC`);
    for (const k of e.skips) lines.push(`basket skips ${name(k.token)}: ${SKIP_WORDS[k.reason] ?? k.reason}`);
    for (const st of e.streamed) lines.push(`stream ${amount(st.token, st.amount)} to stakers over a day`);
    if (lines.length === 0) lines.push("nothing in the basket to spend");
  }
  if (s.kind === "poke") for (const p of e.poked) lines.push(`refresh the boost of ${short(p.account)}`);
  return lines;
}

const SKIP_WORDS: Record<string, string> = {
  NO_AVERAGE: "Ascend has no price average for it yet",
  STALE_AVERAGE: "its price average is too old (nobody traded it lately), so the price can't be trusted",
  BREAKER: "its price moved too much since the last buy (paused for one run)",
  PRICE_OUT_OF_BAND: "its price is more than 5% above its average",
  NOTHING_TO_SPEND: "no USDC left for it this run",
};
