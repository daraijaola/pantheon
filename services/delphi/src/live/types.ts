// DELPHI live: the shared shapes for watching new coins as they launch and serving what DELPHI knows
// about them to other apps (Kalos's Sniper first). Three "doors" bring coins in: PerpMe launches,
// new pools on Kalos's exchange, and Ascend launches. Every coin gets a feed record at once ("checking")
// that fills in over its first hour. The record format is versioned: a meaning never changes within v1.
import { parseAbiItem, type Address, type Hex } from "viem";
import { z } from "zod";

/** Where a coin comes from. */
export type Venue = "perpme" | "kalos" | "ascend";

/**
 * PerpMe, the launchpad whose coins fill Kalos's Sniper. Its testnet deployment, as Kalos pins it
 * (kalos-perpme-deployment.js, observed at block 15,213,780; perpme.fun/elysium/docs). Fee tiers 1% and 2%.
 * Every address changes on mainnet: these are settings, never assumptions elsewhere.
 */
export const PERPME_TESTNET = {
  launchFactory: "0x296a8d32ac9315cd9aaa33b1e624eb206d35638c",
  poolFactory: "0x1186DEFCaf121Da6E773425Fec0814608798e792",
  positionManager: "0xD85fC505093A6b4a2AfE6CE5069cE6E4e0c9eA83",
  router: "0xD218817cfCcA3Ae397dE3a6E66889D4Fb4b9e2D1",
  quoter: "0x2A2b7645839e55A1683E7Fd64436AEEd5ed2793C",
  /** PerpMe's own wrapped HYPE (not Kalos's). */
  whype: "0x757a34dd7b411546C6dd8f510B52e4381102f9B0",
  /** The launch factory's deployment (Oct 21): no PerpMe coin is older. */
  fromBlock: 13_700_000n,
} as const satisfies Record<string, string | bigint>;

/** One transaction makes the token, its pool and liquidity, and the creator's first buy (all 1,530 testnet launches). */
export const TOKEN_DEPLOYED = parseAbiItem(
  "event TokenDeployed(address indexed token, address indexed deployer, address indexed pairToken, uint256 dexId, uint256 launchConfigId, string name, string symbol, string metadataURI)",
);
export const TOKEN_LAUNCHED = parseAbiItem(
  "event TokenLaunched(address indexed token, address indexed deployer, address indexed pool, address pairToken, uint256 dexId, uint256 launchConfigId, uint256 positionId, uint256 restrictionEndBlock, uint256 initialBuyAmount, uint256 initialBuyTokens)",
);

/** A coin the moment a door sees it: what its launch transaction alone says. */
export type NewCoin = {
  venue: Venue;
  token: Address;
  /** The main pool: a pool address (PerpMe, Kalos) or Ascend's pool id. */
  pool: Hex;
  /** Who made it: PerpMe's deployer, Ascend's creator role, or the token contract's deployer on Kalos. */
  creator: Address;
  /** The other side of the pool (WHYPE, USDC…). */
  quote: Address;
  tx: Hex;
  block: bigint;
  time: number;
  /** The creator's own buy in the launch transaction, in token units (0n if none or unknown yet). */
  creatorBuyTokens: bigint;
  name: string | null;
  symbol: string | null;
  /** PerpMe: the block until which buys are restricted (an anti-sniper window, about 6 minutes). */
  restrictionEndBlock?: bigint;
};

// ---------------------------------------------------------------------------------------------------
// The feed record, v1. Strict JSON: raw integers as decimal strings, addresses lowercase, text capped.

const addr = z.string().regex(/^0x[0-9a-f]{40}$/);
const hash = z.string().regex(/^0x[0-9a-f]{64}$/);
const uint = z.string().regex(/^\d+$/);
const text = (max: number) => z.string().max(max);

/** One thing DELPHI found or noted, in one short line, with the transactions behind it. */
export const FeedCheck = z.object({
  /** Stable machine code, e.g. "bundle", "wash", "whales", "one-wallet", "mint-power", "sell-blocked", "fake-ticker". */
  code: z.string().regex(/^[a-z0-9-]{2,32}$/),
  /** "flag" and "watch" are findings; "ok" says the check ran and found nothing; "info" is context, never a warning. */
  result: z.enum(["flag", "watch", "ok", "info", "pending", "not-enough-data"]),
  text: text(160),
  evidence: z.array(hash).max(8),
});
export type FeedCheck = z.infer<typeof FeedCheck>;

export const FeedRecord = z.object({
  v: z.literal(1),
  chainId: z.number().int(),
  token: addr,
  venue: z.enum(["perpme", "kalos", "ascend"]),
  pool: z.string().regex(/^0x[0-9a-f]{40}$|^0x[0-9a-f]{64}$/),
  symbol: text(40).nullable(),
  name: text(40).nullable(),
  /** "pending": just launched, checks running; "ready": checked; "thin": checked, but too little trading to judge much yet. */
  state: z.enum(["pending", "ready", "thin"]),
  verdict: z.enum(["FLAG", "WATCH", "CLEAN", "NOT_ENOUGH_DATA", "CHECKING"]),
  /** The worst finding first, then the rest; context lines come last with result "info". */
  checks: z.array(FeedCheck).max(16),
  /** Kalos's Sniper shapes: holders(t) and dev(t). Shares are fractions 0–1; top10 is a percent. */
  holders: z
    .object({
      count: z.number().int().nonnegative(),
      top10: z.number().min(0).max(100),
      rows: z.array(z.object({ address: addr, balance: uint, share: z.number().min(0).max(1), pool: z.boolean(), dev: z.boolean(), linkedTo: addr.nullable() })).max(20),
    })
    .nullable(),
  dev: z.object({ address: addr, share: z.number().min(0).max(1), sold: z.boolean() }).nullable(),
  /** Separate people behind the wallets that traded or hold it (linked wallets count once). */
  people: z.object({ wallets: z.number().int().nonnegative(), people: z.number().int().nonnegative() }).nullable(),
  /** Set when the name or ticker copies a known token at another address. */
  fakeTickerOf: z.object({ symbol: text(40), address: addr, source: text(40) }).nullable(),
  launch: z.object({ tx: hash, block: uint, timeMs: z.number().int(), creator: addr, creatorBuyShare: z.number().min(0).max(1) }),
  rules: text(40),
  block: uint,
  blockHash: hash.nullable(),
  checkedAtMs: z.number().int(),
  expiresAtMs: z.number().int(),
  /** Always true: DELPHI reports patterns, not intent, and never holds or moves funds. */
  displayOnly: z.literal(true),
  reportUrl: z.string().url(),
  disputeUrl: z.string().url(),
});
export type FeedRecord = z.infer<typeof FeedRecord>;

/** A dispute about a record: kept, answered by a person, and logged with the verdict history. */
export const Dispute = z.object({
  token: addr,
  contact: text(120),
  message: text(1200),
});
export type Dispute = z.infer<typeof Dispute>;
