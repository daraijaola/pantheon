// Reads the public block explorer (Blockscout v2) for what plain RPC cannot answer cheaply: who sent
// native HYPE to a wallet, and how busy an address is. Every answer is checked before use.
import { getAddress, isAddress, isHash, type Address, type Hex } from "viem";
import { z } from "zod";

const hex = z.string().refine((v) => isHash(v)) as unknown as z.ZodType<Hex>;
const addr = z.object({ hash: z.string().refine((v) => isAddress(v, { strict: false })) });
const wei = z.string().regex(/^\d+$/);
const when = z.string().transform((v, ctx) => {
  const t = Date.parse(v);
  if (Number.isNaN(t)) ctx.addIssue({ code: "custom", message: "bad timestamp" });
  return Math.floor(t / 1000);
});

const TxPage = z.object({
  items: z.array(z.object({ hash: hex, from: addr, value: wei, status: z.string().nullable(), timestamp: when })),
});
const InternalPage = z.object({
  items: z.array(
    z.object({ transaction_hash: hex, from: addr, value: wei, success: z.boolean().nullable(), timestamp: when }),
  ),
});
const Counters = z.object({ transactions_count: z.string().regex(/^\d+$/) });

/** A native HYPE payment into a wallet. `via` is set when a contract paid it inside a transaction. */
export type RawFunding = { wallet: Address; from: Address; via: "tx" | "internal"; value: bigint; tx: Hex; time: number };

export class ExplorerError extends Error {
  override name = "ExplorerError";
}
/** The explorer's request allowance is nearly used up: stop, and let the cache carry the next run. */
export class ExplorerBudgetError extends ExplorerError {
  override name = "ExplorerBudgetError";
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export class Explorer {
  readonly base: string;
  readonly reserve: number;
  private readonly fetch: Fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Requests left in the explorer's current window, from its own headers. */
  remaining: number | null = null;

  constructor(base: string, opts: { fetch?: Fetch; reserve?: number; sleep?: (ms: number) => Promise<void> } = {}) {
    this.base = base.replace(/\/$/, "");
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.reserve = opts.reserve ?? 100;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private async get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    if (this.remaining !== null && this.remaining <= this.reserve) {
      throw new ExplorerBudgetError(`explorer allowance low (${this.remaining} left); run again later, the cache keeps progress`);
    }
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetch(`${this.base}${path}`, { signal: AbortSignal.timeout(20_000), headers: { accept: "application/json" } });
      } catch (err) {
        if (attempt >= 3) throw new ExplorerError(`explorer unreachable: ${(err as Error).message}`);
        await this.sleep(1_000 * 2 ** attempt);
        continue;
      }
      const left = Number(res.headers.get("x-ratelimit-remaining"));
      if (res.headers.has("x-ratelimit-remaining") && Number.isFinite(left)) this.remaining = left;
      if (res.status === 429) throw new ExplorerBudgetError("explorer rate limit reached; run again later, the cache keeps progress");
      if (res.status >= 500 && attempt < 3) {
        await this.sleep(1_000 * 2 ** attempt);
        continue;
      }
      if (!res.ok) throw new ExplorerError(`explorer ${res.status} for ${path}`);
      const parsed = schema.safeParse(await res.json());
      if (!parsed.success) throw new ExplorerError(`unexpected explorer answer for ${path}: ${parsed.error.issues[0]?.message}`);
      return parsed.data;
    }
  }

  /**
   * Native HYPE a wallet received: its earliest 50 incoming transactions, plus its latest 50
   * payments from contracts (the explorer cannot sort those). Failed or zero-value ones are dropped.
   */
  async fundings(wallet: Address): Promise<RawFunding[]> {
    const w = getAddress(wallet);
    const [txs, internal] = await Promise.all([
      this.get(`/addresses/${w}/transactions?filter=to&sort=block_number&order=asc`, TxPage),
      this.get(`/addresses/${w}/internal-transactions?filter=to`, InternalPage),
    ]);
    const out: RawFunding[] = [];
    for (const t of txs.items) {
      if (t.status !== "ok" || t.value === "0") continue;
      out.push({ wallet: w, from: getAddress(t.from.hash), via: "tx", value: BigInt(t.value), tx: t.hash, time: t.timestamp });
    }
    for (const t of internal.items) {
      if (t.success !== true || t.value === "0") continue;
      out.push({ wallet: w, from: getAddress(t.from.hash), via: "internal", value: BigInt(t.value), tx: t.transaction_hash, time: t.timestamp });
    }
    return out.sort((a, b) => a.time - b.time);
  }

  /** How many transactions involve an address, sent or received (the explorer's own counter). */
  async txCount(address: Address): Promise<number> {
    const c = await this.get(`/addresses/${getAddress(address)}/counters`, Counters);
    return Number(c.transactions_count);
  }
}
