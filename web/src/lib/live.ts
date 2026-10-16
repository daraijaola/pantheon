import { cacheLife } from "next/cache";
import { deployment } from "@/lib/chain/config";
import { readDelphi } from "@/lib/delphi";

// The home page's live numbers, read on the server from services on this machine: the indexer
// (burns, basket buys, stakers), the Trials vote, and DELPHI's people count. Re-read every few
// minutes. A service that doesn't answer leaves its numbers out; nothing is ever made up.

type Amount = { raw: string; value: string; symbol: string; token: string };
type Event = { tx: string; url: string; at: number };

type Stats = {
  pnth: { burned: Amount; lastBurn: (Event & { amount: Amount }) | null };
  basket: { spent: Amount; buys: number; lastBuy: (Event & { coin: Amount; usdcIn: Amount }) | null };
  staking: { stakers: number };
};
type BasketCoin = { token: string; symbol: string | null; weightPct: number; bought: Amount; buys: number };
type Proposal = { id: number; status: string; startsAt: number; coins: BasketCoin[] };
type Basket = { active: Proposal | null; proposals: Proposal[] };
type Vote = { round: number; status: string; closesAt: number; ballots: number };

export type Live = {
  people: { wallets: number; people: number } | null;
  stakers: number | null;
  burned: { pnth: number; url: string | null } | null;
  bought: { usdc: number; buys: number; last: { symbol: string; url: string } | null } | null;
  basket: { coins: Array<{ token: string; symbol: string; weightPct: number; bought: number }> } | null;
  next: { symbols: string[]; startsAt: number } | null;
  vote: { round: number; open: boolean; closesAt: number; ballots: number } | null;
  checked: { coins: number; flagged: number } | null;
};

const INDEXER = process.env.INDEXER_API ?? "http://127.0.0.1:8789";
const TRIALS = process.env.TRIALS_API ?? "http://127.0.0.1:8790";

async function get<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4_000) });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

export async function readLive(): Promise<Live> {
  "use cache";
  cacheLife("minutes");
  const [stats, basket, vote, delphi] = await Promise.all([
    get<Stats>(`${INDEXER}/stats`),
    get<Basket>(`${INDEXER}/basket`),
    get<Vote>(`${TRIALS}/trials/current`),
    readDelphi(),
  ]);
  const pnth = deployment?.pnth.toLowerCase();
  const row = delphi?.coins.find((c) => c.token.toLowerCase() === pnth);
  const waiting = basket?.proposals.filter((p) => p.status === "waiting").sort((a, b) => a.startsAt - b.startsAt)[0];
  return {
    people: row?.people ?? null,
    stakers: stats?.staking.stakers ?? null,
    burned: stats ? { pnth: Number(stats.pnth.burned.value), url: stats.pnth.lastBurn?.url ?? null } : null,
    bought: stats
      ? {
          usdc: Number(stats.basket.spent.value),
          buys: stats.basket.buys,
          last: stats.basket.lastBuy ? { symbol: stats.basket.lastBuy.coin.symbol, url: stats.basket.lastBuy.url } : null,
        }
      : null,
    basket: basket?.active
      ? {
          coins: basket.active.coins.map((c) => ({
            token: c.token,
            symbol: c.symbol ?? `${c.token.slice(0, 6)}…`,
            weightPct: c.weightPct,
            bought: Number(c.bought.value),
          })),
        }
      : null,
    next: waiting ? { symbols: waiting.coins.map((c) => c.symbol ?? `${c.token.slice(0, 6)}…`), startsAt: waiting.startsAt } : null,
    vote: vote ? { round: vote.round, open: vote.status === "open", closesAt: vote.closesAt, ballots: vote.ballots } : null,
    checked: delphi ? { coins: delphi.counts.coins, flagged: delphi.counts.FLAG } : null,
  };
}
