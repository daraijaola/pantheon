// Where else a wallet has been: Hyperliquid itself, the big public chains, and its ENS name. All free, with
// no keys, and each source can fail on its own: a source that can't be read is listed as unread, never as
// "not used". Asking means telling those services this address, so it's off unless ELSEWHERE_READS is on.
// Only facts the page may show are kept. Dollar values and profit and loss are dropped as they're read,
// so they can't reach a page by accident. These are all mainnets: never add them to testnet numbers.
import { createPublicClient, formatEther, http, type Address } from "viem";
import { mainnet } from "viem/chains";
import { z } from "zod";
import { Remembered } from "./remembered.ts";

const TTL_MS = 5 * 60_000;
const TIMEOUT_MS = 5_000;
const HYPERLIQUID = "https://api.hyperliquid.xyz/info";
const ETHEREUM_RPC = "https://ethereum-rpc.publicnode.com";
/** Hyperliquid gives at most this many trades, newest first. */
const TRADES_CAP = 2000;

export type ChainInfo = { chain: string; chainId: number; symbol: string; rpc: string };
export const CHAINS: readonly ChainInfo[] = [
  { chain: "HyperEVM", chainId: 999, symbol: "HYPE", rpc: "https://rpc.hyperliquid.xyz/evm" },
  { chain: "Ethereum", chainId: 1, symbol: "ETH", rpc: ETHEREUM_RPC },
  { chain: "Arbitrum", chainId: 42161, symbol: "ETH", rpc: "https://arb1.arbitrum.io/rpc" },
  { chain: "Base", chainId: 8453, symbol: "ETH", rpc: "https://mainnet.base.org" },
  { chain: "Optimism", chainId: 10, symbol: "ETH", rpc: "https://mainnet.optimism.io" },
  { chain: "BNB Chain", chainId: 56, symbol: "BNB", rpc: "https://bsc-dataseed.binance.org" },
];

const Positions = z.object({ assetPositions: z.array(z.object({ position: z.object({ coin: z.string(), szi: z.string(), leverage: z.object({ value: z.number() }).optional() }) })) });
const Spot = z.object({ balances: z.array(z.object({ coin: z.string(), total: z.string() })) });
const Staked = z.object({ delegated: z.string(), undelegated: z.string(), totalPendingWithdrawal: z.string() });
const Trades = z.array(z.object({ coin: z.string(), time: z.number() }));

export type Hyperliquid = {
  network: "mainnet";
  openPositions: Array<{ coin: string; side: "long" | "short"; size: string; leverage: number | null }>;
  spot: Array<{ coin: string; amount: string }>;
  staked: { delegated: string; undelegated: string; pendingWithdrawal: string };
  trades: {
    count: number;
    /** Hyperliquid stopped at its limit: there are more, and `first` isn't the very first. */
    capped: boolean;
    coins: string[];
    first: string | null;
    last: string | null;
  };
};

export type OtherChain = { chain: string; chainId: number; network: "mainnet"; symbol: string; balance: string; txsSent: number };

export type Elsewhere = {
  wallet: string;
  readAt: string;
  /** Null if it couldn't be read. */
  hyperliquid: Hyperliquid | null;
  chains: OtherChain[];
  /** The name this wallet has set for itself on Ethereum. Null if it has none or it couldn't be read: see `unread`. */
  ensName: string | null;
  /** Sources that couldn't be read: unknown, not unused. */
  unread: string[];
  complete: boolean;
};

export type ElsewhereCalls = {
  hyperliquid(type: string, wallet: string): Promise<unknown>;
  rpc(url: string, method: string, params: unknown[]): Promise<string>;
  ensName(wallet: string): Promise<string | null>;
};

async function post(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  return res.json();
}

export function publicCalls(): ElsewhereCalls {
  const ethereum = createPublicClient({ chain: mainnet, transport: http(ETHEREUM_RPC, { timeout: TIMEOUT_MS, retryCount: 0 }) });
  return {
    hyperliquid: (type, user) => post(HYPERLIQUID, { type, user }),
    rpc: async (url, method, params) => {
      const { result } = z.object({ result: z.string() }).parse(await post(url, { jsonrpc: "2.0", id: 1, method, params }));
      return result;
    },
    ensName: (wallet) => ethereum.getEnsName({ address: wallet as Address }),
  };
}

const clean = (s: string, max: number) => [...s.replace(/[\p{Cc}\p{Cf}]/gu, " ")].slice(0, max).join("").trim();
const isZero = (s: string) => Number(s) === 0;

export class ElsewhereReader {
  readonly #calls: ElsewhereCalls;
  readonly #chains: readonly ChainInfo[];
  readonly #now: () => number;
  readonly #log: (msg: string) => void;
  readonly #remembered: Remembered<Elsewhere>;

  constructor(calls: ElsewhereCalls, opts: { chains?: readonly ChainInfo[]; now?: () => number; ttlMs?: number; log?: (msg: string) => void } = {}) {
    this.#calls = calls;
    this.#chains = opts.chains ?? CHAINS;
    this.#now = opts.now ?? Date.now;
    this.#log = opts.log ?? (() => {});
    this.#remembered = new Remembered((w) => this.#read(w), { ttlMs: opts.ttlMs ?? TTL_MS, now: this.#now });
  }

  read(wallet: string): Promise<Elsewhere> {
    return this.#remembered.get(wallet.toLowerCase());
  }

  async #hyperliquid(wallet: string): Promise<Hyperliquid> {
    const ask = (type: string) => this.#calls.hyperliquid(type, wallet);
    const [positions, spot, staked, trades] = await Promise.all([ask("clearinghouseState").then((r) => Positions.parse(r)), ask("spotClearinghouseState").then((r) => Spot.parse(r)), ask("delegatorSummary").then((r) => Staked.parse(r)), ask("userFills").then((r) => Trades.parse(r))]);
    const times = trades.map((t) => t.time);
    const stamp = (ms: number | undefined) => (ms === undefined ? null : new Date(ms).toISOString());
    return {
      network: "mainnet",
      openPositions: positions.assetPositions.flatMap(({ position: p }) => (isZero(p.szi) ? [] : [{ coin: clean(p.coin, 20), side: p.szi.startsWith("-") ? ("short" as const) : ("long" as const), size: p.szi.replace(/^-/, ""), leverage: p.leverage?.value ?? null }])),
      spot: spot.balances.filter((b) => !isZero(b.total)).map((b) => ({ coin: clean(b.coin, 20), amount: b.total })),
      staked: { delegated: staked.delegated, undelegated: staked.undelegated, pendingWithdrawal: staked.totalPendingWithdrawal },
      trades: { count: trades.length, capped: trades.length >= TRADES_CAP, coins: [...new Set(trades.map((t) => clean(t.coin, 20)))], first: stamp(times.length ? Math.min(...times) : undefined), last: stamp(times.length ? Math.max(...times) : undefined) },
    };
  }

  async #chain(c: ChainInfo, wallet: string): Promise<OtherChain> {
    const [balance, count] = await Promise.all([this.#calls.rpc(c.rpc, "eth_getBalance", [wallet, "latest"]), this.#calls.rpc(c.rpc, "eth_getTransactionCount", [wallet, "latest"])]);
    return { chain: c.chain, chainId: c.chainId, network: "mainnet", symbol: c.symbol, balance: formatEther(BigInt(balance)), txsSent: Number(BigInt(count)) };
  }

  async #read(wallet: string): Promise<Elsewhere> {
    const unread: string[] = [];
    const attempt = async <T>(source: string, work: Promise<T>): Promise<T | null> => {
      try {
        return await work;
      } catch (err) {
        this.#log(`can't read ${source}: ${(err as Error).message.split("\n")[0]}`);
        unread.push(source);
        return null;
      }
    };
    const [hyperliquid, ensName, ...chains] = await Promise.all([attempt("Hyperliquid", this.#hyperliquid(wallet)), attempt("ENS", this.#calls.ensName(wallet)), ...this.#chains.map((c) => attempt(c.chain, this.#chain(c, wallet)))]);
    return {
      wallet,
      readAt: new Date(this.#now()).toISOString(),
      hyperliquid,
      chains: chains.filter((c): c is OtherChain => c !== null),
      ensName: ensName ? clean(ensName, 64) : null,
      unread,
      complete: unread.length === 0,
    };
  }
}
