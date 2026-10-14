// What the indexer reads from Elysium: PANTHEON's contract events, turned into plain records, and a
// polite RPC client (same as the keeper's and DELPHI's: Elysium's public RPC rate-limits bursts).
import { createPublicClient, decodeEventLog, defineChain, http, parseAbi, type Address, type Hex, type PublicClient } from "viem";

export const routerAbi = parseAbi([
  "event Run(uint256 indexed runId, bool collected, bool claimedToken, bool claimedQuote, uint256 newToken, uint256 newQuote)",
  "event LegExecuted(uint256 indexed runId, uint8 indexed side, uint256 indexed leg, uint8 job, address to, uint256 amount)",
  "event LegDeferred(uint256 indexed runId, uint8 indexed side, uint256 indexed leg, uint256 amount)",
]);
export const vaultAbi = parseAbi([
  "event BasketBuy(address indexed token, uint256 quoteIn, uint256 tokensOut, uint160 emaSqrt, uint160 spotSqrt)",
  "event BasketSkip(address indexed token, uint8 reason)",
  "event Streamed(address indexed token, uint256 amount)",
]);
export const registryAbi = parseAbi([
  "struct Constituent { bytes32 poolId; address token; uint16 weightBps; uint128 perRunCap; }",
  "struct Proposal { uint64 eta; bool vetoed; bool executed; bytes32 scoreRoot; string methodologyURI; }",
  "event Proposed(uint256 indexed id, uint64 eta, bytes32 scoreRoot, string methodologyURI)",
  "event Vetoed(uint256 indexed id)",
  "event Executed(uint256 indexed id, uint256 count)",
  "function activeId() view returns (uint256)",
  "function proposalCount() view returns (uint256)",
  "function proposal(uint256 id) view returns (Proposal, Constituent[])",
]);
export const stakingAbi = parseAbi([
  "event Staked(address indexed account, uint256 amount)",
  "event UnstakeRequested(address indexed account, uint256 amount, uint64 coolEnd)",
  "event UnstakeCancelled(address indexed account, uint256 amount)",
  "event Withdrawn(address indexed account, uint256 amount)",
  "event Claimed(address indexed account, address indexed token, uint256 amount)",
  "event RewardNotified(address indexed token, uint256 amount, uint256 rate, uint64 finish)",
  "function totalStaked() view returns (uint256)",
  "function totalWorking() view returns (uint256)",
  "function rewardTokens() view returns (address[])",
]);
export const tokenAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);

/** CovenantRouter.Job and IndexVault.Skip, in contract order. */
export const JOBS = ["PAY", "BURN", "INDEX", "STREAM"] as const;
export const SKIPS = ["NONE", "NO_AVERAGE", "STALE_AVERAGE", "BREAKER", "PRICE_OUT_OF_BAND", "NOTHING_TO_SPEND"] as const;

/** One event, as the site will show it. Amounts are decimal strings in the token's smallest unit. */
export type Rec = { tx: Hex; block: number; logIndex: number; at?: number } & (
  | { kind: "run"; runId: string; newToken: string; newQuote: string }
  | { kind: "burn"; runId: string; amount: string }
  | { kind: "to-basket"; runId: string; amount: string }
  | { kind: "leg"; runId: string; job: string; side: "token" | "quote"; to: Address; amount: string }
  | { kind: "deferred"; runId: string; side: "token" | "quote"; amount: string }
  | { kind: "buy"; token: Address; quoteIn: string; tokensOut: string }
  | { kind: "skip"; token: Address; reason: (typeof SKIPS)[number] }
  | { kind: "stream"; token: Address; amount: string }
  | { kind: "proposed"; id: string; eta: number; scoreRoot: Hex; methodologyURI: string }
  | { kind: "vetoed"; id: string }
  | { kind: "executed"; id: string; count: number }
  | { kind: "stake"; account: Address; amount: string }
  | { kind: "unstake"; account: Address; amount: string; coolEnd: number }
  | { kind: "cancel-unstake"; account: Address; amount: string }
  | { kind: "withdraw"; account: Address; amount: string }
  | { kind: "claim"; account: Address; token: Address; amount: string }
  | { kind: "reward"; token: Address; amount: string; finish: number }
);
export type Kind = Rec["kind"];

export type Contracts = { router: Address; vault: Address; registry: Address; staking: Address };
type RawLog = { address: Address; topics: readonly Hex[]; data: Hex; transactionHash: Hex | null; blockNumber: bigint | null; logIndex: number | null };

const ABIS = { router: routerAbi, vault: vaultAbi, registry: registryAbi, staking: stakingAbi } as const;

/** Turns one log from our contracts into a record; anything else (or an event we don't show) is null. */
export function toRec(l: RawLog, c: Contracts): Rec | null {
  if (!l.transactionHash || l.blockNumber === null || l.logIndex === null || l.topics.length === 0) return null;
  const which = (Object.keys(ABIS) as Array<keyof Contracts>).find((k) => c[k].toLowerCase() === l.address.toLowerCase());
  if (!which) return null;
  let ev;
  try {
    ev = decodeEventLog({ abi: ABIS[which] as never, topics: l.topics as [Hex, ...Hex[]], data: l.data }) as unknown as { eventName: string; args: Record<string, unknown> };
  } catch {
    return null;
  }
  const base = { tx: l.transactionHash, block: Number(l.blockNumber), logIndex: l.logIndex };
  const a = ev.args;
  const s = (v: unknown) => (v as bigint).toString();
  const side = (v: unknown) => (Number(v) === 0 ? "token" : "quote") as "token" | "quote";
  switch (ev.eventName) {
    case "Run":
      return { ...base, kind: "run", runId: s(a.runId), newToken: s(a.newToken), newQuote: s(a.newQuote) };
    case "LegExecuted": {
      const job = JOBS[Number(a.job)] ?? "PAY";
      if (job === "BURN") return { ...base, kind: "burn", runId: s(a.runId), amount: s(a.amount) };
      if (job === "INDEX") return { ...base, kind: "to-basket", runId: s(a.runId), amount: s(a.amount) };
      return { ...base, kind: "leg", runId: s(a.runId), job, side: side(a.side), to: a.to as Address, amount: s(a.amount) };
    }
    case "LegDeferred":
      return { ...base, kind: "deferred", runId: s(a.runId), side: side(a.side), amount: s(a.amount) };
    case "BasketBuy":
      return { ...base, kind: "buy", token: a.token as Address, quoteIn: s(a.quoteIn), tokensOut: s(a.tokensOut) };
    case "BasketSkip":
      return { ...base, kind: "skip", token: a.token as Address, reason: SKIPS[Number(a.reason)] ?? "NONE" };
    case "Streamed":
      return { ...base, kind: "stream", token: a.token as Address, amount: s(a.amount) };
    case "Proposed":
      return { ...base, kind: "proposed", id: s(a.id), eta: Number(a.eta), scoreRoot: a.scoreRoot as Hex, methodologyURI: String(a.methodologyURI) };
    case "Vetoed":
      return { ...base, kind: "vetoed", id: s(a.id) };
    case "Executed":
      return { ...base, kind: "executed", id: s(a.id), count: Number(a.count) };
    case "Staked":
      return { ...base, kind: "stake", account: a.account as Address, amount: s(a.amount) };
    case "UnstakeRequested":
      return { ...base, kind: "unstake", account: a.account as Address, amount: s(a.amount), coolEnd: Number(a.coolEnd) };
    case "UnstakeCancelled":
      return { ...base, kind: "cancel-unstake", account: a.account as Address, amount: s(a.amount) };
    case "Withdrawn":
      return { ...base, kind: "withdraw", account: a.account as Address, amount: s(a.amount) };
    case "Claimed":
      return { ...base, kind: "claim", account: a.account as Address, token: a.token as Address, amount: s(a.amount) };
    case "RewardNotified":
      return { ...base, kind: "reward", token: a.token as Address, amount: s(a.amount), finish: Number(a.finish) };
    default:
      return null;
  }
}

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

/** A gap between RPC requests, and on a rate-limit answer (Conduit's -32017) a growing wait and a retry. */
export function politeFetch(opts: { minGapMs?: number; retries?: number; fetch?: typeof globalThis.fetch; sleep?: (ms: number) => Promise<void> } = {}): typeof globalThis.fetch {
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

export function makeClient(rpc: string): PublicClient {
  const chain = defineChain({
    id: 99_801,
    name: "Elysium testnet",
    nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
    contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
  });
  return createPublicClient({ chain, transport: http(rpc, { batch: false, retryCount: 3, timeout: 60_000, fetchFn: politeFetch() }) });
}
