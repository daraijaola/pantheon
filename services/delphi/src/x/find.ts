// Which coin a question is about. People tag DELPHI under a coin's post, paste its address, or write
// its $TICKER. Addresses are exact; tickers are chosen by creators and can repeat, so a ticker shared
// by several coins is "ambiguous", never a guess. With the "compare" feature, "$A vs $B" finds both.
import type { Workspace } from "../ai/workspace.ts";
import { fullText, type Post } from "./api.ts";

export type Found =
  | { kind: "coin"; token: string; how: "address" | "ticker"; where: string }
  | { kind: "ambiguous"; tokens: string[]; ticker: string; where: string }
  /** An address that is not an Ascend coin DELPHI has scanned (another token, a wallet, or too new). */
  | { kind: "unknown-address"; address: string; where: string }
  /** Two coins asked about together ("$A vs $B"): only with the "compare" feature. Both may be the same coin. */
  | { kind: "pair"; tokens: [string, string]; where: string }
  | { kind: "none" };

const lc = (a: string) => a.toLowerCase();
const ADDRESS = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;
const TICKER = /(?<![\w$])\$([A-Za-z][A-Za-z0-9.]{0,11})\b/g;

/** Addresses in a post: its text and the full links behind its t.co links. */
function addresses(p: Post): string[] {
  const urls = (p.entities?.urls ?? []).map((u) => u.expanded_url ?? u.url ?? "");
  return [...new Set([fullText(p), ...urls].flatMap((s) => s.match(ADDRESS) ?? []).map(lc))];
}

function tickers(p: Post): string[] {
  const tagged = (p.entities?.cashtags ?? []).map((c) => c.tag);
  const typed = [...fullText(p).matchAll(TICKER)].map((m) => m[1]!);
  return [...new Set([...tagged, ...typed].map((t) => t.toUpperCase()))];
}

/** Coins whose creator-chosen symbol is this ticker (case-insensitive). */
export function coinsByTicker(ws: Workspace, ticker: string): string[] {
  const t = ticker.replace(/^\$/, "").toUpperCase();
  return [...ws.reports.values()].filter((r) => (r.coin.symbol ?? "").toUpperCase() === t).map((r) => lc(r.coin.token));
}

/**
 * Looks through the posts in order (the question first, then the post it replies to, then what that
 * quotes, …) and stops at the first that names a coin. Our own tickers are skipped unless asked about.
 */
export function findCoin(ws: Workspace, posts: Array<{ post: Post; where: string }>, ignoreTickers: readonly string[] = []): Found {
  let unknown: Found | null = null;
  for (const { post, where } of posts) {
    const addrs = addresses(post);
    const coins = addrs.filter((a) => ws.coins.has(a));
    if (coins.length === 1) return { kind: "coin", token: coins[0]!, how: "address", where };
    if (coins.length > 1) return { kind: "ambiguous", tokens: coins, ticker: "", where };
    if (addrs.length && !unknown) unknown = { kind: "unknown-address", address: addrs[0]!, where };

    for (const t of tickers(post)) {
      if (ignoreTickers.includes(t)) continue;
      const hits = coinsByTicker(ws, t);
      if (hits.length === 1) return { kind: "coin", token: hits[0]!, how: "ticker", where };
      if (hits.length > 1) return { kind: "ambiguous", tokens: hits, ticker: t, where };
    }
  }
  return unknown ?? { kind: "none" };
}

/** What stands between two coins in a comparison: "$A vs $B", "$A vs. $B", "$A versus $B", "$A or $B?". */
const BETWEEN = /^[\s,]*(?:vs\.?|v\.?|versus|against|or|compared (?:to|with))[\s,]*$/i;

/**
 * "$A vs $B" in the question: two coins (by address or ticker) with "vs" between them. Both found: a
 * pair (the same coin twice is a pair of one coin, so she can say there is nothing to compare). A side
 * that is ambiguous or not an Ascend coin is returned as such. Anything else is not a comparison: null,
 * and findCoin decides as before.
 */
export function findPair(ws: Workspace, post: Post, where = "the question"): Found | null {
  const text = fullText(post);
  const refs = [
    ...[...text.matchAll(ADDRESS)].map((m) => ({ at: m.index, end: m.index + m[0].length, address: lc(m[0]), ticker: null })),
    ...[...text.matchAll(TICKER)].map((m) => ({ at: m.index, end: m.index + m[0].length, address: null, ticker: m[1]!.toUpperCase() })),
  ].sort((a, b) => a.at - b.at);
  for (let i = 0; i + 1 < refs.length; i++) {
    const [x, y] = [refs[i]!, refs[i + 1]!];
    if (!BETWEEN.test(text.slice(x.end, y.at))) continue;
    const sides: Found[] = [x, y].map((r): Found => {
      if (r.address) return ws.coins.has(r.address) ? { kind: "coin", token: r.address, how: "address", where } : { kind: "unknown-address", address: r.address, where };
      const hits = coinsByTicker(ws, r.ticker!);
      if (hits.length === 1) return { kind: "coin", token: hits[0]!, how: "ticker", where };
      return hits.length > 1 ? { kind: "ambiguous", tokens: hits, ticker: r.ticker!, where } : { kind: "none" };
    });
    const [a, b] = sides as [Found, Found];
    if (a.kind === "coin" && b.kind === "coin") return { kind: "pair", tokens: [a.token, b.token], where };
    return sides.find((f) => f.kind === "ambiguous") ?? sides.find((f) => f.kind === "unknown-address") ?? null;
  }
  return null;
}
