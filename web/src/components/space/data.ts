"use client";

// What Your space reads, in the shapes services/uploaded already answers (its README has every field).
// The site reaches them through the gateway ARCHITECTURE.md lays out: `GET /api/auth/me` says who is
// signed in, and `GET /api/me/<path>` forwards to uploaded's `/wallets/<the session's wallet>/<path>`,
// so the browser never chooses whose data it gets. Until those exist, the page shows a labelled example.

import { useQueries, useQuery } from "@tanstack/react-query";

export type Verdict = "FLAG" | "WATCH" | "CLEAN" | "NOT_ENOUGH_DATA" | "UNKNOWN";
export type Venue = "ascend" | "kalos" | "perpme";
export type Amount = { raw: string; amount: string };
export type Evidence = { what: string; tx: string; url: string };

export type BagCoin = {
  token: string;
  symbol: string | null;
  name: string | null;
  venue: Venue | null;
  /** What a person reads, e.g. "1250.5". */
  amount: string;
  verdict: Verdict;
  /** One line: the worst finding, or why there's no judgement yet. */
  reason: string;
  findings?: Array<{ kind: string; severity: "flag" | "watch"; text: string; evidence: Evidence[] }>;
  notes?: string[];
  reportUrl: string | null;
  disputeUrl: string | null;
  scannedAt: string | null;
  stale: boolean;
};
export type Bag = {
  readAt: string;
  /** Worst first. */
  coins: BagCoin[];
  counts: Partial<Record<Verdict, number>>;
  /** Coins only ever sent in by others: not counted, so a stranger can't change a bag. */
  sentIn: Array<{ token: string; symbol: string | null; verdict: Verdict }>;
  /** False when only DELPHI's own coins could be read. */
  wholeWallet: boolean;
  unread: string[];
  complete: boolean;
  /** A fresh read is running that may change a verdict here. */
  checking: boolean;
};
export type Rewards = {
  readAt: string;
  /** Most to claim first. */
  coins: Array<{ token: string; symbol: string; claimable: Amount; claimed: Amount | null; earned: Amount | null; verdict: Verdict | null }>;
  passportBoost: number;
  unread: string[];
  complete: boolean;
};
export type Stake = {
  readAt: string;
  staked: Amount;
  cooling: Amount;
  coolEnd: string | null;
  canWithdraw: boolean;
  stakeStart: string | null;
  timeBonus: { now: number; max: number; progress: number; fullAt: string | null };
  passportBoost: number;
  passportTier: number;
  /** What the stake earns at now, and what it would after a refresh (`poke`). */
  multiplier: { earning: number; ifRefreshed: number };
  needsRefresh: boolean;
};
export type Standing = {
  readAt: string;
  firstSeen: { block: string; time: string } | null;
  staking: { now: Amount; bonusSince: string | null; firstStaked: string | null };
  /** Null when Trials couldn't be read: "never voted" always means it was checked. */
  roundsVoted: number[] | null;
  coinsLaunched: { total: number; byVerdict: Record<string, number> };
  passport: { tier: number; boost: number };
  complete: boolean;
};
export type Alert = {
  id: string;
  kind: "verdict-drop" | "creator-sold";
  token: string;
  symbol: string | null;
  venue: Venue;
  at: string;
  from?: string;
  to?: string;
  reason: string;
  soldPct?: number;
  evidence: Evidence[];
  reportUrl: string;
  disputeUrl: string;
};
export type Guard = { readAt: string; alerts: Alert[]; coinsWatched: number; watchingSince: string; unread: string[]; complete: boolean };
export type Ballot = {
  round: number | null;
  canVote: boolean;
  whyNot: "NO_ROUND" | "NOT_OPEN" | "CLOSED" | "NO_VOTES" | "UNKNOWN" | null;
  votes: number | null;
  maxPicks: number | null;
  picks: string[];
  closesAt: string | null;
};
export type VotingRecord = {
  readAt: string;
  rounds: Array<{
    round: number;
    closed: boolean;
    votes: number;
    picks: Array<{ token: string; symbol: string | null; wonSeat: boolean; inBasketNow: boolean | null; verdictNow: Verdict; changePct: number | null }>;
  }>;
  totals: { rounds: number; picks: number; seatsWon: number };
  complete: boolean;
};

/** A part of the space: read, still on its way, or not readable just now (never shown as zero). */
export type Part<T> = { state: "ok"; data: T } | { state: "loading" } | { state: "unread" };

export type Space = {
  /** Example until someone is signed in. */
  mode: "loading" | "example" | "mine";
  wallet: string;
  bag: Part<Bag>;
  rewards: Part<Rewards>;
  stake: Part<Stake>;
  standing: Part<Standing>;
  guard: Part<Guard>;
  record: Part<VotingRecord>;
  ballot: Part<Ballot>;
};

const PATHS = { bag: "bag", rewards: "rewards", stake: "stake", standing: "standing", guard: "guard", record: "trials/record", ballot: "trials/ballot" } as const;
type Key = keyof typeof PATHS;
const KEYS = Object.keys(PATHS) as Key[];

async function json<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP_${res.status}`);
  return (await res.json()) as T;
}

/** The signed-in wallet's space, or the example. */
export function useSpace(): Space {
  const session = useQuery({
    queryKey: ["me", "session"],
    queryFn: async () => {
      const res = await fetch("/api/auth/me");
      if (!res.ok) return null; // no session, or sign-in isn't live yet
      const body = (await res.json().catch(() => null)) as { wallet?: string } | null;
      return body?.wallet ? body.wallet : null;
    },
    retry: false,
    staleTime: 60_000,
  });
  const wallet = session.data ?? null;
  const parts = useQueries({
    queries: KEYS.map((k) => ({
      queryKey: ["me", k, wallet],
      queryFn: () => json(`/api/me/${PATHS[k]}`),
      enabled: !!wallet,
      retry: 1,
      staleTime: 30_000,
      // Guard and the bag are what changes while you're here.
      refetchInterval: k === "bag" || k === "guard" ? 60_000 : false,
    })),
  });
  if (session.isPending) return { ...EXAMPLE, mode: "loading" };
  if (!wallet) return EXAMPLE;
  const part = <T,>(i: number): Part<T> => {
    const q = parts[i];
    if (q.data !== undefined) return { state: "ok", data: q.data as T };
    return q.isError ? { state: "unread" } : { state: "loading" };
  };
  return {
    mode: "mine",
    wallet,
    bag: part<Bag>(0),
    rewards: part<Rewards>(1),
    stake: part<Stake>(2),
    standing: part<Standing>(3),
    guard: part<Guard>(4),
    record: part<VotingRecord>(5),
    ballot: part<Ballot>(6),
  };
}

// ------------------------------------------------------------------ the example

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const ahead = (min: number) => new Date(Date.now() + min * 60_000).toISOString();
const DAY = 24 * 60;
const amt = (amount: string): Amount => ({ raw: "0", amount });
const tok = (n: number) => `0x${n.toString(16).padStart(4, "0")}${"5a1d".repeat(9)}`;
const report = (t: string) => `/delphi/${t}`;
const dispute = (t: string) => `/delphi/dispute?token=${t}`;
const clean = (n: number, symbol: string, name: string, amount: string): BagCoin => ({
  token: tok(n),
  symbol,
  name,
  venue: "ascend",
  amount,
  verdict: "CLEAN",
  reason: "Clean so far: every check passed.",
  reportUrl: report(tok(n)),
  disputeUrl: dispute(tok(n)),
  scannedAt: ago(14),
  stale: false,
});
const TX = (n: number) => ({ tx: `0x${n.toString(16).padStart(2, "0")}${"c4f1".repeat(15)}`, url: "#example" });

/** A made-up wallet, shown whole so every part of the page can be seen. Always labelled as an example. */
export const EXAMPLE: Space = {
  mode: "example",
  wallet: "0x7f3ab2c90d4e61f8a35b0c2e9d17f4a6b8c3e41e",
  bag: {
    state: "ok",
    data: {
      readAt: ago(2),
      coins: [
        {
          token: tok(1),
          symbol: "ZELOS",
          name: "Zelos",
          venue: "ascend",
          amount: "2400",
          verdict: "FLAG",
          reason: "Launch bundle: 12 linked wallets bought 41% of the supply in its first minute.",
          findings: [
            { kind: "bundle", severity: "flag", text: "12 wallets funded by one source bought 41% of the supply within 60 seconds of launch.", evidence: [{ what: "First bundled buy", ...TX(1) }, { what: "The shared funding", ...TX(2) }] },
            { kind: "concentration", severity: "watch", text: "Those wallets still hold 28% between them.", evidence: [{ what: "Largest linked holder", ...TX(3) }] },
          ],
          notes: ["The creator's wallet holds 6% of the supply."],
          reportUrl: report(tok(1)),
          disputeUrl: dispute(tok(1)),
          scannedAt: ago(14),
          stale: false,
        },
        {
          token: tok(2),
          symbol: "NYX",
          name: "Nyx",
          venue: "ascend",
          amount: "910.5",
          verdict: "WATCH",
          reason: "Hidden whales: 3 linked wallets hold 18% between them.",
          findings: [{ kind: "concentration", severity: "watch", text: "3 wallets funded by the same source hold 18% of the supply.", evidence: [{ what: "The shared funding", ...TX(4) }] }],
          reportUrl: report(tok(2)),
          disputeUrl: dispute(tok(2)),
          scannedAt: ago(14),
          stale: false,
        },
        {
          token: tok(3),
          symbol: "PAN",
          name: "Pan",
          venue: "kalos",
          amount: "15000",
          verdict: "WATCH",
          reason: "Wash trading: 9% of its volume went back and forth between the same people.",
          findings: [{ kind: "wash", severity: "watch", text: "9% of volume was traded back within minutes by linked wallets.", evidence: [{ what: "A round trip", ...TX(5) }] }],
          reportUrl: report(tok(3)),
          disputeUrl: dispute(tok(3)),
          scannedAt: ago(190),
          stale: false,
        },
        {
          token: tok(4),
          symbol: "ORPHEUS",
          name: "Orpheus",
          venue: "ascend",
          amount: "5000",
          verdict: "NOT_ENOUGH_DATA",
          reason: "Not enough data yet: 4 trades, 9 holders.",
          reportUrl: report(tok(4)),
          disputeUrl: dispute(tok(4)),
          scannedAt: ago(14),
          stale: false,
        },
        clean(5, "HELIOS", "Helios", "120.25"),
        clean(6, "SELENE", "Selene", "1200"),
        clean(7, "IRIS", "Iris", "980"),
        clean(8, "THEIA", "Theia", "760"),
        clean(9, "HEBE", "Hebe", "300"),
        clean(10, "EOS", "Eos", "64"),
        clean(11, "AETHER", "Aether", "48"),
        clean(12, "PHOEBE", "Phoebe", "45"),
        clean(13, "ATLAS", "Atlas", "12"),
        clean(14, "KRONOS", "Kronos", "3.5"),
      ],
      counts: { FLAG: 1, WATCH: 2, NOT_ENOUGH_DATA: 1, UNKNOWN: 0, CLEAN: 10 },
      sentIn: [
        { token: tok(20), symbol: "FREEDROP", verdict: "UNKNOWN" },
        { token: tok(21), symbol: "CLAIM", verdict: "FLAG" },
      ],
      wholeWallet: true,
      unread: [],
      complete: true,
      checking: false,
    },
  },
  rewards: {
    state: "ok",
    data: {
      readAt: ago(2),
      coins: [
        { token: "usdc", symbol: "USDC", claimable: amt("12.4"), claimed: amt("38.1"), earned: amt("50.5"), verdict: null },
        { token: tok(11), symbol: "AETHER", claimable: amt("14.2"), claimed: amt("31"), earned: amt("45.2"), verdict: "CLEAN" },
        { token: tok(5), symbol: "HELIOS", claimable: amt("0.82"), claimed: amt("2.4"), earned: amt("3.22"), verdict: "CLEAN" },
        { token: tok(1), symbol: "ZELOS", claimable: amt("3.1"), claimed: amt("0"), earned: amt("3.1"), verdict: "FLAG" },
      ],
      passportBoost: 1.2,
      unread: [],
      complete: true,
    },
  },
  stake: {
    state: "ok",
    data: {
      readAt: ago(2),
      staked: amt("1250"),
      cooling: amt("0"),
      coolEnd: null,
      canWithdraw: false,
      stakeStart: ago(13 * DAY),
      timeBonus: { now: 1.21, max: 1.5, progress: 0.43, fullAt: ahead(17 * DAY) },
      passportBoost: 1.2,
      passportTier: 2,
      multiplier: { earning: 1.32, ifRefreshed: 1.45 },
      needsRefresh: true,
    },
  },
  standing: {
    state: "ok",
    data: {
      readAt: ago(2),
      firstSeen: { block: "9128410", time: "2026-09-14T10:22:00Z" },
      staking: { now: amt("1250"), bonusSince: ago(13 * DAY), firstStaked: "2026-10-02T09:00:00Z" },
      roundsVoted: [3, 4, 5, 6],
      coinsLaunched: { total: 0, byVerdict: {} },
      passport: { tier: 2, boost: 1.2 },
      complete: true,
    },
  },
  guard: {
    state: "ok",
    data: {
      readAt: ago(2),
      alerts: [
        {
          id: "ex-1",
          kind: "verdict-drop",
          token: tok(1),
          symbol: "ZELOS",
          venue: "ascend",
          at: ago(2 * DAY + 180),
          from: "CLEAN",
          to: "FLAG",
          reason: "Launch bundle: 12 linked wallets bought 41% of the supply in its first minute.",
          evidence: [{ what: "First bundled buy", ...TX(1) }],
          reportUrl: report(tok(1)),
          disputeUrl: dispute(tok(1)),
        },
      ],
      coinsWatched: 14,
      watchingSince: "2026-10-20T00:00:00Z",
      unread: [],
      complete: true,
    },
  },
  record: {
    state: "ok",
    data: {
      readAt: ago(2),
      rounds: [],
      totals: { rounds: 4, picks: 11, seatsWon: 7 },
      complete: true,
    },
  },
  ballot: { state: "ok", data: { round: 7, canVote: true, whyNot: null, votes: 3, maxPicks: 3, picks: [], closesAt: ahead(2 * DAY + 4 * 60) } },
};
