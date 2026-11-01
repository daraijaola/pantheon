// Where a wallet's first HYPE came from, read from the chain itself instead of an explorer's index.
// The block explorer's API sits behind a bot checkpoint since 2026-10-25, so DELPHI finds the block
// where a wallet first had anything (a balance or a sent transaction) by binary search over archive
// state, then reads that block to see who paid it: a plain transfer, or a contract paying inside a
// call (from the block's call traces). A first funding never changes, so it is looked up once.
//
// On mainnet (rules v0.6) "anything" means at least a dust floor of HYPE (RULES.funding): the first block
// where the balance reached the floor, so dust a stranger sent first is not the funding. Testnet's floor
// is 0, which is exactly the search from before, under the same cache kind.
import { getAddress, isAddress, isHash, numberToHex, type Address, type Hex } from "viem";
import { z } from "zod";
import { dustFloorOf, type Network } from "./config.ts";
import type { RawFunding } from "./explorer.ts";
import type { FirstFundingFn } from "./x/wallet.ts";
import { BatchRpc, type RpcCall } from "./rpc.ts";
import type { Store } from "./store.ts";

const lc = (a: string) => a.toLowerCase();

/** What collect() needs about funding: the old explorer client and ChainFunding both fit. */
export interface FundingSource {
  /** Native HYPE payments into one wallet that tie it to whoever paid. */
  fundings(wallet: Address): Promise<RawFunding[]>;
  /** How busy an address is: transactions it sent (ChainFunding) or took part in (the explorer). */
  txCount(address: Address): Promise<number>;
  /** The same for many wallets at once; wallets it could not read are left out. */
  fundingsMany?(wallets: readonly Address[]): Promise<Map<string, RawFunding[]>>;
  txCounts?(addresses: readonly Address[]): Promise<Map<string, number>>;
  remaining?: number | null;
  /** The dust floor it searches with, in wei (ChainFunding). Unset: none. It must be the network's (fundingCache). */
  dustFloor?: bigint;
}

/**
 * The cache kind first fundings are kept under. With no floor (testnet) it is "funding", exactly as
 * before, so the permanent cache already filled stays valid. With a floor, the floor is in the name: a
 * funding read under another floor is never mixed in, and a new floor reads every wallet again.
 */
export const fundingCacheKind = (dustFloor: bigint): string => (dustFloor === 0n ? "funding" : `funding-floor-${dustFloor}`);

/**
 * The cache kind for a network's fundings, after checking that `source` (if any) searches with that
 * network's floor: fundings read with another floor would be saved under this one's name.
 */
export function fundingCache(network: Network, source?: FundingSource | null): string {
  const floor = dustFloorOf(network);
  if (source && (source.dustFloor ?? 0n) !== floor) {
    throw new Error(`the funding search uses a dust floor of ${source.dustFloor ?? 0n} wei, but the ${network} rules say ${floor}: build it with ChainFunding.forNetwork()`);
  }
  return fundingCacheKind(floor);
}

export type { FirstFunding, FirstFundingFn } from "./x/wallet.ts";
/** How collect() saves funding in the cache. */
type StoredFunding = { from: Address; via: RawFunding["via"]; value: string; tx: Hex; time: number };

const hexQty = z.string().regex(/^0x[0-9a-fA-F]+$/);
const addr = z.string().refine((v) => isAddress(v, { strict: false }));
const hash = z.string().refine((v) => isHash(v)) as unknown as z.ZodType<Hex>;
const Block = z.object({
  number: hexQty,
  timestamp: hexQty,
  transactions: z.array(z.object({ hash, from: addr, to: addr.nullable(), value: hexQty })),
});
type Frame = { from: string; to?: string; value?: string; type?: string; calls?: Frame[] };
const FrameSchema: z.ZodType<Frame> = z.lazy(() =>
  z.object({ from: z.string(), to: z.string().optional(), value: z.string().optional(), type: z.string().optional(), calls: z.array(FrameSchema).optional() }),
);
const Traces = z.array(z.object({ txHash: hash, result: FrameSchema.optional() }));

/**
 * Reads first fundings over the explorer's node (archive state, batches, call traces). Wallets are
 * searched together: each step asks every open wallet's balance and nonce at its own midpoint in one
 * batch, so 300 wallets cost about 25 steps of 6 requests each.
 *
 * HYPE bridged in from the parent chain arrives as a deposit transaction whose sender is the
 * depositor's own parent-chain address, shifted by a fixed offset (seen live: 0x5f62…cb5e was paid
 * by 0x7073…dc6f). That address is one person's, not a shared bridge, so it links only wallets bridged
 * from the same address, exactly as the explorer reported it. Checked 2026-10-31: on 60 wallets the
 * explorer had read before its checkpoint, the first funding found here was the same transaction.
 */
export class ChainFunding implements FundingSource {
  readonly rpc: BatchRpc;
  /** In wei: a payment is a wallet's funding once its HYPE reached this (RULES.funding). 0: any HYPE, as on testnet. */
  readonly dustFloor: bigint;
  /** Where firstFundingFn() keeps what it reads (fundingCacheKind). */
  readonly cacheKind: string;
  remaining = null;
  private headCache: { at: number; head: bigint } | null = null;
  private readonly blocks = new Map<string, Promise<z.infer<typeof Block>>>();
  private readonly traces = new Map<string, Promise<z.infer<typeof Traces>>>();

  constructor(rpc: BatchRpc = new BatchRpc(), opts: { dustFloor?: bigint } = {}) {
    this.rpc = rpc;
    this.dustFloor = opts.dustFloor ?? 0n;
    if (this.dustFloor < 0n) throw new Error("the dust floor can't be negative");
    this.cacheKind = fundingCacheKind(this.dustFloor);
  }

  /** The search a network's rules call for: its dust floor, over the explorer's node. */
  static forNetwork(network: Network, rpc: BatchRpc = new BatchRpc()): ChainFunding {
    return new ChainFunding(rpc, { dustFloor: dustFloorOf(network) });
  }

  private async head(): Promise<bigint> {
    if (this.headCache && Date.now() - this.headCache.at < 30_000) return this.headCache.head;
    const head = BigInt(await this.rpc.call<string>("eth_blockNumber", []));
    this.headCache = { at: Date.now(), head };
    return head;
  }

  async fundings(wallet: Address): Promise<RawFunding[]> {
    const got = await this.fundingsMany([wallet]);
    const f = got.get(lc(wallet));
    if (!f) throw new Error(`could not read the first funding of ${wallet}`);
    return f;
  }

  async txCount(address: Address): Promise<number> {
    const got = await this.txCounts([address]);
    const n = got.get(lc(address));
    if (n === undefined) throw new Error(`could not read the transaction count of ${address}`);
    return n;
  }

  /** Sent transactions per address (its nonce now). Faucets and bots send thousands; a person, dozens. */
  async txCounts(addresses: readonly Address[]): Promise<Map<string, number>> {
    const list = [...new Set(addresses.map(lc))];
    const answers = await this.rpc.many<string>(list.map((a) => ({ method: "eth_getTransactionCount", params: [a, "latest"] })));
    const out = new Map<string, number>();
    list.forEach((a, i) => {
      const r = answers[i]!.result;
      if (typeof r === "string") out.set(a, Number(BigInt(r)));
    });
    return out;
  }

  /**
   * Each wallet's first funding, as a one-item list ([] if it never held HYPE, or never reached the
   * floor and never sent a transaction). Wallets whose search or funding block could not be read are
   * left out, so the caller can say their funding is missing.
   */
  async fundingsMany(wallets: readonly Address[]): Promise<Map<string, RawFunding[]>> {
    const list = [...new Set(wallets.map(lc))];
    const head = await this.head();
    const { found, unpaid } = await this.firstPayments(list, head, this.dustFloor);
    // With a floor, a wallet that sent transactions before it ever reached it ran on smaller payments:
    // those count after all, so its funding is its first payment, found as with no floor.
    if (this.dustFloor > 0n && unpaid.length) for (const [w, f] of (await this.firstPayments(unpaid, head, 0n)).found) found.set(w, f);
    return found;
  }

  /**
   * Each wallet's payment in the first block where its HYPE reached `floor` or it had sent a
   * transaction. `unpaid`: wallets whose block was read but held no payment to them (they sent a
   * transaction first); they are left out of `found`, like wallets whose block could not be read.
   */
  private async firstPayments(list: string[], head: bigint, floor: bigint): Promise<{ found: Map<string, RawFunding[]>; unpaid: string[] }> {
    const firsts = await this.firstBlocks(list, head, floor);
    const found = new Map<string, RawFunding[]>();
    const unpaid: string[] = [];
    const byBlock = new Map<string, string[]>();
    for (const [w, b] of firsts) {
      if (b === null) found.set(w, []);
      else byBlock.set(b.toString(), [...(byBlock.get(b.toString()) ?? []), w]);
    }
    for (const [b, ws] of byBlock) {
      try {
        const paid = await this.paymentsIn(BigInt(b), ws, floor);
        for (const w of ws) {
          const f = paid.get(w);
          if (f) found.set(w, [f]);
          else unpaid.push(w);
        }
      } catch {
        // This block could not be read: its wallets stay missing and are tried again next run.
      }
    }
    return { found, unpaid };
  }

  /**
   * The first block where each wallet's HYPE reached `floor` (with no floor: any HYPE at all) or it had
   * sent a transaction (null: never, up to `head`). Both only ever go from "no" to "yes": a balance can
   * drop back below the floor only by sending a transaction, which raises the nonce for good. So a
   * binary search finds the block.
   */
  async firstBlocks(wallets: readonly string[], head: bigint, floor: bigint = this.dustFloor): Promise<Map<string, bigint | null>> {
    const out = new Map<string, bigint | null>();
    type Open = { w: string; lo: bigint; hi: bigint; misses: number };
    const used = (w: string, block: bigint): RpcCall[] => [
      { method: "eth_getBalance", params: [w, numberToHex(block)] },
      { method: "eth_getTransactionCount", params: [w, numberToHex(block)] },
    ];
    // No floor: a balance of 1 wei or more, exactly as before.
    const least = floor > 0n ? floor : 1n;
    const isUsed = (bal: unknown, nonce: unknown): boolean | null =>
      typeof bal === "string" && typeof nonce === "string" ? BigInt(bal) >= least || BigInt(nonce) > 0n : null;

    // First: has it ever been used? Wallets that never held HYPE have no funder.
    const now = await this.rpc.many(wallets.flatMap((w) => used(w, head)));
    let open: Open[] = [];
    wallets.forEach((w, i) => {
      const u = isUsed(now[2 * i]!.result, now[2 * i + 1]!.result);
      if (u === false) out.set(w, null);
      else if (u === true) open.push({ w, lo: 0n, hi: head, misses: 0 });
    });
    while (open.length) {
      const mids = open.map((o) => (o.lo + o.hi) / 2n);
      const answers = await this.rpc.many(open.flatMap((o, i) => used(o.w, mids[i]!)));
      const next: Open[] = [];
      open.forEach((o, i) => {
        const u = isUsed(answers[2 * i]!.result, answers[2 * i + 1]!.result);
        if (u === null) {
          if (o.misses < 3) next.push({ ...o, misses: o.misses + 1 });
          return;
        }
        const s = u ? { ...o, hi: mids[i]! } : { ...o, lo: mids[i]! };
        if (s.hi - s.lo <= 1n) out.set(o.w, s.hi);
        else next.push(s);
      });
      open = next;
    }
    return out;
  }

  /**
   * Who paid each wallet HYPE in this block: a transaction sent straight to it, or else a contract
   * paying it inside someone's call (read from the block's call traces). With a floor, the biggest
   * transaction, so dust sent in the same block doesn't take the real payment's place (with none, the
   * first, as before). A wallet nobody paid here is left out (it was used without being paid, e.g. it
   * sent a free transaction).
   */
  async paymentsIn(block: bigint, wallets: readonly string[], floor: bigint = this.dustFloor): Promise<Map<string, RawFunding>> {
    const b = await this.block(block);
    const time = Number(BigInt(b.timestamp));
    const out = new Map<string, RawFunding>();
    const want = new Set(wallets.map(lc));
    for (const t of b.transactions) {
      const to = t.to ? lc(t.to) : null;
      const value = BigInt(t.value);
      if (!to || !want.has(to) || value === 0n) continue;
      const before = out.get(to);
      if (before && (floor === 0n || before.value >= value)) continue;
      out.set(to, { wallet: getAddress(to), from: getAddress(t.from), via: "tx", value, tx: t.hash, time });
    }
    const rest = [...want].filter((w) => !out.has(w));
    if (rest.length === 0) return out;
    const left = new Set(rest);
    for (const { txHash, result } of await this.trace(block)) {
      if (!result) continue;
      const walk = (f: Frame, depth: number) => {
        const to = f.to ? lc(f.to) : null;
        const value = f.value ? BigInt(f.value) : 0n;
        if (depth > 0 && to && left.has(to) && value > 0n && f.type !== "DELEGATECALL" && f.type !== "STATICCALL") {
          left.delete(to);
          out.set(to, { wallet: getAddress(to), from: getAddress(f.from), via: "internal", value, tx: txHash, time });
        }
        for (const c of f.calls ?? []) walk(c, depth + 1);
      };
      walk(result, 0);
      if (left.size === 0) break;
    }
    return out;
  }

  /**
   * For one wallet: its first funding, from the cache when DELPHI already read it, else from the
   * chain (and then cached). A payment made inside a contract call is credited to whoever sent that
   * call, as everywhere else in DELPHI.
   */
  firstFundingFn(store: Store): FirstFundingFn {
    return async (wallet) => {
      const w = lc(wallet);
      let list = store.recall<StoredFunding[]>(this.cacheKind, w)?.map((f) => ({ ...f, value: BigInt(f.value) }));
      if (!list) {
        const got = (await this.fundingsMany([wallet])).get(w);
        if (!got) throw new Error(`could not read the first funding of ${wallet}`);
        store.remember(this.cacheKind, w, got.map((f) => ({ from: f.from, via: f.via, value: f.value.toString(), tx: f.tx, time: f.time })));
        list = got;
      }
      const first = list.filter((f) => lc(f.from) !== w).sort((a, b) => a.time - b.time)[0];
      if (!first) return null;
      const funder = first.via === "internal" ? getAddress((await this.rpc.call<{ from: string }>("eth_getTransactionByHash", [first.tx])).from) : getAddress(first.from);
      return { wallet: getAddress(w), funder, via: first.via, value: first.value, tx: first.tx, block: 0n, time: first.time };
    };
  }

  private block(n: bigint) {
    const k = n.toString();
    if (!this.blocks.has(k)) {
      const p = this.rpc.call<unknown>("eth_getBlockByNumber", [numberToHex(n), true]).then((r) => Block.parse(r));
      p.catch(() => this.blocks.delete(k));
      this.blocks.set(k, p);
    }
    return this.blocks.get(k)!;
  }

  private trace(n: bigint) {
    const k = n.toString();
    if (!this.traces.has(k)) {
      const p = this.rpc.call<unknown>("debug_traceBlockByNumber", [numberToHex(n), { tracer: "callTracer" }]).then((r) => Traces.parse(r));
      p.catch(() => this.traces.delete(k));
      this.traces.set(k, p);
    }
    return this.traces.get(k)!;
  }
}
