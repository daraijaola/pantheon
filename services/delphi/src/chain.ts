// Reads Elysium over plain JSON-RPC: Ascend launches, swaps and token transfers (cached, resumable),
// plus who sent each transaction, block times, what kind of thing an address is, and coin names.
import {
  AbiDecodingDataSizeTooSmallError,
  AbiDecodingZeroDataError,
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  createPublicClient,
  defineChain,
  getAddress,
  http,
  numberToHex,
  parseAbi,
  parseAbiItem,
  toEventSelector,
  type AbiEvent,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import type { RawLog, Store } from "./store.ts";

export const LAUNCHED = parseAbiItem(
  "event Launched(bytes32 indexed poolId, address indexed token, address indexed creator, address quote, uint256 supplySeeded, uint256 devBuyTokens)",
);
/** CLPoolManager Swap. Amounts are the swapper's side: positive = the swapper received it. Checked live. */
export const SWAP = parseAbiItem(
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee, uint16 protocolFee)",
);
export const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
/** Every pool created on the pool manager, Ascend's (hook = launchpad) and anyone else's. */
export const INITIALIZE = parseAbiItem(
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, address hooks, uint24 fee, bytes32 parameters, uint160 sqrtPriceX96, int24 tick)",
);

const LAUNCHPAD_ABI = parseAbi([
  "function vault() view returns (address)",
  "function poolManager() view returns (address)",
  "function treasury() view returns (address)",
  "function opexTreasury() view returns (address)",
  "function ecosystemTreasury() view returns (address)",
  "function stakerYieldTreasury() view returns (address)",
  "function kntqTreasury() view returns (address)",
  "function cohortTreasury() view returns (address)",
  "function inventoryTreasury() view returns (address)",
  "function listingDesk() view returns (address)",
]);
const PAIR_ABI = parseAbi(["function token0() view returns (address)", "function token1() view returns (address)"]);
const META_ABI = parseAbi(["function name() view returns (string)", "function symbol() view returns (string)"]);

/** JSON-RPC "slow down" codes: standard, 429-in-body, QuickNode, and Conduit's (Elysium's public RPC, seen live). */
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

/** The JSON-RPC method names in a request body, for logs (e.g. "eth_getLogs" or "eth_call×20"). */
function methodsOf(body: unknown): string {
  try {
    const parsed: unknown = JSON.parse(String(body));
    const names = (Array.isArray(parsed) ? parsed : [parsed]).map((m) => String((m as { method?: unknown }).method));
    return [...new Set(names)].map((n) => `${n}${names.length > 1 ? `×${names.filter((x) => x === n).length}` : ""}`).join(", ");
  } catch {
    return "?";
  }
}

/**
 * A fetch for the public RPC that keeps a gap between requests, and on a rate-limit answer waits
 * (2 s, 4 s, … up to a minute) and tries again instead of failing the whole scan. Measured live:
 * Conduit lets only about 4 to 7 calls through in a burst and refuses the rest of a batch one by
 * one, so requests go out singly (no JSON-RPC batches) at about 6 a second.
 */
export function politeFetch(opts: {
  minGapMs?: number;
  retries?: number;
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
  onWait?: (ms: number, methods: string) => void;
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
        const ms = Math.min(60_000, 2_000 * 2 ** attempt);
        opts.onWait?.(ms, methodsOf(init?.body));
        await sleep(ms);
        continue;
      }
      return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
    }
  };
}

export function makeClient(rpc: string, onWait?: (ms: number, methods: string) => void): PublicClient {
  const chain = defineChain({
    id: 99_801,
    name: "Elysium testnet",
    nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  });
  return createPublicClient({
    chain,
    transport: http(rpc, { batch: false, retryCount: 3, timeout: 60_000, fetchFn: politeFetch({ onWait }) }),
  });
}

/** Runs `fn` over `items`, at most `limit` at a time, keeping order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** The launchpad's own addresses: its vault, pool manager, treasuries and ListingDesk. */
export async function launchpadAddresses(client: PublicClient, launchpad: Address) {
  const names = LAUNCHPAD_ABI.map((f) => f.name);
  const values = await Promise.all(names.map((functionName) => client.readContract({ address: launchpad, abi: LAUNCHPAD_ABI, functionName })));
  return Object.fromEntries(names.map((n, i) => [n, getAddress(values[i]!)])) as Record<(typeof names)[number], Address>;
}

type RpcLog = { blockNumber: Hex; logIndex: Hex; transactionHash: Hex; address: Hex; topics: Hex[]; data: Hex; removed?: boolean };

/**
 * Fetches one event stream from the cursor up to `to`, in block ranges that shrink when the node
 * refuses a range and grow back when it does not. Each range is saved with its cursor, so an
 * interrupted scan resumes where it stopped.
 */
export async function scanLogs(
  client: PublicClient,
  store: Store,
  stream: string,
  q: { address: Address | Address[]; event: AbiEvent; from: bigint; to: bigint },
  onProgress?: (at: bigint, found: number) => void,
): Promise<number> {
  let from = store.cursor(stream, q.from);
  let step = 1_000_000n;
  let found = 0;
  const topic = toEventSelector(q.event);
  while (from <= q.to) {
    const end = from + step - 1n < q.to ? from + step - 1n : q.to;
    let logs: RpcLog[];
    try {
      logs = (await client.request({
        method: "eth_getLogs",
        params: [{ address: q.address, topics: [topic], fromBlock: numberToHex(from), toBlock: numberToHex(end) }],
      })) as RpcLog[];
    } catch (err) {
      if (step <= 1_000n) throw err;
      step /= 4n;
      continue;
    }
    const raw: RawLog[] = logs
      .filter((l) => !l.removed)
      .map((l) => ({ block: BigInt(l.blockNumber), logIndex: Number(l.logIndex), tx: l.transactionHash, address: l.address, topics: l.topics, data: l.data }));
    store.saveLogs(stream, raw, end + 1n);
    found += raw.length;
    onProgress?.(end, found);
    from = end + 1n;
    if (step < 1_000_000n) step *= 2n;
  }
  return found;
}

/** Remembered lookups: ask the node only for what the cache does not know yet. */
async function memoized<K extends string, V>(
  store: Store,
  kind: string,
  keys: Iterable<K>,
  fetch: (k: K) => Promise<V>,
  limit = 16,
): Promise<Map<K, V>> {
  const out = new Map<K, V>();
  const todo: K[] = [];
  for (const k of new Set(keys)) {
    const hit = store.recall<V>(kind, k);
    if (hit === undefined) todo.push(k);
    else out.set(k, hit);
  }
  const got = await mapLimit(todo, limit, fetch);
  todo.forEach((k, i) => {
    store.remember(kind, k, got[i]);
    out.set(k, got[i]!);
  });
  return out;
}

/** tx hash → the wallet that sent it (the real trader; the swap's own `sender` is a router). */
export function txSenders(client: PublicClient, store: Store, txs: Iterable<Hex>) {
  return memoized(store, "txfrom", txs, async (hash) => getAddress((await client.getTransaction({ hash })).from));
}

/**
 * Which contract a transaction called, the function's 4-byte selector ("0x" for a plain transfer), and
 * the HYPE the sender put in (wei, decimal string).
 */
export type TxCall = { to: string | null; selector: string; value: string };

/** tx hash → what it called, to tell a multi-send (the sender's own HYPE) from a sale or a game payout. */
export function txCalls(client: PublicClient, store: Store, txs: Iterable<Hex>) {
  return memoized(store, "txcall", txs, async (hash): Promise<TxCall> => {
    const t = await client.getTransaction({ hash });
    return { to: t.to ? t.to.toLowerCase() : null, selector: t.input.slice(0, 10).toLowerCase(), value: t.value.toString() };
  });
}

/** block number (decimal string) → unix time. */
export function blockTimes(client: PublicClient, store: Store, blocks: Iterable<string>) {
  return memoized(store, "blocktime", blocks, async (b) => Number((await client.getBlock({ blockNumber: BigInt(b) })).timestamp));
}

/**
 * The contract answered "no" (reverted, or returned nothing usable). Anything else, such as a
 * timeout or a rate limit, is an outage and must not be remembered as an answer.
 */
export function isRevert(err: unknown): boolean {
  return (
    err instanceof BaseError &&
    err.walk(
      (e) =>
        e instanceof ContractFunctionRevertedError ||
        e instanceof ContractFunctionZeroDataError ||
        e instanceof AbiDecodingZeroDataError ||
        e instanceof AbiDecodingDataSizeTooSmallError,
    ) !== null
  );
}

export type AddressKind = "wallet" | "pool" | "contract";

/**
 * Wallet, outside trading pool, or other contract. A wallet with an EIP-7702 delegation has code
 * too (0xef0100…), but it is still a wallet. A contract that answers token0() and token1() is a pool.
 */
export function addressKinds(client: PublicClient, store: Store, addresses: Iterable<string>) {
  return memoized(store, "kind", [...addresses].map((a) => a.toLowerCase()), async (a): Promise<AddressKind> => {
    const address = getAddress(a);
    const code = (await client.getCode({ address })) ?? "0x";
    if (code === "0x" || code.startsWith("0xef0100")) return "wallet";
    try {
      await Promise.all(PAIR_ABI.map((f) => client.readContract({ address, abi: PAIR_ABI, functionName: f.name })));
      return "pool";
    } catch (err) {
      if (isRevert(err)) return "contract";
      throw err;
    }
  });
}

/** Coin names and symbols, as their creators set them (untrusted text). */
export function tokenMeta(client: PublicClient, store: Store, tokens: Iterable<string>) {
  return memoized(store, "meta", [...tokens].map((t) => t.toLowerCase()), async (t) => {
    const read = (functionName: "name" | "symbol") =>
      client.readContract({ address: getAddress(t), abi: META_ABI, functionName }).catch((err: unknown) => {
        if (isRevert(err)) return null;
        throw err;
      });
    const [name, symbol] = await Promise.all([read("name"), read("symbol")]);
    return { name, symbol };
  });
}
