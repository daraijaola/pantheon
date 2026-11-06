// The words Your space says, in DELPHI's plain voice: the most important thing first, and only that.
// Each fact is said once, in one place. Her verdicts are patterns, not advice: nothing here ever says
// to buy or sell.

import { TIER_NAMES } from "@/components/passport-book/view";
import type { Part, Space, Verdict } from "./data";

export { TIER_NAMES };

export const LABEL: Record<Verdict, string> = { FLAG: "Flagged", WATCH: "Watch", CLEAN: "Clean", NOT_ENOUGH_DATA: "Not enough data", UNKNOWN: "Not read" };

const ok = <T,>(p: Part<T>) => (p.state === "ok" ? p.data : null);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A coin's name as people say it: its ticker, or the start of its address. */
export const ticker = (c: { symbol: string | null; token: string }) => c.symbol ?? `${c.token.slice(0, 6)}…`;

/** "1,250", "12.4", "0.8213": a person's amount, never more digits than it needs. */
export function amount(s: string | null | undefined): string {
  const n = Number(s);
  if (s == null || !Number.isFinite(n)) return "—";
  if (n === 0) return "0";
  if (n >= 1e6) return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(n);
  return n.toLocaleString("en-US", { maximumFractionDigits: n < 1 ? 4 : 2 });
}

export const times = (x: number) => `${x.toFixed(2)}×`;

/** Dollars read as dollars: "12.40"; any other coin as an amount. */
export const money = (s: string, symbol: string) => (/^USD/.test(symbol) && Number.isFinite(Number(s)) ? Number(s).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : amount(s));

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "14 Sep 2026" */
export const day = (iso: string) => {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

/** "just now", "4 min ago", "3 h ago", "2 days ago". `now` in seconds; 0 before the page is in the browser. */
export function ago(iso: string, now: number): string {
  if (!now) return "";
  const s = Math.max(0, now - Date.parse(iso) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return plural(Math.floor(s / 86400), "day") + " ago";
}

/** Time left until `iso`: "2d 4h", "5h 20m", "12m". */
export function left(iso: string, now: number): string {
  const s = Math.max(0, Date.parse(iso) / 1000 - now);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.ceil((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// ------------------------------------------------------------------ your bag as one number

/** Integrity: the share of your coins DELPHI calls clean so far, by count. Unread and too-new coins
 * never count as clean, and it isn't final while any coin couldn't be read. */
export function integrity(bag: { coins: unknown[]; counts: Partial<Record<Verdict, number>>; complete: boolean; unread: string[] }) {
  const n = bag.coins.length;
  if (!n) return null;
  return { pct: Math.round((100 * (bag.counts.CLEAN ?? 0)) / n), final: bag.complete && !bag.unread.length };
}

// ------------------------------------------------------------------ for you: at most three things to do

export type Glyph = "alert" | "claim" | "vote" | "refresh" | "stake" | "passport" | "calm";
/**
 * One thing to do now. `coin` opens that coin's report in a tray (its `href` when the bag can't show it);
 * `href` goes to its page; `refresh` sends a poke. `emph` is the part of the title that matters most (the
 * coin, the amount, the new rate), which the page sets a little stronger.
 */
export type Todo = { key: string; glyph: Glyph; title: string; emph?: string; sub: string; action: string; href?: string; coin?: string; refresh?: boolean };

/** Now: at most three things, the most pressing first. A coin that turned this week, then what's yours to take. */
export function todos(sp: Space, now: number): Todo[] {
  const out: Todo[] = [];
  const rewards = ok(sp.rewards), stake = ok(sp.stake), ballot = ok(sp.ballot), standing = ok(sp.standing);
  for (const a of (ok(sp.guard)?.alerts ?? []).slice(0, 2)) {
    const name = a.symbol ?? "A coin";
    const when = now ? ago(a.at, now) : "this week";
    const emph = a.symbol ?? undefined;
    if (a.kind === "creator-sold") out.push({ key: a.id, glyph: "alert", title: `${name}’s creator sold`, emph, sub: `${(a.soldPct ?? 0).toFixed(1)}% of the supply · ${when}`, action: "See why", coin: a.token, href: a.reportUrl });
    else out.push({ key: a.id, glyph: "alert", title: a.to === "FLAG" ? `${name} was flagged` : `${name} is on watch now`, emph, sub: `Was ${(LABEL[(a.from as Verdict) ?? "CLEAN"] ?? a.from).toLowerCase()} · ${when}`, action: "See why", coin: a.token, href: a.reportUrl });
  }
  const claim = rewards?.coins.filter((c) => Number(c.claimable.amount) > 0) ?? [];
  if (claim.length) {
    const top = claim[0];
    const sum = `${money(top.claimable.amount, top.symbol)} ${top.symbol}`;
    out.push({ key: "claim", glyph: "claim", title: `${sum} to claim`, emph: sum, sub: claim.length > 1 ? `and ${plural(claim.length - 1, "more coin")}` : "From the basket", action: "Claim", href: "/stake" });
  }
  if (ballot?.canVote && ballot.round !== null) {
    const voted = ballot.picks.length > 0;
    const bits = [ballot.votes != null ? plural(ballot.votes, "vote") : null, ballot.closesAt && now ? `closes in ${left(ballot.closesAt, now)}` : null].filter(Boolean);
    out.push({ key: "vote", glyph: "vote", title: voted ? `You voted in round ${ballot.round}` : `Round ${ballot.round} is open`, sub: voted ? `You can change it${ballot.closesAt && now ? ` for ${left(ballot.closesAt, now)}` : ""}` : bits.join(" · "), action: voted ? "Change" : "Vote", href: "/trials/vote" });
  }
  // refreshing a stake is the Stake page's business unless there's room
  if (stake?.needsRefresh && out.length < 3) out.push({ key: "refresh", glyph: "refresh", title: `Earn ${times(stake.multiplier.ifRefreshed)} instead of ${times(stake.multiplier.earning)}`, emph: times(stake.multiplier.ifRefreshed), sub: "Your time bonus grew", action: "Refresh", refresh: true });
  if (stake?.canWithdraw && Number(stake.cooling.amount) > 0) out.push({ key: "withdraw", glyph: "claim", title: `${amount(stake.cooling.amount)} PNTH is ready`, emph: `${amount(stake.cooling.amount)} PNTH`, sub: "Your unstake has finished cooling", action: "Withdraw", href: "/stake" });
  // nothing pressing: the two ways in, a stake and a passport (each also brings votes in the Trials)
  if (!out.length) {
    if (stake && Number(stake.staked.amount) <= 0 && Number(stake.cooling.amount) <= 0) out.push({ key: "stake", glyph: "stake", title: "Earn from the basket", sub: "Stake PNTH to share every buy", action: "Stake", href: "/stake" });
    const tier = standing?.passport.tier ?? stake?.passportTier;
    if (tier === 0) out.push({ key: "passport", glyph: "passport", title: "Get your passport", sub: "Up to 1.25× and more votes", action: "Get one", href: "/passport/get" });
  }
  return out.slice(0, 3);
}

// ------------------------------------------------------------------ you: three numbers

export type Stat = { key: string; label: string; value: string; sub: string; since?: string; href: string };

/** "14 Sep" this year, "14 Sep 2025" before it. */
const shortDay = (iso: string) => {
  const d = new Date(iso);
  return d.getUTCFullYear() === new Date().getUTCFullYear() ? `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}` : day(iso);
};

/** The line under the title: how long you've been here. */
export const since = (sp: Space) => {
  const first = ok(sp.standing)?.firstSeen;
  return first ? `On Elysium since ${day(first.time)}` : null;
};

/**
 * Where you stand, once there's something to show: a stake, a passport or a pick. A newcomer's three
 * "none"s say nothing For you doesn't already, so they're left out.
 */
export function standing(sp: Space): Stat[] | null {
  const stake = ok(sp.stake), st = ok(sp.standing), record = ok(sp.record);
  const any = (stake && (Number(stake.staked.amount) > 0 || stake.passportTier > 0)) || (st && (Number(st.staking.now.amount) > 0 || st.passport.tier > 0)) || (record && record.totals.picks > 0);
  const unread = [sp.stake, sp.standing, sp.record].some((p) => p.state === "unread");
  return any || unread ? stats(sp) : null;
}

function stats(sp: Space): Stat[] {
  const stake = ok(sp.stake), standing = ok(sp.standing), record = ok(sp.record);
  const staking = stake ? Number(stake.staked.amount) > 0 : standing ? Number(standing.staking.now.amount) > 0 : null;
  const tier = standing?.passport.tier ?? stake?.passportTier ?? null;
  const boost = standing?.passport.boost ?? stake?.passportBoost ?? 1;
  const t = record?.totals;
  return [
    {
      key: "stake",
      label: "Stake",
      value: staking == null ? "—" : staking && stake ? times(stake.multiplier.earning) : staking ? "Staking" : "None",
      sub: staking == null ? "Couldn’t read it" : stake && staking ? `on ${amount(stake.staked.amount)} PNTH` : staking ? `${amount(standing?.staking.now.amount)} PNTH` : "Stake to earn",
      since: standing?.staking.firstStaked ? `since ${shortDay(standing.staking.firstStaked)}` : undefined,
      href: "/stake",
    },
    {
      key: "passport",
      label: "Passport",
      value: tier == null ? "—" : tier > 0 ? (TIER_NAMES[tier] ?? `Tier ${tier}`) : "None",
      sub: tier == null ? "Couldn’t read it" : tier > 0 ? `${times(boost)} boost` : "Up to 1.25×",
      href: tier && tier > 0 ? "/passport/me" : "/passport/get",
    },
    {
      key: "trials",
      label: "Trials",
      value: !t ? "—" : t.picks ? `${t.seatsWon} of ${t.picks}` : "No picks",
      sub: !t ? "Couldn’t read it" : t.picks ? "picks won a seat" : "Vote in a round",
      since: t?.rounds ? `${plural(t.rounds, "round")} voted` : undefined,
      href: "/trials/vote",
    },
  ];
}
