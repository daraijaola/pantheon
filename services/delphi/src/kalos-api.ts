import { profile } from "../../network.mts";
// Kalos, the Uniswap-V3-style DEX on Elysium: its contract addresses and its token list, read from
// api.kalos.fun (checked live 2026-10-31: 22 tokens, 38 pools). The API sometimes answers
// `{"error":"unavailable","detail":{"reason":"refreshing"}}` for a moment; that answer is retried.
import { getAddress, isAddress, type Address } from "viem";
import { z } from "zod";
import { getJson, type Fetch } from "./http.ts";

export const KALOS_API = profile(process.env, "delphi").network.external.kalos.api;

/** Kalos's contracts on Elysium testnet, as /v2/dex/config listed them on 2026-10-31. */
export const KALOS_CONTRACTS = profile(process.env, "delphi").network.external.kalos.pinned satisfies Record<string, Address>;
export type KalosContracts = { readonly [K in keyof typeof KALOS_CONTRACTS]: Address };

const address = z
  .string()
  .refine((v) => isAddress(v, { strict: false }))
  .transform((v) => getAddress(v));

const Config = z.object({
  chainId: z.number(),
  contracts: z.object({ factory: address, positionManager: address, swapRouter: address, quoterV2: address, whype: address }),
});

const Token = z.object({
  address,
  /** Kalos lists tokens whose contract has no symbol or name (seen Nov 1): those are null. */
  symbol: z.string().nullable(),
  name: z.string().nullable(),
  decimals: z.number().int(),
  wrappedNative: z.boolean(),
  /** Kalos's own approval. */
  approved: z.boolean(),
  /** How the token entered the list ("reviewed_fixed", "reviewed_vault", "listed_partial", "discovered_partial"…). */
  registration: z.string(),
});
export type KalosToken = z.infer<typeof Token>;

const TokenPage = z.object({ rows: z.array(Token), next: z.string().nullable().optional() });

const refreshing = (body: unknown) => typeof body === "object" && body !== null && (body as { error?: unknown }).error === "unavailable";

export class KalosApi {
  readonly base: string;
  private readonly fetch: Fetch;
  private readonly sleep: ((ms: number) => Promise<void>) | undefined;

  constructor(opts: { base?: string; fetch?: Fetch; sleep?: (ms: number) => Promise<void> } = {}) {
    this.base = (opts.base ?? KALOS_API).replace(/\/$/, "");
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.sleep = opts.sleep;
  }

  /** Kalos's contract addresses and chain. */
  async config(): Promise<{ chainId: number; contracts: KalosContracts }> {
    const config = await getJson(this.fetch, `${this.base}/v2/dex/config`, Config, { retryIf: refreshing, retries: 5, sleep: this.sleep });
    if (config.chainId !== profile().chainId) throw new Error("Kalos API chainId does not match selected deployment");
    return config;
  }

  /** Every token in Kalos's list, all pages. */
  async tokens(): Promise<KalosToken[]> {
    const out: KalosToken[] = [];
    let cursor: string | null | undefined = null;
    for (let page = 0; page < 50; page++) {
      const url = `${this.base}/v2/dex/tokens${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`;
      const p: z.infer<typeof TokenPage> = await getJson(this.fetch, url, TokenPage, { retryIf: refreshing, retries: 5, sleep: this.sleep });
      out.push(...p.rows);
      cursor = p.next;
      if (!cursor) return out;
    }
    throw new Error("Kalos token list: more than 50 pages");
  }
}
