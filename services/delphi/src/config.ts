// DELPHI: settings and the detection rules' thresholds. Read-only service: no keys, no transactions.
import { getAddress, isAddress, type Address } from "viem";
import { z } from "zod";

const address = z
  .string()
  .refine((v) => isAddress(v, { strict: false }), "must be an EVM address")
  .transform((v) => getAddress(v));
const wholeNumber = z.string().trim().regex(/^\d+$/, "must be a whole number").transform(Number);
const httpUrl = z.url({ protocol: /^https?$/ });

const EnvSchema = z.object({
  ELYSIUM_RPC: httpUrl.default("https://testnet-rpc.elysium.kinetiq.xyz"),
  EXPLORER_API: httpUrl.default("https://elysium.kinetiq.xyz/api/v2"),
  EXPLORER_WEB: httpUrl.default("https://elysium.kinetiq.xyz/testnet-explorer"),
  // Ascend redeploys often: the launchpad is configurable; everything else is read from it.
  LAUNCHPAD: address.default("0xE2f6254508DEB93Da081837F545e0bAF7b00d8E9"),
  FROM_BLOCK: wholeNumber.default(3_574_000),
  DB_PATH: z.string().min(1).default("data/delphi.db"),
  OUT_DIR: z.string().min(1).default("out"),
});

export type Config = Readonly<{
  elysiumRpc: string;
  explorerApi: string;
  explorerWeb: string;
  launchpad: Address;
  fromBlock: bigint;
  dbPath: string;
  outDir: string;
}>;

export class ConfigError extends Error {
  override name = "ConfigError";
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ""));
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    throw new ConfigError(`invalid delphi config:\n  ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n  ")}`);
  }
  const e = parsed.data;
  return Object.freeze({
    elysiumRpc: e.ELYSIUM_RPC,
    explorerApi: e.EXPLORER_API,
    explorerWeb: e.EXPLORER_WEB.replace(/\/$/, ""),
    launchpad: e.LAUNCHPAD,
    fromBlock: BigInt(e.FROM_BLOCK),
    dbPath: e.DB_PATH,
    outDir: e.OUT_DIR,
  });
}

/**
 * Infrastructure that is never a "holder" or "trader". The launchpad's own addresses (vault, pool
 * manager, treasuries, ListingDesk) are read from it live, and any contract seen calling the pool
 * manager for a swap is treated as a router. Checked on Elysium testnet 2026-10-14.
 */
export const STATIC_SYSTEM: readonly Address[] = [
  "0x90332B0ECbb2c9517F405627b0Dd5D5265246563", // Ascend UniversalRouter (verified on the explorer)
  "0xC889ac2f59A88afb3B2FB3f2C452DBa336fE5f0F", // BurnSink: burned supply, 16 bytes of code, no functions
  "0xcA11bde05977b3631167028862bE2a173976CA11", // Multicall3
  "0x000000000000000000000000000000000000dEaD",
  "0x0000000000000000000000000000000000000000",
];

/** Public funders (faucets) seen live; also caught generically by RULES.hub. */
export const KNOWN_HUBS: readonly Address[] = [
  "0xf272Cc84C3BA9f1B498adE29aaeED1e7D2D9f3fD", // Elysium testnet faucet: 164,840 txs, drips of 0.1 HYPE
];

/**
 * The rules, in one place, versioned with every report so a verdict can always be re-derived.
 * Plain thresholds on purpose: v0 must be explainable to a judge in one sentence each.
 */
export const RULES = {
  version: "delphi-v0.1",
  /**
   * A funder with this many transactions is public (faucet, bridge, exchange) and links nobody.
   * Not "funded many wallets": a sybil farmer does that too. Sheer activity is what separates them
   * (the testnet faucet has 164,840 txs; a farmer's funder has dozens).
   */
  hub: { minTxCount: 5_000 },
  bundle: {
    /** Buys this soon after the launch transaction count as "at launch". */
    windowSec: 30,
    /** Share of total supply bought by linked wallets at launch (creator included). */
    watchPct: 5,
    flagPct: 15,
    minLinkedWallets: 2,
  },
  wash: {
    /**
     * A buy and a sell by the same actor (one wallet, or wallets linked into one cluster) this close
     * together are a round trip. Selling days later is just a trade; churning within minutes is wash.
     */
    pairWindowSec: 300,
    watchPct: 25,
    flagPct: 50,
    minTrades: 6,
  },
  concentration: {
    watchPct: 20,
    flagPct: 40,
    minHolders: 5,
  },
} as const;

/** Every launched Ascend token has exactly this supply (AscendLaunchpad TOTAL_SUPPLY). */
export const TOTAL_SUPPLY = 1_000_000_000n * 10n ** 18n;
