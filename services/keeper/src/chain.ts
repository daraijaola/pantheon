// Elysium access for the keeper: contract interfaces, a polite RPC client, and decoding of the events
// a simulated or sent call emits.
import { createPublicClient, decodeEventLog, defineChain, http, parseAbi, type Address, type Hex, type PublicClient } from "viem";

export const routerAbi = parseAbi([
  "function run() returns (uint256 newToken, uint256 newQuote)",
  "event Run(uint256 indexed runId, bool collected, bool claimedToken, bool claimedQuote, uint256 newToken, uint256 newQuote)",
  "event LegExecuted(uint256 indexed runId, uint8 indexed side, uint256 indexed leg, uint8 job, address to, uint256 amount)",
  "event LegDeferred(uint256 indexed runId, uint8 indexed side, uint256 indexed leg, uint256 amount)",
]);
export const vaultAbi = parseAbi([
  "function rebalance(uint256 k)",
  "event BasketBuy(address indexed token, uint256 quoteIn, uint256 tokensOut, uint160 emaSqrt, uint160 spotSqrt)",
  "event BasketSkip(address indexed token, uint8 reason)",
  "event Streamed(address indexed token, uint256 amount)",
]);
export const registryAbi = parseAbi([
  "struct Constituent { bytes32 poolId; address token; uint16 weightBps; uint128 perRunCap; }",
  "function active() view returns (Constituent[])",
]);
export const stakingAbi = parseAbi([
  "function poke(address[] list)",
  "function accounts(address) view returns (uint256 staked, uint256 cooling, uint256 working, uint64 coolEnd, uint64 stakeStart)",
  "function workingOf(address account) view returns (uint256)",
  "event Staked(address indexed account, uint256 amount)",
  "event Poked(address indexed account, uint256 working)",
  "event RewardNotified(address indexed token, uint256 amount, uint256 rate, uint64 finish)",
]);
export const erc20Abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);

/** CovenantRouter.Job and IndexVault.Skip, in contract order. */
export const JOBS = ["PAY", "BURN", "INDEX", "STREAM"] as const;
export const SKIPS = ["NONE", "NO_AVERAGE", "STALE_AVERAGE", "BREAKER", "PRICE_OUT_OF_BAND", "NOTHING_TO_SPEND"] as const;

/** What one call did (or would do), read from its events. */
export type Effects = {
  run?: { newToken: bigint; newQuote: bigint };
  legs: Array<{ side: "token" | "quote"; job: (typeof JOBS)[number]; to: Address; amount: bigint }>;
  deferred: Array<{ side: "token" | "quote"; amount: bigint }>;
  buys: Array<{ token: Address; quoteIn: bigint; tokensOut: bigint }>;
  skips: Array<{ token: Address; reason: (typeof SKIPS)[number] }>;
  streamed: Array<{ token: Address; amount: bigint }>;
  poked: Array<{ account: Address; working: bigint }>;
};

const ALL = [...routerAbi, ...vaultAbi, ...stakingAbi];

/** Decodes the keeper-relevant events in a call's logs; anything else (Ascend's own, transfers) is ignored. */
export function effectsOf(logs: ReadonlyArray<{ address: Address; topics: readonly Hex[]; data: Hex }>, from: { router: Address; vault: Address; staking: Address }): Effects {
  const out: Effects = { legs: [], deferred: [], buys: [], skips: [], streamed: [], poked: [] };
  const ours = new Set([from.router, from.vault, from.staking].map((a) => a.toLowerCase()));
  for (const l of logs) {
    if (!ours.has(l.address.toLowerCase()) || l.topics.length === 0) continue;
    let ev;
    try {
      ev = decodeEventLog({ abi: ALL, topics: l.topics as [Hex, ...Hex[]], data: l.data });
    } catch {
      continue; // an event of ours the keeper doesn't need (e.g. RewardNotified)
    }
    const side = (s: number) => (s === 0 ? "token" : "quote") as "token" | "quote";
    switch (ev.eventName) {
      case "Run":
        out.run = { newToken: ev.args.newToken, newQuote: ev.args.newQuote };
        break;
      case "LegExecuted":
        out.legs.push({ side: side(ev.args.side), job: JOBS[ev.args.job] ?? "PAY", to: ev.args.to, amount: ev.args.amount });
        break;
      case "LegDeferred":
        out.deferred.push({ side: side(ev.args.side), amount: ev.args.amount });
        break;
      case "BasketBuy":
        out.buys.push({ token: ev.args.token, quoteIn: ev.args.quoteIn, tokensOut: ev.args.tokensOut });
        break;
      case "BasketSkip":
        out.skips.push({ token: ev.args.token, reason: SKIPS[ev.args.reason] ?? "NONE" });
        break;
      case "Streamed":
        out.streamed.push({ token: ev.args.token, amount: ev.args.amount });
        break;
      case "Poked":
        out.poked.push({ account: ev.args.account, working: ev.args.working });
        break;
    }
  }
  return out;
}

/** JSON-RPC "slow down" codes: standard, 429-in-body, QuickNode's, and Conduit's (Elysium's public RPC). */
const RATE_LIMIT_CODES = new Set([-32005, 429, -32007, -32017]);

function isRateLimited(status: number, body: string): boolean {
  if (status === 429) return true;
  try {
    const parsed: unknown = JSON.parse(body);
    return (Array.isArray(parsed) ? parsed : [parsed]).some((m) => {
      const e = (m as { error?: { code?: unknown; message?: unknown } } | null)?.error;
      return !!e && (RATE_LIMIT_CODES.has(e.code as number) || /rate limit/i.test(String(e.message)));
    });
  } catch {
    return false;
  }
}

/**
 * A fetch for the public RPC (same as DELPHI's): a gap between requests, and on a rate-limit answer
 * a wait of 2 s, 4 s, … (up to a minute) before trying again. Elysium's RPC lets only a few calls
 * through per burst, so requests go out singly.
 */
export function politeFetch(opts: {
  minGapMs?: number;
  retries?: number;
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
} = {}): typeof globalThis.fetch {
  const gap = opts.minGapMs ?? 150;
  const retries = opts.retries ?? 6;
  const doFetch = opts.fetch ?? globalThis.fetch;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  let nextSlot = 0;
  return async (input, init) => {
    for (let attempt = 0; ; attempt++) {
      const now = Date.now();
      const wait = Math.max(0, nextSlot - now);
      nextSlot = Math.max(now, nextSlot) + gap;
      if (wait > 0) await sleep(wait);
      const res = await doFetch(input, init);
      const body = await res.text();
      if (attempt < retries && isRateLimited(res.status, body)) {
        await sleep(Math.min(60_000, 2_000 * 2 ** attempt));
        continue;
      }
      return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
    }
  };
}

export const elysium = (rpc: string) =>
  defineChain({
    id: 99_801,
    name: "Elysium testnet",
    nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
    contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
  });

export function makeClient(rpc: string): PublicClient {
  return createPublicClient({
    chain: elysium(rpc),
    transport: http(rpc, { batch: false, retryCount: 3, timeout: 60_000, fetchFn: politeFetch() }),
  });
}
