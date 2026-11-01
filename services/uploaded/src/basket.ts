// What the basket holds and has bought, and what a wallet has earned from it. The indexer already tracks
// the basket's buys and every claim with its transaction, so those come from there. What a wallet can
// claim right now comes from the staking contract, which is the only place that knows it. If the indexer
// is down the claimable part still answers and `complete` turns false, because "claimed" can't be read as 0.
import { erc20Abi, formatUnits, parseAbi, type Address, type PublicClient } from "viem";
import { requestFailed } from "./chain.ts";
import { z } from "zod";
import { NotReady } from "./holdings.ts";
import { Remembered } from "./remembered.ts";
import type { StakeReader } from "./stake.ts";
import type { CoinVerdict, UnknownCoin, Verdicts } from "./verdicts.ts";

const TTL_MS = 30_000;
const RECENT_BUYS = 20;
const RECENT_CLAIMS = 10;
/** Pages of 200 claims. Past this the total would be wrong, so the answer says it's incomplete. */
const MAX_PAGES = 25;

const IndexerAmount = z.object({ raw: z.string(), value: z.string(), symbol: z.string(), token: z.string() });
const Link = z.object({ tx: z.string(), url: z.string(), at: z.number().nullable() });
const BasketCoin = z.object({
  token: z.string(),
  symbol: z.string(),
  weightPct: z.number(),
  spent: IndexerAmount,
  bought: IndexerAmount,
  buys: z.number(),
  lastBuy: Link.nullable(),
});
const IndexerBasket = z.object({
  updatedAt: z.number().nullable(),
  active: z.object({ id: z.number(), coins: z.array(BasketCoin) }).nullable(),
});
const Buy = Link.extend({ coin: IndexerAmount, usdcIn: IndexerAmount });
const Claim = Link.extend({ amount: IndexerAmount });
const page = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item), next: z.string().nullable() });
type Buy = z.infer<typeof Buy>;
type Claim = z.infer<typeof Claim>;

export type IndexerCalls = {
  basket(): Promise<z.infer<typeof IndexerBasket>>;
  buys(limit: number): Promise<Buy[]>;
  /** Every claim by this wallet, newest first. `whole` is false if there were too many to read. */
  claims(wallet: string): Promise<{ claims: Claim[]; whole: boolean }>;
  /** When this wallet staked, in seconds. `whole` as above. */
  stakes(wallet: string): Promise<{ times: number[]; whole: boolean }>;
};

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export function indexerCalls(base: string, doFetch: Fetch = globalThis.fetch): IndexerCalls {
  async function get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const res = await doFetch(`${base}${path}`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new Error(`indexer answered ${res.status}`);
    return schema.parse(await res.json());
  }
  /** Every receipt of one kind for a wallet, page by page. */
  async function all<T>(kind: string, wallet: string, item: z.ZodType<T>): Promise<{ items: T[]; whole: boolean }> {
    const items: T[] = [];
    let before: string | null = null;
    for (let i = 0; i < MAX_PAGES; i++) {
      const got: { items: T[]; next: string | null } = await get(`/receipts?kind=${kind}&account=${wallet}&limit=200${before ? `&before=${before}` : ""}`, page(item));
      items.push(...got.items);
      before = got.next;
      if (!before) return { items, whole: true };
    }
    return { items, whole: false };
  }
  return {
    basket: () => get("/basket", IndexerBasket),
    buys: async (limit) => (await get(`/receipts?kind=buy&limit=${limit}`, page(Buy))).items,
    claims: async (wallet) => {
      const { items, whole } = await all("claim", wallet, Claim);
      return { claims: items, whole };
    },
    stakes: async (wallet) => {
      const { items, whole } = await all("stake", wallet, Link);
      return { times: items.flatMap((s) => (s.at === null ? [] : [s.at])), whole };
    },
  };
}

const rewardsAbi = parseAbi([
  "function rewardTokens() view returns (address[])",
  "function retiredTokens() view returns (address[])",
  "function earned(address token, address account) view returns (uint256)",
]);

/** The chain reads. Answers come in the order asked; null means that one couldn't be read. */
export type RewardCalls = {
  /** Every coin the staking contract streams now or has retired. */
  tokens(): Promise<string[]>;
  earned(wallet: string, tokens: readonly string[]): Promise<Array<bigint | null>>;
  meta(tokens: readonly string[]): Promise<Array<{ symbol: string; decimals: number } | null>>;
};

export function chainRewards(client: Pick<PublicClient, "multicall">, staking: string): RewardCalls {
  const address = staking as Address;
  return {
    tokens: async () => {
      // The contract on testnet predates retiredTokens, so that one is allowed to fail.
      const [live, retired] = await client.multicall({
        allowFailure: true,
        batchSize: 0,
        contracts: [
          { address, abi: rewardsAbi, functionName: "rewardTokens" },
          { address, abi: rewardsAbi, functionName: "retiredTokens" },
        ],
      });
      if (live.status !== "success") throw new Error("staking contract couldn't be read");
      return [...new Set([...live.result, ...(retired.status === "success" ? retired.result : [])].map((t) => t.toLowerCase()))];
    },
    earned: async (wallet, tokens) => {
      const contracts = tokens.map((t) => ({ address, abi: rewardsAbi, functionName: "earned" as const, args: [t as Address, wallet as Address] as const }));
      const got = await client.multicall({ contracts, allowFailure: true, batchSize: 0 });
      if (got.some((r) => r.status !== "success" && requestFailed(r.error))) throw new Error("the node didn't answer");
      return got.map((r) => (r.status === "success" ? r.result : null));
    },
    meta: async (tokens) => {
      const contracts = tokens.flatMap((t) => [
        { address: t as Address, abi: erc20Abi, functionName: "symbol" as const },
        { address: t as Address, abi: erc20Abi, functionName: "decimals" as const },
      ]);
      const got = await client.multicall({ contracts, allowFailure: true, batchSize: 0 });
      return tokens.map((_, i) => {
        const [s, d] = [got[i * 2]!, got[i * 2 + 1]!];
        return s.status === "success" && d.status === "success" ? { symbol: s.result as string, decimals: d.result as number } : null;
      });
    },
  };
}

type Amount = { raw: string; amount: string };
const amountOf = (raw: bigint, decimals: number): Amount => ({ raw: raw.toString(), amount: formatUnits(raw, decimals) });
const lc = (a: string) => a.toLowerCase();

export type RewardCoin = {
  token: string;
  symbol: string;
  /** What the wallet can claim now. */
  claimable: Amount;
  /** Claimed so far. Null if the indexer couldn't be read. */
  claimed: Amount | null;
  /** Both together. Null if the indexer couldn't be read. */
  earned: Amount | null;
  /** DELPHI's verdict. Null for USDC, which isn't a coin it judges. */
  verdict: CoinVerdict["verdict"] | UnknownCoin["verdict"] | null;
};

export type WalletRewards = {
  wallet: string;
  network: "testnet" | "mainnet";
  readAt: string;
  coins: RewardCoin[];
  recentClaims: Array<{ token: string; symbol: string; amount: string; tx: string; url: string; at: string | null }>;
  /** The Passport multiplier on this wallet's stake, e.g. 1.2. */
  passportBoost: number;
  /** Coins that couldn't be read: unknown, not zero. */
  unread: string[];
  /** False if a coin or the claim history couldn't be read. */
  complete: boolean;
};

export type BasketNow = {
  updatedAt: string | null;
  proposal: number | null;
  coins: Array<{
    token: string;
    symbol: string;
    weightPct: number;
    bought: Amount;
    /** USDC spent on it so far. */
    spent: Amount;
    buys: number;
    lastBuy: { tx: string; url: string; at: string | null } | null;
    verdict: CoinVerdict["verdict"] | UnknownCoin["verdict"];
    reason: string;
    disputeUrl: string | null;
  }>;
  recentBuys: Array<{ token: string; symbol: string; bought: string; usdcIn: string; tx: string; url: string; at: string | null }>;
};

const when = (at: number | null) => (at === null ? null : new Date(at * 1000).toISOString());
const fromIndexer = (a: z.infer<typeof IndexerAmount>): Amount => ({ raw: a.raw, amount: a.value });

export class BasketReader {
  readonly #verdicts: Pick<Verdicts, "get" | "health">;
  readonly #stake: Pick<StakeReader, "read">;
  readonly #indexer: IndexerCalls;
  readonly #rewards: RewardCalls;
  readonly #usdc: string;
  readonly #now: () => number;
  readonly #basket: Remembered<BasketNow>;
  readonly #wallets: Remembered<WalletRewards>;
  readonly #meta = new Map<string, { symbol: string; decimals: number }>();

  constructor(deps: { verdicts: Pick<Verdicts, "get" | "health">; stake: Pick<StakeReader, "read">; indexer: IndexerCalls; rewards: RewardCalls; usdc: string; now?: () => number; ttlMs?: number }) {
    this.#verdicts = deps.verdicts;
    this.#stake = deps.stake;
    this.#indexer = deps.indexer;
    this.#rewards = deps.rewards;
    this.#usdc = lc(deps.usdc);
    this.#now = deps.now ?? Date.now;
    const remember = { ttlMs: deps.ttlMs ?? TTL_MS, now: this.#now };
    this.#basket = new Remembered(() => this.#readBasket(), remember);
    this.#wallets = new Remembered((w) => this.#readWallet(w), remember);
  }

  basket(): Promise<BasketNow> {
    return this.#basket.get("basket");
  }

  read(wallet: string): Promise<WalletRewards> {
    return this.#wallets.get(wallet.toLowerCase());
  }

  async #readBasket(): Promise<BasketNow> {
    const [b, buys] = await Promise.all([this.#indexer.basket(), this.#indexer.buys(RECENT_BUYS)]);
    return {
      updatedAt: when(b.updatedAt),
      proposal: b.active?.id ?? null,
      coins: (b.active?.coins ?? []).map((c) => {
        const v = this.#verdicts.get(c.token);
        return {
          token: lc(c.token),
          symbol: c.symbol,
          weightPct: c.weightPct,
          bought: fromIndexer(c.bought),
          spent: fromIndexer(c.spent),
          buys: c.buys,
          lastBuy: c.lastBuy ? { tx: c.lastBuy.tx, url: c.lastBuy.url, at: when(c.lastBuy.at) } : null,
          verdict: v.verdict,
          reason: v.reason,
          disputeUrl: v.known ? v.disputeUrl : null,
        };
      }),
      recentBuys: buys.map((b2) => ({ token: lc(b2.coin.token), symbol: b2.coin.symbol, bought: b2.coin.value, usdcIn: b2.usdcIn.value, tx: b2.tx, url: b2.url, at: when(b2.at) })),
    };
  }

  async #readWallet(wallet: string): Promise<WalletRewards> {
    const { network } = this.#verdicts.health();
    if (!network) throw new NotReady("no coins loaded yet");
    const [chainTokens, stake, history] = await Promise.all([
      this.#rewards.tokens(),
      this.#stake.read(wallet),
      this.#indexer.claims(wallet).catch(() => null),
    ]);
    const claimed = new Map<string, bigint>();
    for (const c of history?.claims ?? []) claimed.set(lc(c.amount.token), (claimed.get(lc(c.amount.token)) ?? 0n) + BigInt(c.amount.raw));

    // Coins claimed once may have left the contract's list, so they're asked about too.
    const tokens = [...new Set([...chainTokens, ...claimed.keys()])];
    const earned = await this.#rewards.earned(wallet, tokens);
    const worth = tokens.filter((t, i) => (earned[i] ?? 0n) > 0n || claimed.has(t));
    await this.#learnMeta(worth);

    const unread = tokens.filter((_, i) => earned[i] === null);
    const coins: RewardCoin[] = [];
    for (const token of worth) {
      const claimable = earned[tokens.indexOf(token)];
      const meta = this.#meta.get(token);
      if (claimable === null || claimable === undefined || !meta) {
        if (!unread.includes(token)) unread.push(token);
        continue;
      }
      const done = claimed.get(token) ?? 0n;
      coins.push({
        token,
        symbol: meta.symbol,
        claimable: amountOf(claimable, meta.decimals),
        claimed: history ? amountOf(done, meta.decimals) : null,
        earned: history ? amountOf(done + claimable, meta.decimals) : null,
        verdict: token === this.#usdc ? null : this.#verdicts.get(token).verdict,
      });
    }
    coins.sort((a, b) => (BigInt(b.claimable.raw) > BigInt(a.claimable.raw) ? 1 : BigInt(b.claimable.raw) < BigInt(a.claimable.raw) ? -1 : 0));
    return {
      wallet,
      network,
      readAt: new Date(this.#now()).toISOString(),
      coins,
      recentClaims: (history?.claims ?? []).slice(0, RECENT_CLAIMS).map((c) => ({ token: lc(c.amount.token), symbol: c.amount.symbol, amount: c.amount.value, tx: c.tx, url: c.url, at: when(c.at) })),
      passportBoost: stake.passportBoost,
      unread,
      complete: unread.length === 0 && !!history?.whole,
    };
  }

  async #learnMeta(tokens: readonly string[]) {
    const missing = tokens.filter((t) => !this.#meta.has(t));
    if (!missing.length) return;
    const got = await this.#rewards.meta(missing);
    missing.forEach((t, i) => {
      const m = got[i];
      if (m) this.#meta.set(t, m);
    });
  }
}
