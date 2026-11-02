// Everything a wallet has done on Elysium with tokens, read from the chain's own logs: every token it ever
// touched (not only the coins DELPHI reads), the NFTs it holds, the approvals still open on it, and the apps
// it used. The explorer's API is blocked, but the node answers "every transfer to or from this address"
// directly. It can't list a wallet's transactions, so an app only shows up if using it moved a token or gave
// an approval, and each transaction is looked up one by one (once ever, since they never change).
// Logs are written by contracts, and any contract can write anything, so a log is a lead and never the
// answer: what a wallet holds comes from asking the token, and who started a transaction comes from the
// transaction. Names and symbols are strangers' text, so they're cleaned and capped. A token that only ever
// arrived in other people's transactions is marked: it's listed apart and must never be counted. A contract
// never sends a transaction of its own, so for one that can't be told, and it's left unknown.
import { erc20Abi, formatUnits, parseAbi, ResponseBodyTooLargeError, type Address, type PublicClient } from "viem";
import { requestFailed } from "./chain.ts";
import { NotReady } from "./holdings.ts";
import { Remembered } from "./remembered.ts";
import type { CoinVerdict, UnknownCoin } from "./verdicts.ts";

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const APPROVAL = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
const APPROVAL_FOR_ALL = "0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31";
const TTL_MS = 60_000;
/** An allowance this large is a blanket approval: half the biggest possible, as spending lowers some. */
const UNLIMITED = 2n ** 255n;
const CHUNK = 500;
/** Transaction lookups at once: six requests of 100 each, which the node answers about as fast as one. */
const TXS_AT_ONCE = 600;
/** Transactions remembered: about 40 MB at most. */
const TXS_KEPT = 200_000;
const MAX_NFT_IDS = 50;
/** More than this isn't a person: it's a pool or a platform. Ascend's own contracts have millions. */
const MAX_LOGS = 30_000;
/** How long a wallet stays "too big" before it's tried again, so asking again costs nothing. */
const TOO_BIG_MS = 60 * 60_000;
/** Answers kept: a big footprint is a lot of memory. */
const FOOTPRINTS_KEPT = 500;

export type RawLog = { address: string; topics: string[]; data: string; blockNumber: string; transactionHash: string; logIndex: string; blockTimestamp?: string };

type Request = (args: { method: string; params: unknown[] }) => Promise<unknown>;

/** This wallet has too much history to read: a platform or a pool, not a person. */
export class TooBig extends Error {
  override name = "TooBig";
}

/** Logs a read may still take, shared by its searches. */
export type Budget = { left: number };

/** Too many logs for the node to give, or too many bytes for the client to take. Both need a smaller question. */
const tooMuchAtOnce = (err: unknown) => err instanceof ResponseBodyTooLargeError || /logs count limit/i.test((err as Error).message);

/**
 * Every log matching these topics. A range that's too much at once is cut in half until each part fits. It
 * stops once the budget is spent, so asking about a platform's contract can't tie the service up for minutes.
 */
export async function allLogs(request: Request, topics: Array<string | null>, from: bigint, to: bigint, budget: Budget): Promise<RawLog[]> {
  try {
    const logs = (await request({ method: "eth_getLogs", params: [{ fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`, topics }] })) as RawLog[];
    budget.left -= logs.length;
    if (budget.left < 0) throw new TooBig("too much history to read");
    return logs;
  } catch (err) {
    if (!tooMuchAtOnce(err)) throw err;
    // Not even one block fits: no person's wallet does that.
    if (from >= to) throw new TooBig("too much history to read");
    const mid = (from + to) / 2n;
    return [...(await allLogs(request, topics, from, mid, budget)), ...(await allLogs(request, topics, mid + 1n, to, budget))];
  }
}

export type Meta = { symbol: string | null; name: string | null; decimals: number | null };

export type FootprintCalls = {
  head(): Promise<bigint>;
  /** Whether this address is a contract, not a wallet someone holds a key to. */
  isContract(wallet: string): Promise<boolean>;
  logs(topics: Array<string | null>, to: bigint, budget: Budget): Promise<RawLog[]>;
  /** In the order asked; null means that one couldn't be read. */
  balances(wallet: string, tokens: readonly string[]): Promise<Array<bigint | null>>;
  meta(tokens: readonly string[]): Promise<Meta[]>;
  allowances(wallet: string, pairs: ReadonlyArray<{ token: string; spender: string }>): Promise<Array<bigint | null>>;
  /** Who sent each transaction and to what, in the order asked; null if it couldn't be read. */
  transactions(txs: readonly string[]): Promise<Array<Tx | null>>;
};

export type Tx = { from: string; to: string | null };

const metaAbi = parseAbi(["function name() view returns (string)", "function symbol() view returns (string)", "function decimals() view returns (uint8)"]);

/** The start of the code a normal wallet gets when it delegates to a contract: it still sends its own transactions. */
const DELEGATED = "0xef0100";

export function chainFootprint(client: Pick<PublicClient, "request" | "multicall" | "getBlockNumber" | "getCode">): FootprintCalls {
  const request = client.request as unknown as Request;
  const known = new Map<string, Tx>();
  /** One after the other, to go easy on the node. A request failing throws; one token failing is null. */
  async function bundled<T>(contracts: Array<Record<string, unknown>>): Promise<Array<T | null>> {
    const out: Array<T | null> = [];
    for (let i = 0; i < contracts.length; i += CHUNK) {
      const got = await client.multicall({ contracts: contracts.slice(i, i + CHUNK) as never[], allowFailure: true, batchSize: 0 });
      for (const r of got as Array<{ status: string; result?: unknown; error?: unknown }>) {
        if (r.status !== "success" && requestFailed(r.error)) throw new Error("the node didn't answer", { cause: r.error });
        out.push(r.status === "success" ? (r.result as T) : null);
      }
    }
    return out;
  }
  return {
    head: () => client.getBlockNumber(),
    isContract: async (wallet) => {
      const code = await client.getCode({ address: wallet as Address });
      return !!code && code !== "0x" && !code.startsWith(DELEGATED);
    },
    logs: (topics, to, budget) => allLogs(request, topics, 0n, to, budget),
    balances: (wallet, tokens) => bundled<bigint>(tokens.map((t) => ({ address: t as Address, abi: erc20Abi, functionName: "balanceOf", args: [wallet as Address] }))),
    meta: async (tokens) => {
      const got = await bundled<string | number>(tokens.flatMap((t) => (["symbol", "name", "decimals"] as const).map((functionName) => ({ address: t as Address, abi: metaAbi, functionName }))));
      return tokens.map((_, i) => ({ symbol: (got[i * 3] as string | null) ?? null, name: (got[i * 3 + 1] as string | null) ?? null, decimals: (got[i * 3 + 2] as number | null) ?? null }));
    },
    allowances: (wallet, pairs) => bundled<bigint>(pairs.map((p) => ({ address: p.token as Address, abi: erc20Abi, functionName: "allowance", args: [wallet as Address, p.spender as Address] }))),
    transactions: async (txs) => {
      const missing = txs.filter((tx) => !known.has(tx));
      if (known.size + missing.length > TXS_KEPT) known.clear();
      for (let i = 0; i < missing.length; i += TXS_AT_ONCE) {
        const part = missing.slice(i, i + TXS_AT_ONCE);
        const got = await Promise.all(part.map((hash) => request({ method: "eth_getTransactionByHash", params: [hash] }).catch(() => null)));
        (got as Array<{ from?: string; to?: string | null } | null>).forEach((t, j) => {
          if (t?.from) known.set(part[j]!, { from: t.from.toLowerCase(), to: t.to?.toLowerCase() ?? null });
        });
      }
      return txs.map((tx) => known.get(tx) ?? null);
    },
  };
}

const pad = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}`;
const addressIn = (topic: string) => `0x${topic.slice(-40)}`.toLowerCase();
const clean = (s: string | null, max: number) => (s ? [...s.replace(/[\p{Cc}\p{Cf}]/gu, " ")].slice(0, max).join("").trim() || null : null);
const when = (l: RawLog) => (l.blockTimestamp ? new Date(Number(BigInt(l.blockTimestamp)) * 1000).toISOString() : null);
const value = (l: RawLog) => (l.data && l.data !== "0x" ? BigInt(l.data) : 0n);
const sum = (logs: readonly RawLog[]) => logs.reduce((a, l) => a + value(l), 0n).toString();
const amount = (raw: bigint, decimals: number | null): Amount => ({ raw: raw.toString(), amount: decimals === null ? null : formatUnits(raw, decimals) });
function order(a: RawLog, b: RawLog) {
  const [x, y] = [BigInt(a.blockNumber), BigInt(b.blockNumber)];
  return x === y ? Number(BigInt(a.logIndex) - BigInt(b.logIndex)) : x < y ? -1 : 1;
}
function group<T>(items: readonly T[], key: (item: T) => string) {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const list = out.get(key(item));
    if (list) list.push(item);
    else out.set(key(item), [item]);
  }
  return out;
}

export type Moment = { block: string; time: string | null; tx: string };
const moment = (l: RawLog): Moment => ({ block: BigInt(l.blockNumber).toString(), time: when(l), tx: l.transactionHash });

export type Amount = { raw: string; amount: string | null };
export type Tally = { count: number; raw: string };

export type TokenRow = {
  token: string;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  /** What the token says this wallet holds now. Null if it couldn't be read: unknown, not zero. */
  balance: Amount | null;
  holdsNow: boolean | null;
  firstSeen: Moment;
  lastSeen: Moment;
  received: Tally;
  sent: Tally;
  /** The part of `received` that came in transactions this wallet didn't send. Null if one couldn't be read. */
  fromOthers: Tally | null;
  /** Every arrival was in someone else's transaction: list it apart, never count it. Null if it can't be told, as for a contract. */
  sentIn: boolean | null;
  /** DELPHI's verdict, or UNKNOWN if it isn't a coin DELPHI has read. */
  verdict: CoinVerdict["verdict"] | UnknownCoin["verdict"];
};

export type NftRow = {
  collection: string;
  symbol: string | null;
  name: string | null;
  /** What the collection says this wallet holds now. Null if it couldn't be read: unknown, not zero. */
  heldCount: number | null;
  /** The first few token ids, from the transfers. */
  held: string[];
  firstSeen: Moment;
  lastSeen: Moment;
  sentIn: boolean | null;
};

export type ApprovalRow = {
  token: string;
  symbol: string | null;
  spender: string;
  spenderName: string | null;
  /** Null if the token couldn't be read: it may still be open. */
  allowance: Amount | null;
  unlimited: boolean | null;
  givenAt: Moment;
};
export type OperatorRow = { collection: string; symbol: string | null; operator: string; operatorName: string | null; givenAt: Moment };
/** A contract this wallet called, other than a token itself. Only calls that moved a token or gave an approval are seen. */
export type AppRow = { contract: string; name: string | null; txs: number; firstSeen: Moment; lastSeen: Moment };

export type Footprint = {
  wallet: string;
  network: "testnet" | "mainnet";
  readAt: string;
  isContract: boolean;
  tokens: TokenRow[];
  nfts: NftRow[];
  /** Permissions still open on this wallet: who can spend what without asking again. */
  approvals: ApprovalRow[];
  nftOperators: OperatorRow[];
  apps: AppRow[];
  /** Anything sent in is left out of these, so a stranger can't raise a wallet's numbers. */
  totals: { tokensTouched: number; tokensHeld: number; sentIn: number; heldNotRead: number; nftCollections: number; nftsHeld: number; nftsSentIn: number; approvalsOpen: number; unlimited: number };
  /** Tokens and collections that couldn't be read: unknown, not zero. */
  unread: string[];
  /** True when everything but coins sent in was read: a stranger's broken token can't mark a wallet unread. */
  complete: boolean;
};

type Facts = { network(): "testnet" | "mainnet" | null; verdict(token: string): CoinVerdict | UnknownCoin };

export class FootprintReader {
  readonly #facts: Facts;
  readonly #calls: FootprintCalls;
  readonly #names: Readonly<Record<string, string>>;
  readonly #now: () => number;
  readonly #remembered: Remembered<Footprint>;
  /** A token's name and decimals don't change. */
  readonly #meta = new Map<string, Meta>();
  /** When each wallet found too big may be tried again. */
  readonly #tooBig = new Map<string, number>();

  constructor(facts: Facts, calls: FootprintCalls, names: Readonly<Record<string, string>> = {}, opts: { now?: () => number; ttlMs?: number } = {}) {
    this.#facts = facts;
    this.#calls = calls;
    this.#names = names;
    this.#now = opts.now ?? Date.now;
    this.#remembered = new Remembered((w) => this.#read(w), { ttlMs: opts.ttlMs ?? TTL_MS, now: this.#now, max: FOOTPRINTS_KEPT });
  }

  read(wallet: string): Promise<Footprint> {
    const key = wallet.toLowerCase();
    if (this.#now() < (this.#tooBig.get(key) ?? 0)) return Promise.reject(new TooBig("too much history to read"));
    return this.#remembered.get(key).catch((err: unknown) => {
      if (err instanceof TooBig) this.#tooBig.set(key, this.#now() + TOO_BIG_MS);
      throw err;
    });
  }

  async #learnMeta(tokens: readonly string[]) {
    const missing = tokens.filter((t) => !this.#meta.has(t));
    if (!missing.length) return;
    const got = await this.#calls.meta(missing);
    missing.forEach((t, i) => {
      const m = got[i]!;
      // Unread is left unlearned, so it's asked again next time.
      if (m.symbol !== null || m.name !== null || m.decimals !== null) this.#meta.set(t, { symbol: clean(m.symbol, 20), name: clean(m.name, 40), decimals: m.decimals });
    });
  }

  async #read(wallet: string): Promise<Footprint> {
    const network = this.#facts.network();
    if (!network) throw new NotReady("no coins loaded yet");
    const c = this.#calls;
    const [head, isContract] = await Promise.all([c.head(), c.isContract(wallet)]);
    const me = pad(wallet);
    const budget = { left: MAX_LOGS };
    const [out, inc, approvalLogs, operatorLogs] = await Promise.all([c.logs([TRANSFER, me], head, budget), c.logs([TRANSFER, null, me], head, budget), c.logs([APPROVAL, me], head, budget), c.logs([APPROVAL_FOR_ALL, me], head, budget)]);

    // A wallet sending to itself shows up in both lists. A zero transfer moves nothing: anyone can make one
    // "from" any wallet, so it's how fake history gets planted.
    const logs = [...new Map([...out, ...inc].map((l) => [`${l.transactionHash}:${l.logIndex}`, l])).values()].sort(order);
    const tokenLogs = group(logs.filter((l) => l.topics.length === 3 && value(l) > 0n), (l) => l.address.toLowerCase());
    const nftLogs = group(logs.filter((l) => l.topics.length === 4), (l) => l.address.toLowerCase());
    const tokens = [...tokenLogs.keys()];
    const collections = [...nftLogs.keys()];

    const latest = new Map([...approvalLogs].filter((l) => l.topics.length === 3).sort(order).map((l) => [`${l.address.toLowerCase()}:${addressIn(l.topics[2]!)}`, l]));
    const pairs = [...latest.values()].map((l) => ({ token: l.address.toLowerCase(), spender: addressIn(l.topics[2]!), log: l }));
    const lastOperator = new Map([...operatorLogs].sort(order).map((l) => [`${l.address.toLowerCase()}:${addressIn(l.topics[2]!)}`, l]));

    const counted = [...[...tokenLogs.values()].flat(), ...[...nftLogs.values()].flat(), ...approvalLogs, ...operatorLogs].sort(order);
    // A contract sends nothing, so looking up who sent what would only say that it didn't.
    const txs = isContract ? [] : [...new Set(counted.map((l) => l.transactionHash))];
    const contracts = new Set([...tokens, ...collections, ...pairs.map((p) => p.token), ...[...lastOperator.values()].map((l) => l.address.toLowerCase())]);
    const [balances, allowed, read] = await Promise.all([c.balances(wallet, [...tokens, ...collections]), c.allowances(wallet, pairs), c.transactions(txs), this.#learnMeta([...contracts])]);
    const metaOf = (t: string): Meta => this.#meta.get(t) ?? { symbol: null, name: null, decimals: null };
    const txOf = new Map(txs.map((tx, i) => [tx, read[i] ?? null]));
    const sentBy = (l: RawLog) => txOf.get(l.transactionHash)?.from ?? null;
    /** One arrival in its own transaction is enough: it asked for this. Zero arrivals means nothing came in. */
    const sentIn = (got: readonly RawLog[]) => (!got.length || got.some((l) => sentBy(l) === wallet) ? false : got.some((l) => sentBy(l) === null) ? null : true);

    const rows = tokens.map((token, i): TokenRow => {
      const list = tokenLogs.get(token)!;
      const raw = balances[i] ?? null;
      const { symbol, name, decimals } = metaOf(token);
      const got = list.filter((l) => addressIn(l.topics[2]!) === wallet);
      const gave = list.filter((l) => addressIn(l.topics[1]!) === wallet);
      const others = got.filter((l) => sentBy(l) !== wallet);
      return {
        token,
        symbol,
        name,
        decimals,
        balance: raw === null ? null : amount(raw, decimals),
        holdsNow: raw === null ? null : raw > 0n,
        firstSeen: moment(list[0]!),
        lastSeen: moment(list.at(-1)!),
        received: { count: got.length, raw: sum(got) },
        sent: { count: gave.length, raw: sum(gave) },
        fromOthers: others.some((l) => sentBy(l) === null) ? null : { count: others.length, raw: sum(others) },
        sentIn: sentIn(got),
        verdict: this.#facts.verdict(token).verdict,
      };
    });
    rows.sort((a, b) => Number(b.holdsNow ?? 0) - Number(a.holdsNow ?? 0) || Number(BigInt(b.lastSeen.block) - BigInt(a.lastSeen.block)));

    const nfts = collections.map((collection, i): NftRow => {
      const list = nftLogs.get(collection)!;
      const owned = new Set<string>();
      for (const l of list) {
        const id = BigInt(l.topics[3]!).toString();
        if (addressIn(l.topics[2]!) === wallet) owned.add(id);
        else owned.delete(id);
      }
      const raw = balances[tokens.length + i] ?? null;
      const { symbol, name } = metaOf(collection);
      return { collection, symbol, name, heldCount: raw === null ? null : Number(raw), held: raw === 0n ? [] : [...owned].slice(0, MAX_NFT_IDS), firstSeen: moment(list[0]!), lastSeen: moment(list.at(-1)!), sentIn: sentIn(list.filter((l) => addressIn(l.topics[2]!) === wallet)) };
    });

    const approvals = pairs.flatMap(({ token, spender, log }, i): ApprovalRow[] => {
      const left = allowed[i] ?? null;
      if (left === 0n) return [];
      const { symbol, decimals } = metaOf(token);
      return [{ token, symbol, spender, spenderName: this.#names[spender] ?? null, allowance: left === null ? null : amount(left, decimals), unlimited: left === null ? null : left >= UNLIMITED, givenAt: moment(log) }];
    });
    approvals.sort((a, b) => Number(b.unlimited ?? 1) - Number(a.unlimited ?? 1) || Number(BigInt(b.givenAt.block) - BigInt(a.givenAt.block)));

    const nftOperators = [...lastOperator.values()].filter((l) => value(l) !== 0n).map((l): OperatorRow => {
      const operator = addressIn(l.topics[2]!);
      return { collection: l.address.toLowerCase(), symbol: metaOf(l.address.toLowerCase()).symbol, operator, operatorName: this.#names[operator] ?? null, givenAt: moment(l) };
    });

    const firstLogs = [...new Map([...counted].reverse().map((l) => [l.transactionHash, l])).values()].reverse();
    const called = group(firstLogs.filter((l) => txOf.get(l.transactionHash)?.from === wallet && !contracts.has(txOf.get(l.transactionHash)?.to ?? "") && txOf.get(l.transactionHash)?.to), (l) => txOf.get(l.transactionHash)!.to!);
    const apps = [...called].map(([contract, list]): AppRow => ({ contract, name: this.#names[contract] ?? null, txs: list.length, firstSeen: moment(list[0]!), lastSeen: moment(list.at(-1)!) }));
    apps.sort((a, b) => b.txs - a.txs);

    const kept = rows.filter((r) => r.sentIn !== true);
    const keptNfts = nfts.filter((r) => r.sentIn !== true);
    const unread = [...new Set([...kept.filter((r) => r.balance === null).map((r) => r.token), ...keptNfts.filter((r) => r.heldCount === null).map((r) => r.collection), ...approvals.filter((a) => a.allowance === null).map((a) => a.token)])];
    return {
      wallet,
      network,
      readAt: new Date(this.#now()).toISOString(),
      isContract,
      tokens: rows,
      nfts,
      approvals,
      nftOperators,
      apps,
      totals: {
        tokensTouched: kept.length,
        tokensHeld: kept.filter((r) => r.holdsNow).length,
        sentIn: rows.length - kept.length,
        heldNotRead: kept.filter((r) => r.holdsNow && r.verdict === "UNKNOWN").length,
        nftCollections: keptNfts.length,
        nftsHeld: keptNfts.reduce((a, r) => a + (r.heldCount ?? 0), 0),
        nftsSentIn: nfts.length - keptNfts.length,
        approvalsOpen: approvals.length + nftOperators.length,
        unlimited: approvals.filter((a) => a.unlimited).length + nftOperators.length,
      },
      unread,
      complete: unread.length === 0 && read.every((t) => t !== null),
    };
  }
}
