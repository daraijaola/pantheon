// Tools only DELPHI-on-X has, next to the explainer's read-only tools: find a coin by ticker, name or
// address; see a creator's other launches; and say how fresh DELPHI's data is. Read-only, like the rest.
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { formatUnits, isAddress } from "viem";
import { z } from "zod";
import { RULES } from "../config.ts";
import type { Workspace } from "../ai/workspace.ts";
import type { Verdict } from "../types.ts";

/** Contracts DELPHI can name for sure (Elysium testnet, checked Oct 22). Anything else is "a contract". */
export const KNOWN_ADDRESSES: Readonly<Record<string, string>> = {
  "0x30c88fce1fad545df0fc603287f93f0f94076224": "PANTHEON's staking contract (PNTH staked by its holders)",
  "0x1c6856862aac444b5ebfc65d2847e52b1c2b7176": "PANTHEON's free test-PNTH tap (testnet faucet)",
  "0xd8cea0015e2c876ab5fa6d9178b46b57d65c6087": "PANTHEON's basket registry contract",
  "0x155224663abe76b427f07ebf34b57cc920c47e9e": "PANTHEON's basket buyer (buys top Ascend coins on a schedule for PNTH stakers, never sells)",
  "0x2b738a9a69b7a45c9da6b519f6be6efbfb912aec": "Ascend's vault (holds every Ascend pool's tokens)",
  "0xe2f6254508deb93da081837f545e0baf7b00d8e9": "Ascend's launchpad",
  "0x90332b0ecbb2c9517f405627b0dd5d5265246563": "Ascend's router",
  "0xc889ac2f59a88afb3b2fb3f2c452dba336fe5f0f": "Ascend's burn address (burned tokens)",
  "0xf272cc84c3ba9f1b498ade29aaeed1e7d2d9f3fd": "the Elysium testnet faucet (public)",
};

/** PANTHEON's own coin: replies mention PANTHEON or PNTH only when the question is about it. */
export const PNTH = "0x048aceb334cb1835dc897a749c5985e169eab1c5";
const GENERIC: Readonly<Record<string, string>> = {
  "0x30c88fce1fad545df0fc603287f93f0f94076224": "a staking contract (holds tokens for its stakers)",
  "0x1c6856862aac444b5ebfc65d2847e52b1c2b7176": "a token faucet contract",
  "0xd8cea0015e2c876ab5fa6d9178b46b57d65c6087": "a contract",
  "0x155224663abe76b427f07ebf34b57cc920c47e9e": "an automated buyer (an index basket that buys top coins on a schedule and doesn't sell)",
};

/** One loaded scan: the workspace plus when and up to which block it was read. */
export type Snapshot = { ws: Workspace; head: bigint; readAt: Date; notes: string[] };

const lc = (a: string) => a.toLowerCase();
const untrusted = (s: string | null) => (s ? [...s.replace(/[\p{Cc}\p{Cf}]/gu, "")].slice(0, 40).join("") : null);

/** "37 minutes", "5 hours", "3 days": rounded, for a reply. */
function age(seconds: number) {
  const m = Math.max(0, Math.round(seconds / 60));
  return { minutes: m, hours: Math.round(m / 60), days: Math.round(m / 1440) };
}

function row(snap: Snapshot, token: string) {
  const r = snap.ws.reports.get(lc(token))!;
  const launched = Number(Date.parse(r.coin.launchTime)) / 1000 || 0;
  const a = age(snap.readAt.getTime() / 1000 - launched);
  return {
    token: r.coin.token,
    symbolSetByCreator: untrusted(r.coin.symbol),
    nameSetByCreator: untrusted(r.coin.name),
    verdict: r.verdict,
    trades: r.stats.trades,
    traders: r.stats.traders,
    holders: r.stats.holders,
    launched: r.coin.launchTime,
    launchedAgo: { minutes: a.minutes, hours: a.hours, days: a.days },
  };
}

export function findCoinTool(snap: Snapshot, input: { query: string }) {
  const q = input.query.trim().replace(/^\$/, "");
  if (isAddress(q, { strict: false })) {
    return snap.ws.reports.has(lc(q))
      ? { matches: [row(snap, q)] }
      : { matches: [], note: "No Ascend coin with this address in DELPHI's data: another kind of token, a wallet, or launched after the last read." };
  }
  const needle = q.toLowerCase();
  const all = [...snap.ws.reports.values()];
  const exact = all.filter((r) => (r.coin.symbol ?? "").toLowerCase() === needle);
  const partial = all.filter((r) => !exact.includes(r) && ((r.coin.symbol ?? "").toLowerCase().includes(needle) || (r.coin.name ?? "").toLowerCase().includes(needle)));
  const hits = [...exact, ...partial].slice(0, 10);
  return {
    matches: hits.map((r) => row(snap, r.coin.token)),
    exactTickerMatches: exact.length,
    ...(exact.length > 1 ? { note: "Several coins share this ticker. Creators choose tickers freely: only the address tells them apart." } : {}),
  };
}

export function creatorHistory(snap: Snapshot, input: { token: string }) {
  const r = snap.ws.reports.get(lc(input.token));
  const d = snap.ws.coins.get(lc(input.token));
  if (!r || !d) return { error: `${input.token} is not a coin in this scan` };
  const people = new Set([lc(d.coin.creator), lc(d.coin.launcher)]);
  const others = [...snap.ws.coins.values()].filter(
    (o) => lc(o.coin.token) !== lc(d.coin.token) && (people.has(lc(o.coin.creator)) || people.has(lc(o.coin.launcher))),
  );
  const byVerdict: Record<Verdict, number> = { FLAG: 0, WATCH: 0, CLEAN: 0, NOT_ENOUGH_DATA: 0 };
  for (const o of others) byVerdict[snap.ws.reports.get(lc(o.coin.token))!.verdict] += 1;
  return {
    creator: d.coin.creator,
    ...(lc(d.coin.launcher) !== lc(d.coin.creator) ? { launchSentBy: d.coin.launcher } : {}),
    otherLaunches: others.length,
    otherLaunchesByVerdict: byVerdict,
    rows: others.slice(0, 15).map((o) => row(snap, o.coin.token)),
    note: "Same creator or launch wallet on Ascend only. A creator can use a fresh wallet for every coin, so none found does not prove a first launch.",
  };
}

export function delphiStatus(snap: Snapshot) {
  const all = [...snap.ws.reports.values()];
  const count = (v: Verdict) => all.filter((r) => r.verdict === v).length;
  const a = age((Date.now() - snap.readAt.getTime()) / 1000);
  return {
    rules: RULES.version,
    dataReadAt: snap.readAt.toISOString(),
    dataAge: { minutes: a.minutes, hours: a.hours },
    upToBlock: snap.head.toString(),
    network: "Elysium testnet",
    coins: all.length,
    byVerdict: { FLAG: count("FLAG"), WATCH: count("WATCH"), CLEAN: count("CLEAN"), NOT_ENOUGH_DATA: count("NOT_ENOUGH_DATA") },
    checks: {
      bundle: `linked wallets buying ${RULES.bundle.watchPct}%+ of supply in the first ${RULES.bundle.windowSec}s (flag at ${RULES.bundle.flagPct}%)`,
      wash: `the same actor buying and selling back within ${RULES.wash.pairWindowSec / 60} min: ${RULES.wash.watchPct}%+ of volume (flag at ${RULES.wash.flagPct}%), needs ${RULES.wash.minTrades} trades`,
      concentration: `linked wallets holding ${RULES.concentration.watchPct}%+ of wallet-held tokens (flag at ${RULES.concentration.flagPct}%), needs ${RULES.concentration.minHolders} holders`,
    },
    notes: snap.notes,
  };
}

export function whatIsAddress(snap: Snapshot, input: { address: string }, aboutUs = true) {
  let a = lc(input.address.trim());
  // Reports shorten addresses (0x30c8…6224): match those against what DELPHI knows.
  const short = a.match(/^0x([0-9a-f]{3,8})(?:…|\.\.\.)([0-9a-f]{3,8})$/);
  if (short) {
    const pool = new Set([...Object.keys(KNOWN_ADDRESSES), ...[...snap.ws.coins.values()].flatMap((d) => [lc(d.coin.token), lc(d.coin.creator)])]);
    const hits = [...pool].filter((x) => x.slice(2).startsWith(short[1]!) && x.endsWith(short[2]!));
    if (hits.length !== 1) return { address: input.address, is: "unknown to DELPHI: call it 'a contract' or 'a wallet' as the coin report says, and never guess what it is" };
    a = hits[0]!;
  }
  if (!isAddress(a, { strict: false })) return { error: `${input.address} is not an address` };
  if (KNOWN_ADDRESSES[a]) return { address: input.address, is: (!aboutUs && GENERIC[a]) || KNOWN_ADDRESSES[a] };
  if (snap.ws.reports.has(a)) return { address: input.address, is: "an Ascend coin", ...row(snap, a) };
  const creatorOf = [...snap.ws.coins.values()].filter((d) => lc(d.coin.creator) === a).length;
  return creatorOf
    ? { address: input.address, is: `the creator wallet of ${creatorOf} Ascend coin(s)` }
    : { address: input.address, is: "unknown to DELPHI: call it 'a contract' or 'a wallet' as the coin report says, and never guess what it is" };
}

/** Significant digits for a small price: 0.00001234, 1.234, 12,345. */
const sig = (n: number) => (n === 0 ? "0" : n < 1 ? n.toPrecision(4) : n.toLocaleString("en-US", { maximumFractionDigits: 2 }));

/** Price, market cap and trading from the coin's own trades (testnet: test USDC, no real value). */
export function market(snap: Snapshot, input: { token: string }) {
  const d = snap.ws.coins.get(lc(input.token));
  if (!d) return { error: `${input.token} is not a coin in this scan` };
  const now = snap.readAt.getTime() / 1000;
  const rows = d.trades
    .filter((t) => t.tokens > 0n)
    .map((t) => {
      const pair = snap.ws.pools.get(lc(t.pool));
      const q = pair ? (lc(pair[0].address) === lc(d.coin.token) ? pair[1] : pair[0]) : null;
      const quote = q ? Number(formatUnits(t.quote, q.decimals)) : null;
      return { t, q, quote, price: quote === null ? null : quote / Number(formatUnits(t.tokens, 18)) };
    });
  const priced = rows.filter((r) => r.price !== null && !r.t.outside);
  const last = priced.at(-1);
  const first = priced[0];
  const sym = last?.q?.symbol ?? first?.q?.symbol ?? "unknown";
  const dayAgo = priced.filter((r) => r.t.time <= now - 86_400).at(-1);
  const recent = rows.filter((r) => r.t.time > now - 86_400);
  const vol = (rs: typeof rows) => rs.reduce((s, r) => s + (r.quote ?? 0), 0);
  const change = (from: number | null | undefined, to: number | null | undefined) => (from && to ? Math.round(((to - from) / from) * 100) : null);
  return {
    quotedIn: sym,
    network: "Elysium testnet: prices are in test money with no real value",
    ...(last
      ? {
          lastPrice: sig(last.price!),
          lastTradeAgo: age(now - last.t.time),
          marketCap: Math.round(last.price! * 1e9).toLocaleString("en-US"),
          marketCapNote: "last price x 1,000,000,000 tokens (every Ascend coin has that supply)",
          firstPrice: sig(first!.price!),
          changeSinceFirstTradePct: change(first!.price, last.price),
          changeLast24hPct: change(dayAgo?.price, last.price),
        }
      : { lastPrice: null, note: "no priced trades yet" }),
    last24h: { trades: recent.length, buys: recent.filter((r) => r.t.side === "buy").length, sells: recent.filter((r) => r.t.side === "sell").length, volume: sig(vol(recent)) },
    allTime: { trades: rows.length, volume: sig(vol(rows)) },
    notTracked: "liquidity depth, locks and price charts: DELPHI does not read those",
  };
}

/** The X-only tools, each answering with JSON. `aboutUs`: the question is about PANTHEON or PNTH. */
export function xTools(snap: Snapshot, onCall: (name: string, result: string) => void, opts: { aboutUs?: boolean } = {}) {
  const json =
    <I>(name: string, fn: (input: I) => unknown) =>
    (input: I) => {
      const out = JSON.stringify(fn(input));
      onCall(name, out);
      return out;
    };
  return [
    betaZodTool({
      name: "find_coin",
      description:
        "Find Ascend coins by $TICKER, name or token address. Each match has its verdict, trades, holders, launch time and how long ago it launched. Tickers repeat: when several coins share one, say so and ask for the address.",
      inputSchema: z.object({ query: z.string().min(1).max(64).describe("A ticker (with or without $), part of a name, or a 0x address") }),
      run: json("find_coin", (i: { query: string }) => findCoinTool(snap, i)),
    }),
    betaZodTool({
      name: "creator_history",
      description: "Other Ascend coins launched by the same creator or launch wallet, with their verdicts. Use it for 'has this dev launched before?'.",
      inputSchema: z.object({ token: z.string().describe("The coin's token address (0x…)") }),
      run: json("creator_history", (i: { token: string }) => creatorHistory(snap, i)),
    }),
    betaZodTool({
      name: "what_is_address",
      description:
        "Names an address DELPHI knows for sure (PANTHEON's staking or tap, Ascend's vault, launchpad or router, the testnet faucet, an Ascend coin, a creator). Call it before describing any contract that holds a big share. Unknown ones must not be guessed.",
      inputSchema: z.object({ address: z.string().describe("A 0x address from a tool result") }),
      run: json("what_is_address", (i: { address: string }) => whatIsAddress(snap, i, opts.aboutUs ?? false)),
    }),
    betaZodTool({
      name: "market",
      description:
        "A coin's last price, market cap (last price x 1B tokens), change since its first trade and over 24h, and its trades and volume in the last 24h and all time. Testnet prices are in test money. Liquidity and locks are not tracked.",
      inputSchema: z.object({ token: z.string().describe("The coin's token address (0x…)") }),
      run: json("market", (i: { token: string }) => market(snap, i)),
    }),
    betaZodTool({
      name: "delphi_status",
      description:
        "How fresh DELPHI's data is (when it was read, up to which block), how many coins it has checked by verdict, and what each check looks for. Use it for questions about DELPHI itself or when freshness matters.",
      inputSchema: z.object({}),
      run: json("delphi_status", () => delphiStatus(snap)),
    }),
  ];
}
