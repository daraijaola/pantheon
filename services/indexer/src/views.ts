// What the site shows, built from the indexed events plus a few current values read from the chain.
// Pure functions: the same inputs always give the same JSON. Every amount comes with its token and a
// readable value; every event comes with its explorer link, so any number can be checked.
import { formatUnits, type Address, type Hex } from "viem";
import type { Kind, Rec } from "./chain.ts";

/** Current values read from the chain on each poll. */
export type Live = {
  block: string;
  readAt: number;
  pnthSupply: string;
  burnSink: string;
  vaultUsdc: string;
  totalStaked: string;
  totalWorking: string;
  rewardTokens: Address[];
  activeId: number;
  proposals: Array<{
    id: number;
    eta: number;
    vetoed: boolean;
    executed: boolean;
    scoreRoot: Hex;
    methodologyURI: string;
    list: Array<{ poolId: Hex; token: Address; weightBps: number; perRunCap: string }>;
  }>;
  /** lowercase address → symbol and decimals. Symbols are set by coin creators: already sanitised. */
  tokens: Record<string, { symbol: string; decimals: number }>;
};

export type Ctx = { records: readonly Rec[]; live: Live; explorer: string; usdc: Address; pnth: Address; nowSec: number };
export type Amount = { raw: string; value: string; symbol: string; token: Address };

/** ConstituentRegistry.GRACE: a proposal not started within 7 days of its start time lapses. */
export const GRACE_SEC = 7 * 86_400;

const lc = (a: string) => a.toLowerCase();
const sum = (xs: Iterable<string>) => [...xs].reduce((s, x) => s + BigInt(x), 0n);

export function amount(c: Ctx, token: Address, raw: bigint | string): Amount {
  const t = c.live.tokens[lc(token)];
  const decimals = t?.decimals ?? (lc(token) === lc(c.usdc) ? 6 : 18);
  return { raw: raw.toString(), value: formatUnits(BigInt(raw), decimals), symbol: t?.symbol ?? "?", token };
}

const of = <K extends Kind>(c: Ctx, kind: K) => c.records.filter((r): r is Extract<Rec, { kind: K }> => r.kind === kind);

/** One event for the site: what happened, when, its amounts, and its transaction. */
export function receipt(c: Ctx, r: Rec) {
  const base = { kind: r.kind, tx: r.tx, url: `${c.explorer}/tx/${r.tx}`, block: r.block, logIndex: r.logIndex, at: r.at ?? null };
  switch (r.kind) {
    case "burn":
      return { ...base, amount: amount(c, c.pnth, r.amount) };
    case "to-basket":
      return { ...base, amount: amount(c, c.usdc, r.amount) };
    case "leg":
      return { ...base, job: r.job, to: r.to, amount: amount(c, r.side === "token" ? c.pnth : c.usdc, r.amount) };
    case "deferred":
      return { ...base, amount: amount(c, r.side === "token" ? c.pnth : c.usdc, r.amount) };
    case "run":
      return { ...base, runId: Number(r.runId), newToken: amount(c, c.pnth, r.newToken), newQuote: amount(c, c.usdc, r.newQuote) };
    case "buy":
      return { ...base, coin: amount(c, r.token, r.tokensOut), usdcIn: amount(c, c.usdc, r.quoteIn) };
    case "skip":
      return { ...base, coin: { token: r.token, symbol: c.live.tokens[lc(r.token)]?.symbol ?? "?" }, reason: r.reason };
    case "stream":
    case "reward":
      return { ...base, amount: amount(c, r.token, r.amount) };
    case "claim":
      return { ...base, account: r.account, amount: amount(c, r.token, r.amount) };
    case "stake":
    case "cancel-unstake":
    case "withdraw":
      return { ...base, account: r.account, amount: amount(c, c.pnth, r.amount) };
    case "unstake":
      return { ...base, account: r.account, amount: amount(c, c.pnth, r.amount), unlocksAt: r.coolEnd };
    case "proposed":
      return { ...base, proposalId: Number(r.id), startsAt: r.eta, scoreRoot: r.scoreRoot, methodologyURI: r.methodologyURI };
    case "vetoed":
      return { ...base, proposalId: Number(r.id) };
    case "executed":
      return { ...base, proposalId: Number(r.id), coins: r.count };
  }
}

const newest = <T extends Rec>(xs: readonly T[]) => (xs.length ? xs[xs.length - 1] : undefined);

/** PNTH staked per account, replayed from events (cross-checked against the contract's total). */
function stakedByAccount(c: Ctx): Map<string, bigint> {
  const m = new Map<string, bigint>();
  const add = (a: string, v: bigint) => m.set(lc(a), (m.get(lc(a)) ?? 0n) + v);
  for (const r of c.records) {
    if (r.kind === "stake" || r.kind === "cancel-unstake") add(r.account, BigInt(r.amount));
    if (r.kind === "unstake") add(r.account, -BigInt(r.amount));
  }
  return m;
}

export function stats(c: Ctx) {
  const burns = of(c, "burn");
  const toBasket = of(c, "to-basket");
  const buys = of(c, "buy");
  const streams = of(c, "stream");
  const rewards = of(c, "reward");
  const staked = stakedByAccount(c);
  const stakedFromEvents = [...staked.values()].reduce((s, v) => s + v, 0n);
  const lastBurn = newest(burns);
  const lastBuy = newest(buys);
  return {
    block: c.live.block,
    updatedAt: c.live.readAt,
    pnth: {
      supply: amount(c, c.pnth, c.live.pnthSupply),
      /** Everything in the burn sink, whatever sent it there. */
      burned: amount(c, c.pnth, c.live.burnSink),
      /** The part burned by PANTHEON's fee routing, one receipt per burn. */
      burnedFromFees: amount(c, c.pnth, sum(burns.map((b) => b.amount))),
      burns: burns.length,
      lastBurn: lastBurn ? receipt(c, lastBurn) : null,
    },
    basket: {
      /** USDC from PNTH's fees sent to the basket. */
      received: amount(c, c.usdc, sum(toBasket.map((r) => r.amount))),
      /** USDC the basket spent buying coins. */
      spent: amount(c, c.usdc, sum(buys.map((b) => b.quoteIn))),
      /** USDC streamed straight to stakers (what the basket does while it has no coin list). */
      streamedAsUsdc: amount(c, c.usdc, sum(streams.filter((s) => lc(s.token) === lc(c.usdc)).map((s) => s.amount))),
      waiting: amount(c, c.usdc, c.live.vaultUsdc),
      buys: buys.length,
      skips: of(c, "skip").length,
      lastBuy: lastBuy ? receipt(c, lastBuy) : null,
    },
    staking: {
      totalStaked: amount(c, c.pnth, c.live.totalStaked),
      stakers: [...staked.values()].filter((v) => v > 0n).length,
      rewards: c.live.rewardTokens.map((t) => {
        const mine = rewards.filter((r) => lc(r.token) === lc(t));
        return { ...amount(c, t, sum(mine.map((r) => r.amount))), streams: mine.length };
      }),
    },
    feeRuns: of(c, "run").length,
    /** Cross-checks of the events against the contracts' own numbers. */
    consistent: {
      stakedTotal: stakedFromEvents === BigInt(c.live.totalStaked),
      burnedFromFeesNotAboveBurnSink: sum(burns.map((b) => b.amount)) <= BigInt(c.live.burnSink),
    },
  };
}

export type ProposalStatus = "waiting" | "ready" | "active" | "replaced" | "vetoed" | "lapsed";

/** The same rules ConstituentRegistry.execute applies, so the site can say what each proposal is. */
export function proposalStatus(p: Live["proposals"][number], activeId: number, nowSec: number): ProposalStatus {
  if (p.vetoed) return "vetoed";
  if (p.executed) return p.id + 1 === activeId ? "active" : "replaced";
  if (p.id + 1 <= activeId) return "replaced"; // a newer list is active; this one can never start
  if (nowSec < p.eta) return "waiting";
  if (nowSec > p.eta + GRACE_SEC) return "lapsed";
  return "ready";
}

export function basket(c: Ctx) {
  const txOf = (kind: "proposed" | "executed" | "vetoed", id: number) => {
    const r = c.records.find((x) => x.kind === kind && Number((x as { id: string }).id) === id);
    return r ? { tx: r.tx, url: `${c.explorer}/tx/${r.tx}`, at: r.at ?? null } : null;
  };
  const coin = (x: Live["proposals"][number]["list"][number]) => {
    const buys = of(c, "buy").filter((b) => lc(b.token) === lc(x.token));
    const skips = of(c, "skip").filter((s) => lc(s.token) === lc(x.token));
    const lastBuy = newest(buys);
    const lastSkip = newest(skips);
    return {
      token: x.token,
      symbol: c.live.tokens[lc(x.token)]?.symbol ?? "?",
      poolId: x.poolId,
      weightPct: x.weightBps / 100,
      perRunCap: amount(c, c.usdc, x.perRunCap),
      bought: amount(c, x.token, sum(buys.map((b) => b.tokensOut))),
      spent: amount(c, c.usdc, sum(buys.map((b) => b.quoteIn))),
      buys: buys.length,
      lastBuy: lastBuy ? receipt(c, lastBuy) : null,
      lastSkip: lastSkip ? receipt(c, lastSkip) : null,
    };
  };
  const proposals = c.live.proposals.map((p) => ({
    id: p.id,
    status: proposalStatus(p, c.live.activeId, c.nowSec),
    startsAt: p.eta,
    scoreRoot: p.scoreRoot,
    methodologyURI: p.methodologyURI,
    coins: p.list.map(coin),
    proposed: txOf("proposed", p.id),
    started: txOf("executed", p.id),
    vetoed: txOf("vetoed", p.id),
  }));
  const active = proposals.find((p) => p.status === "active") ?? null;
  return { block: c.live.block, updatedAt: c.live.readAt, active, proposals };
}

export type ReceiptQuery = { kinds?: readonly Kind[]; account?: string; token?: string; limit: number; before?: { block: number; logIndex: number } };

/** Events newest first, filtered, a page at a time (`next` is the cursor for the following page). */
export function receipts(c: Ctx, q: ReceiptQuery) {
  const kinds = q.kinds ? new Set<string>(q.kinds) : null;
  const want = (r: Rec) => {
    if (kinds && !kinds.has(r.kind)) return false;
    if (q.account && !("account" in r && lc(r.account) === lc(q.account))) return false;
    if (q.token && !("token" in r && lc(r.token) === lc(q.token))) return false;
    if (q.before && (r.block > q.before.block || (r.block === q.before.block && r.logIndex >= q.before.logIndex))) return false;
    return true;
  };
  const items: Rec[] = [];
  for (let i = c.records.length - 1; i >= 0 && items.length <= q.limit; i--) if (want(c.records[i]!)) items.push(c.records[i]!);
  const page = items.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    block: c.live.block,
    items: page.map((r) => receipt(c, r)),
    next: items.length > q.limit && last ? `${last.block}-${last.logIndex}` : null,
  };
}
