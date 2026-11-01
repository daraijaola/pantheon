// What a wallet holds of the coins DELPHI has read, across Ascend, Kalos and PerpMe. It asks the chain
// itself, in bundled balance reads, because the explorer's API has been behind a bot check since Oct 25.
// A coin that can't be read is listed as unread, never as "not held", and a read that fails altogether
// fails out loud: an empty list always means we read every coin and the wallet holds none of them.
// Coins DELPHI hasn't read aren't checked, and PNTH that's staked sits in the staking contract, not here.
import { erc20Abi, formatUnits, type Address, type PublicClient } from "viem";
import { Remembered } from "./remembered.ts";
import type { Coin } from "./verdicts.ts";

/** Balance reads per bundled request: well under Elysium's gas limit for one call. */
const CHUNK = 500;
const TTL_MS = 30_000;

export type Holding = Coin & {
  /** Raw amount, as a decimal string. */
  balance: string;
  decimals: number;
  /** The amount a person reads, e.g. "1250.5". */
  amount: string;
};

export type Holdings = {
  wallet: string;
  network: "testnet" | "mainnet";
  readAt: string;
  /** How many coins were asked about. */
  coinsChecked: number;
  holdings: Holding[];
  /** Coins that couldn't be read: unknown, not zero. */
  unread: string[];
};

/** The chain reads. Answers come in the order asked; null means that one coin couldn't be read. */
export type BalanceCalls = {
  balances(wallet: string, tokens: readonly string[]): Promise<Array<bigint | null>>;
  decimals(tokens: readonly string[]): Promise<Array<number | null>>;
};

export function chainBalances(client: Pick<PublicClient, "multicall">): BalanceCalls {
  /** One after the other, to go easy on the public node. A whole request failing throws. */
  async function inChunks<T>(tokens: readonly string[], functionName: "balanceOf" | "decimals", args: readonly [Address] | undefined): Promise<Array<T | null>> {
    const out: Array<T | null> = [];
    for (let i = 0; i < tokens.length; i += CHUNK) {
      const contracts = tokens.slice(i, i + CHUNK).map((t) => ({ address: t as Address, abi: erc20Abi, functionName, ...(args ? { args } : {}) }));
      // batchSize 0: one bundle is one request. By default viem splits it into many small ones at once,
      // and the public node refuses some, which marks coins it could have read as failed.
      const got = await client.multicall({ contracts: contracts as never[], allowFailure: true, batchSize: 0 });
      for (const r of got as Array<{ status: string; result?: unknown }>) out.push(r.status === "success" ? (r.result as T) : null);
    }
    return out;
  }
  return {
    balances: (wallet, tokens) => inChunks<bigint>(tokens, "balanceOf", [wallet as Address]),
    decimals: (tokens) => inChunks<number>(tokens, "decimals", undefined),
  };
}

/** Every coin to check a wallet against, or null if DELPHI's coins aren't loaded yet. */
type KnownCoins = () => { network: "testnet" | "mainnet"; coins: Coin[] } | null;

/** DELPHI's coins aren't loaded yet, so there's nothing to check a wallet against. */
export class NotReady extends Error {
  override name = "NotReady";
}

export class HoldingsReader {
  readonly #coins: KnownCoins;
  readonly #calls: BalanceCalls;
  readonly #now: () => number;
  readonly #remembered: Remembered<Holdings>;
  /** A coin's decimals never change. */
  readonly #decimals = new Map<string, number>();

  constructor(coins: KnownCoins, calls: BalanceCalls, opts: { now?: () => number; ttlMs?: number } = {}) {
    this.#coins = coins;
    this.#calls = calls;
    this.#now = opts.now ?? Date.now;
    this.#remembered = new Remembered((w) => this.#read(w), { ttlMs: opts.ttlMs ?? TTL_MS, now: this.#now });
  }

  read(wallet: string): Promise<Holdings> {
    return this.#remembered.get(wallet.toLowerCase());
  }

  async #read(wallet: string): Promise<Holdings> {
    const known = this.#coins();
    if (!known) throw new NotReady("no coins loaded yet");
    const { coins, network } = known;
    const balances = await this.#calls.balances(wallet, coins.map((c) => c.token));
    const held = coins.flatMap((coin, i) => (balances[i] ? [{ coin, balance: balances[i] }] : []));
    await this.#learnDecimals(held.map((h) => h.coin.token));

    const unread = coins.filter((_, i) => balances[i] === null).map((c) => c.token);
    const holdings: Holding[] = [];
    for (const { coin, balance } of held) {
      const decimals = this.#decimals.get(coin.token);
      if (decimals === undefined) unread.push(coin.token);
      else holdings.push({ ...coin, balance: balance.toString(), decimals, amount: formatUnits(balance, decimals) });
    }
    return { wallet, network, readAt: new Date(this.#now()).toISOString(), coinsChecked: coins.length, holdings, unread };
  }

  async #learnDecimals(tokens: readonly string[]) {
    const missing = tokens.filter((t) => !this.#decimals.has(t));
    if (!missing.length) return;
    const got = await this.#calls.decimals(missing);
    missing.forEach((t, i) => {
      const d = got[i];
      if (d !== null && d !== undefined) this.#decimals.set(t, d);
    });
  }
}
