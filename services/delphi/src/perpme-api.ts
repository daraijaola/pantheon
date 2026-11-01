// PerpMe's own public data, for cross-checks only (the chain is the source of truth): the dex-sync REST
// API its Elysium pages run on (perpme.fun/elysium/dex-sync: /tokens, /trades, /dex/:address, /stats) and
// the indexer behind it (perpme.fun/elysium/indexer/graphql, a Ponder GraphQL that also knows each coin's
// holders). Both are free, keyless and CORS-open (perpme.fun/elysium/docs). Seen live 2026-11-01:
// - /tokens lists every launch of every PerpMe factory on Elysium (1,888: 1,530 from the factory Kalos
//   pins, 269 from the first one, 87 Uniswap-V4 launches and 4 from small test factories), 100 a page,
//   filtered with where={"id":"0x…"};
// - /trades ignores a token filter (it always answers the latest trades), so trades per coin come from
//   the indexer;
// - the indexer's holders include the pool and the launch factory (which keeps a few wei of every coin).
import { getAddress, isAddress, type Address } from "viem";
import { z } from "zod";
import { getJson, type Fetch } from "./http.ts";

export const PERPME_DEX_SYNC = "https://perpme.fun/elysium/dex-sync";
export const PERPME_INDEXER = "https://perpme.fun/elysium/indexer/graphql";

const address = z
  .string()
  .refine((v) => isAddress(v, { strict: false }))
  .transform((v) => getAddress(v));
const uint = z.string().regex(/^\d+$/).transform((v) => BigInt(v));

const ApiToken = z.object({
  id: address,
  name: z.string(),
  symbol: z.string(),
  creator: address,
  /** The launch factory ("curve" from the bonding-curve days). */
  curve: address,
  launchType: z.string(),
  pool: address.nullable(),
  pairToken: z.string(),
  tradeCount: z.number().int().nonnegative(),
  createdAt: z.string(),
});
export type PerpmeApiToken = z.infer<typeof ApiToken>;
const TokenPage = z.object({ items: z.array(ApiToken), hasNextPage: z.boolean(), endCursor: z.string().nullable().optional() });

const Holder = z.object({ address, balance: uint });
const Trade = z.object({ trader: address, isBuy: z.boolean(), tokenAmount: uint, txHash: z.string(), blockNumber: uint });
const Page = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), totalCount: z.number().int().nonnegative(), pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }) });
const Graph = <T extends z.ZodType>(data: T) => z.object({ data });

export class PerpmeApi {
  private readonly fetch: Fetch;
  private readonly dexSync: string;
  private readonly indexer: string;

  constructor(opts: { fetch?: Fetch; dexSync?: string; indexer?: string } = {}) {
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.dexSync = (opts.dexSync ?? PERPME_DEX_SYNC).replace(/\/$/, "");
    this.indexer = opts.indexer ?? PERPME_INDEXER;
  }

  /** Every coin dex-sync lists (all factories), all pages. */
  async tokens(): Promise<PerpmeApiToken[]> {
    const out: PerpmeApiToken[] = [];
    let after: string | null | undefined = null;
    for (let page = 0; page < 200; page++) {
      const url = `${this.dexSync}/tokens?limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`;
      const p: z.infer<typeof TokenPage> = await getJson(this.fetch, url, TokenPage);
      out.push(...p.items);
      if (!p.hasNextPage || !p.endCursor) return out;
      after = p.endCursor;
    }
    throw new Error("PerpMe token list: more than 200 pages");
  }

  /** One coin as dex-sync lists it (its tradeCount among others), or null. */
  async token(token: Address): Promise<PerpmeApiToken | null> {
    const url = `${this.dexSync}/tokens?limit=1&where=${encodeURIComponent(JSON.stringify({ id: token.toLowerCase() }))}`;
    const p = await getJson(this.fetch, url, TokenPage);
    return p.items.find((t) => t.id === getAddress(token)) ?? null;
  }

  private async graph<T>(query: string, variables: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
    return getJson(this.fetch, this.indexer, Graph(schema), { method: "POST", body: { query, variables } }).then((g) => g.data);
  }

  /** Every address the indexer says holds the coin, with its balance (pool and factory included). */
  async holders(token: Address): Promise<Array<{ address: Address; balance: bigint }>> {
    const out: Array<{ address: Address; balance: bigint }> = [];
    let after: string | null = null;
    for (let page = 0; page < 100; page++) {
      const q = `query($t: String!, $a: String) { holders(where: { tokenId: $t }, limit: 1000, after: $a) { items { address balance } totalCount pageInfo { hasNextPage endCursor } } }`;
      const got: { holders: z.infer<ReturnType<typeof Page<typeof Holder>>> } = await this.graph(q, { t: token.toLowerCase(), a: after }, z.object({ holders: Page(Holder) }));
      out.push(...got.holders.items);
      if (!got.holders.pageInfo.hasNextPage) return out;
      after = got.holders.pageInfo.endCursor;
    }
    throw new Error(`PerpMe holders of ${token}: more than 100 pages`);
  }

  /** How many trades the indexer has for the coin. */
  async tradeCount(token: Address): Promise<number> {
    const q = `query($t: String!) { trades(where: { tokenId: $t }, limit: 1) { items { trader isBuy tokenAmount txHash blockNumber } totalCount pageInfo { hasNextPage endCursor } } }`;
    const got = await this.graph(q, { t: token.toLowerCase() }, z.object({ trades: Page(Trade) }));
    return got.trades.totalCount;
  }

  /** The block the indexer has read up to. */
  async indexedBlock(): Promise<bigint | null> {
    const q = `{ _meta { status } }`;
    const got = await this.graph(q, {}, z.object({ _meta: z.object({ status: z.record(z.string(), z.object({ block: z.object({ number: z.number() }).nullable() })) }) }));
    const b = Object.values(got._meta.status)[0]?.block?.number;
    return b === undefined ? null : BigInt(b);
  }
}
