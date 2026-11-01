// A wallet's story so far: its first day on Elysium, how many transactions it has sent, its HYPE, and
// the coins it launched. The chain can't say when a wallet started, but it can say what any wallet had
// at any past block, so the first block where it had HYPE or had sent anything is found by searching
// (the idea behind DELPHI's funding lookup). Every trip to the node takes about 400 ms, so that search takes
// a few seconds while the rest takes half of one, which is why the two can be asked for separately. Who
// funded the wallet is deliberately not read: funders are never shown. A wallet that only ever received
// tokens has no first day here.
import { formatEther, type Address, type PublicClient } from "viem";
import { NotReady } from "./holdings.ts";
import { Remembered } from "./remembered.ts";
import type { CoinVerdict } from "./verdicts.ts";

/** How many points each step of the search checks: 2 reads each, so 96 fit in one batched request. */
const WIDTH = 48;
const TTL_MS = 60_000;

/** The first block where the wallet had HYPE or had sent a transaction. */
export type FirstSeen = { block: string; time: string };

/** The quick part of a wallet's history. */
export type WalletNow = {
  wallet: string;
  network: "testnet" | "mainnet";
  readAt: string;
  txsSent: number;
  /** HYPE held now, as a person reads it. */
  hype: string;
  coinsLaunched: Array<Pick<CoinVerdict, "token" | "symbol" | "venue" | "verdict" | "reason" | "disputeUrl">>;
};

export type WalletHistory = WalletNow & {
  /** Null if the wallet has never had HYPE or sent anything. */
  firstSeen: FirstSeen | null;
};

/** The chain reads. An address that's never active gives false at every block. */
export type HistoryCalls = {
  head(): Promise<bigint>;
  /** Whether the wallet had HYPE or had sent anything by each block, in the order asked. */
  activeAt(wallet: string, blocks: readonly bigint[]): Promise<boolean[]>;
  blockTime(block: bigint): Promise<number>;
  now(wallet: string): Promise<{ hype: bigint; txsSent: number }>;
};

export function chainHistory(client: Pick<PublicClient, "getBlockNumber" | "getBalance" | "getTransactionCount" | "getBlock">): HistoryCalls {
  return {
    head: () => client.getBlockNumber(),
    activeAt: (wallet, blocks) =>
      Promise.all(
        blocks.map(async (blockNumber) => {
          const address = wallet as Address;
          const [hype, sent] = await Promise.all([client.getBalance({ address, blockNumber }), client.getTransactionCount({ address, blockNumber })]);
          return hype > 0n || sent > 0;
        }),
      ),
    blockTime: async (blockNumber) => Number((await client.getBlock({ blockNumber })).timestamp),
    now: async (wallet) => {
      const address = wallet as Address;
      const [hype, txsSent] = await Promise.all([client.getBalance({ address }), client.getTransactionCount({ address })]);
      return { hype, txsSent };
    },
  };
}

/** The first active block at or before `head`, which must be active. */
export async function firstActiveBlock(calls: Pick<HistoryCalls, "activeAt">, wallet: string, head: bigint): Promise<bigint> {
  let before = -1n; // known inactive (block -1 can't be active)
  let at = head; // known active
  while (at - before > 1n) {
    const gap = at - before;
    const points = [...new Set(Array.from({ length: WIDTH }, (_, i) => before + (gap * BigInt(i + 1)) / BigInt(WIDTH + 1)))].filter((p) => p > before && p < at);
    const active = await calls.activeAt(wallet, points);
    const first = active.indexOf(true);
    if (first === -1) before = points.at(-1)!;
    else {
      at = points[first]!;
      if (first > 0) before = points[first - 1]!;
    }
  }
  return at;
}

type CoinFacts = { launchedBy(wallet: string): CoinVerdict[]; health(): { network: "testnet" | "mainnet" | null } };

export class HistoryReader {
  readonly #verdicts: CoinFacts;
  readonly #calls: HistoryCalls;
  readonly #now: () => number;
  readonly #quick: Remembered<WalletNow>;
  readonly #firstDay: Remembered<FirstSeen | null>;
  /** A first day never changes once found. */
  readonly #first = new Map<string, FirstSeen>();

  constructor(verdicts: CoinFacts, calls: HistoryCalls, opts: { now?: () => number; ttlMs?: number } = {}) {
    this.#verdicts = verdicts;
    this.#calls = calls;
    this.#now = opts.now ?? Date.now;
    const remember = { ttlMs: opts.ttlMs ?? TTL_MS, now: this.#now };
    this.#quick = new Remembered((w) => this.#readNow(w), remember);
    this.#firstDay = new Remembered((w) => this.#findFirstDay(w), remember);
  }

  /** Everything: both parts together. */
  async read(wallet: string): Promise<WalletHistory> {
    const [now, firstSeen] = await Promise.all([this.quick(wallet), this.firstDay(wallet)]);
    return { ...now, firstSeen };
  }

  /** Transactions, HYPE and coins launched: about half a second. */
  quick(wallet: string): Promise<WalletNow> {
    return this.#quick.get(wallet.toLowerCase());
  }

  /** The first day: a few seconds the first time. */
  firstDay(wallet: string): Promise<FirstSeen | null> {
    return this.#firstDay.get(wallet.toLowerCase());
  }

  async #readNow(wallet: string): Promise<WalletNow> {
    const { network } = this.#verdicts.health();
    if (!network) throw new NotReady("no coins loaded yet");
    const { hype, txsSent } = await this.#calls.now(wallet);
    return {
      wallet,
      network,
      readAt: new Date(this.#now()).toISOString(),
      txsSent,
      hype: formatEther(hype),
      coinsLaunched: this.#verdicts.launchedBy(wallet).map(({ token, symbol, venue, verdict, reason, disputeUrl }) => ({ token, symbol, venue, verdict, reason, disputeUrl })),
    };
  }

  async #findFirstDay(wallet: string): Promise<FirstSeen | null> {
    const known = this.#first.get(wallet);
    if (known) return known;
    const { txsSent, hype } = await this.quick(wallet);
    if (txsSent === 0 && hype === "0") return null;
    const head = await this.#calls.head();
    const block = await firstActiveBlock(this.#calls, wallet, head);
    const found = { block: block.toString(), time: new Date((await this.#calls.blockTime(block)) * 1000).toISOString() };
    this.#first.set(wallet, found);
    return found;
  }
}
