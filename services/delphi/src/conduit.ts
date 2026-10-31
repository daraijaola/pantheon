// Conduit's services for Elysium: its contract verifier (a Sourcify v2 server, the one the explorer
// itself asks for verified ABIs) and the explorer's own HTTP API (who deployed a contract).
//
// What we learned live (2026-10-31):
// - contracts.conduit.xyz/v2/contract/<chainId>/<address> is Sourcify's v2 API. 404 means not verified.
//   A hit carries the verified ABI, the compiler and the on-chain bytecode it was matched against. 81
//   contracts were verified on chain 99801 (/v2/contracts/99801 lists them).
// - The explorer's /api/abi/batch is NOT verification: it guesses an ABI from the bytecode's selectors
//   and a public signature database (every function "nonpayable", no outputs, junk names such as
//   transfer_attention_tg_invmru_ec11fa8). It must never count as verified, and DELPHI does not use it.
// - /api/contract/creation/<address> names the deploying transaction and its sender for a contract made
//   by a wallet. For a contract made by another contract (a factory, a launchpad) it gives only the block.
import { getAddress, isAddress, isHex, type Address, type Hex } from "viem";
import { z } from "zod";
import { getJson, type Fetch } from "./http.ts";

export const CONTRACTS_API = "https://contracts.conduit.xyz";
export const EXPLORER_WEB = "https://test-explorer.elysium.kinetiq.xyz";

const hex = z.string().refine((v) => isHex(v)) as unknown as z.ZodType<Hex>;
const address = z
  .string()
  .refine((v) => isAddress(v, { strict: false }))
  .transform((v) => getAddress(v));
const matchLevel = z.enum(["match", "exact_match"]).nullable();

const AbiParam: z.ZodType<{ type: string; components?: unknown[] }> = z.looseObject({ type: z.string(), components: z.array(z.unknown()).optional() });
const AbiItem = z.looseObject({
  type: z.string(),
  name: z.string().optional(),
  stateMutability: z.string().optional(),
  inputs: z.array(AbiParam).optional(),
});
export type AbiItem = z.infer<typeof AbiItem>;

const Verified = z.object({
  match: matchLevel,
  runtimeMatch: matchLevel,
  creationMatch: matchLevel,
  verifiedAt: z.string().nullable().optional(),
  abi: z.array(AbiItem).nullable().optional(),
  compilation: z
    .object({ name: z.string().nullable().optional(), fullyQualifiedName: z.string().nullable().optional(), compilerVersion: z.string().nullable().optional(), language: z.string().nullable().optional() })
    .nullable()
    .optional(),
  runtimeBytecode: z.object({ onchainBytecode: hex.nullable() }).nullable().optional(),
  proxyResolution: z
    .object({ isProxy: z.boolean(), proxyType: z.string().nullable(), implementations: z.array(z.object({ address })) })
    .nullable()
    .optional(),
});

/** What the verifier says about one contract. */
export type Verification = {
  /** The verifier matched source to this address's runtime code. */
  matched: boolean;
  match: "match" | "exact_match" | null;
  runtimeMatch: "match" | "exact_match" | null;
  name: string | null;
  compiler: string | null;
  verifiedAt: string | null;
  abi: AbiItem[];
  /** The bytecode the source was matched against, as the verifier read it from the chain. */
  onchainBytecode: Hex | null;
  proxy: { type: string | null; implementations: Address[] } | null;
};

const NOT_VERIFIED: Verification = {
  matched: false,
  match: null,
  runtimeMatch: null,
  name: null,
  compiler: null,
  verifiedAt: null,
  abi: [],
  onchainBytecode: null,
  proxy: null,
};

/** Only the fields DELPHI uses, so answers (and test fixtures) stay small: no sources. */
const FIELDS = ["abi", "compilation.name", "compilation.compilerVersion", "compilation.language", "runtimeBytecode.onchainBytecode", "proxyResolution"].join(",");

/** Conduit's contract verifier (Sourcify v2). */
export class ContractsApi {
  readonly base: string;
  private readonly fetch: Fetch;
  private readonly sleep: ((ms: number) => Promise<void>) | undefined;

  constructor(opts: { base?: string; fetch?: Fetch; sleep?: (ms: number) => Promise<void> } = {}) {
    this.base = (opts.base ?? CONTRACTS_API).replace(/\/$/, "");
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.sleep = opts.sleep;
  }

  /** Verified source for `address` on `chainId`, or "not verified". */
  async verification(chainId: number, address: Address): Promise<Verification> {
    const url = `${this.base}/v2/contract/${chainId}/${address}?fields=${FIELDS}`;
    const v = await getJson(this.fetch, url, Verified, { notFoundIsNull: true, sleep: this.sleep });
    if (!v) return NOT_VERIFIED;
    const runtimeMatch = v.runtimeMatch ?? null;
    return {
      matched: runtimeMatch !== null,
      match: v.match ?? null,
      runtimeMatch,
      name: v.compilation?.name ?? null,
      compiler: v.compilation?.compilerVersion ?? null,
      verifiedAt: v.verifiedAt ?? null,
      abi: v.abi ?? [],
      onchainBytecode: v.runtimeBytecode?.onchainBytecode ?? null,
      proxy: v.proxyResolution?.isProxy ? { type: v.proxyResolution.proxyType, implementations: v.proxyResolution.implementations.map((i) => i.address) } : null,
    };
  }
}

const Creation = z.object({
  creation: z
    .object({
      blockNumber: z.string().regex(/^\d+$/).nullable(),
      timestamp: z.string().regex(/^\d+$/).nullable(),
      hash: hex.nullable(),
      from: address.nullable(),
    })
    .nullable(),
  error: z.unknown().nullable().optional(),
});

/** Where a contract came from. `tx` and `sender` are null when another contract created it. */
export type Creation = { block: bigint; time: number | null; tx: Hex | null; sender: Address | null };

/** The Conduit explorer's own HTTP API. */
export class ExplorerApi {
  readonly base: string;
  private readonly fetch: Fetch;
  private readonly sleep: ((ms: number) => Promise<void>) | undefined;

  constructor(opts: { base?: string; fetch?: Fetch; sleep?: (ms: number) => Promise<void> } = {}) {
    this.base = (opts.base ?? EXPLORER_WEB).replace(/\/$/, "");
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.sleep = opts.sleep;
  }

  /** The block (and, for a wallet's deploy, the transaction and sender) that created `address`. */
  async creation(address: Address): Promise<Creation | null> {
    const c = (await getJson(this.fetch, `${this.base}/api/contract/creation/${address}`, Creation, { sleep: this.sleep })).creation;
    if (!c?.blockNumber) return null;
    return { block: BigInt(c.blockNumber), time: c.timestamp ? Number(c.timestamp) : null, tx: c.hash, sender: c.from };
  }
}
