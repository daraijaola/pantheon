// DELPHI: settings and the detection rules' thresholds. Read-only service: no wallet keys, no transactions.
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
  /** Which rule profile to use. Unset: read from the chain settings (a testnet RPC or explorer means testnet). */
  NETWORK: z.enum(["testnet", "mainnet"]).optional(),
});

/**
 * Testnet or mainnet. Test money changes behaviour: on a testnet people fund many wallets from one, run
 * distribution bots and farm, so some rules are looser there (see RULES.hub). Mainnet is the strict default.
 */
export type Network = "testnet" | "mainnet";

export type Config = Readonly<{
  elysiumRpc: string;
  explorerApi: string;
  explorerWeb: string;
  launchpad: Address;
  fromBlock: bigint;
  dbPath: string;
  outDir: string;
  network: Network;
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
    network: e.NETWORK ?? networkOf(e.ELYSIUM_RPC, e.EXPLORER_WEB),
  });
}

/** The network named by the chain settings: any testnet RPC or explorer address means testnet. */
export function networkOf(...urls: string[]): Network {
  return urls.some((u) => /testnet/i.test(u)) ? "testnet" : "mainnet";
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
  version: "delphi-v0.3",
  hub: {
    /**
     * A funder with this many transactions is public (faucet, bridge, exchange) and links nobody, on any
     * network (the testnet faucet has 164,840 txs; a farmer's funder has dozens).
     */
    minTxCount: 5_000,
    /**
     * Testnet only (v0.3): a wallet that paid HYPE to this many of the wallets DELPHI tracks is a
     * distribution bot or a farm, not a coin's insider. Seen live: 211 farm funders paid 10 to 19 wallets
     * each, and only 3 paid 20 or more (186, 29 and 24, the last a game's payout bot).
     */
    testnetFanoutWallets: 20,
    /**
     * Testnet only (v0.3): a wallet that paid HYPE to at least `wallets` tracked wallets which between them
     * traded `coins` or more different coins seeds wallets for all kinds of uses: it links no one. A ring
     * seeds wallets for the coin it pumps.
     */
    testnetFanoutCoins: { wallets: 5, coins: 5 },
  },
  /**
   * How wallets join into one actor (v0.3). Only direct evidence can make a FLAG: one private funder's
   * own star of wallets, a wallet funding another, tokens passed between wallets, a trade made for another
   * wallet, the launcher naming another creator. Groups never chain through two different funders.
   * HYPE a contract paid out inside someone else's transaction is second-hand: it counts only when one
   * transaction paid two or more of the coin's wallets (a batch), and then supports a WATCH at most.
   */
  link: { secondHandMax: "watch" },
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
  /** A report notes how much contracts (staking, lockers…) hold once it reaches this share. v0.2. */
  contracts: {
    notePct: 10,
  },
} as const;

/** Every launched Ascend token has exactly this supply (AscendLaunchpad TOTAL_SUPPLY). */
export const TOTAL_SUPPLY = 1_000_000_000n * 10n ** 18n;
