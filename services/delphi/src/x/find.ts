// Which coin a question is about. People tag DELPHI under a coin's post, paste its address, or write
// its $TICKER. Addresses are exact; tickers are chosen by creators and can repeat, so a ticker shared
// by several coins is "ambiguous", never a guess.
import type { Workspace } from "../ai/workspace.ts";
import { fullText, type Post } from "./api.ts";

export type Found =
  | { kind: "coin"; token: string; how: "address" | "ticker"; where: string }
  | { kind: "ambiguous"; tokens: string[]; ticker: string; where: string }
  /** An address that is not an Ascend coin DELPHI has scanned (another token, a wallet, or too new). */
  | { kind: "unknown-address"; address: string; where: string }
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
