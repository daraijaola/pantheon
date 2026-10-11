// HYPE Passport attestor: environment + constants (docs/PASSPORT_SPEC.md §1, §2.11, §4, §7).
// Secrets are configured as FILE PATHS, never values (§7, §9).
import { getAddress, isAddress, type Address } from "viem";
import { z } from "zod";

// ---------------------------------------------------------------- environment

const address = z
  .string()
  .refine((v) => isAddress(v, { strict: false }), "must be an EVM address")
  .transform((v) => getAddress(v));

// A raw private key or pepper (32 bytes hex) pasted where a path belongs.
const RAW_SECRET = /^(0x)?[0-9a-fA-F]{64}$/;
const secretPath = z
  .string()
  .min(1)
  .refine((v) => !RAW_SECRET.test(v.trim()), "must be a path to a key file, not the key itself");

// Digits only: z.coerce.number() would also accept "1e3", "0x10" and " 8787 ".
const wholeNumber = z.string().trim().regex(/^\d+$/, "must be a whole number").transform(Number);
const positiveInt = wholeNumber.pipe(z.number().int().positive());

// z.url() alone accepts any scheme (javascript:, file:, ftp:). z.httpUrl() would reject
// http://127.0.0.1 mocks, so restrict the protocol only.
const httpUrl = z.url({ protocol: /^https?$/ });

const EnvSchema = z.object({
  CHAIN_ID: positiveInt.default(99801),
  ELYSIUM_RPC: httpUrl.default("https://testnet-rpc.elysium.kinetiq.xyz"),
  HYPEREVM_RPC: httpUrl.default("https://rpc.hyperliquid.xyz/evm"),
  HL_INFO_URL: httpUrl.default("https://api.hyperliquid.xyz/info"),
  // Unset until Micheal/Claude deploy HypePassportRegistry (P9).
  REGISTRY_ADDRESS: address.optional(),
  ATTESTOR_KEY_FILE: secretPath.default("/var/lib/passport/keys/attestor.key"),
  RELAYER_KEY_FILE: secretPath.default("/var/lib/passport/keys/relayer.key"),
  PEPPER_FILE: secretPath.default("/var/lib/passport/keys/pepper"),
  DB_PATH: z.string().min(1).default("/var/lib/passport/passport.db"),
  HL_WEIGHT_PER_MIN: positiveInt.default(800),
  EVM_REQ_PER_MIN: positiveInt.default(60),
  PORT: wholeNumber.pipe(z.number().int().min(1).max(65_535)).default(8787),
});

export type Config = Readonly<{
  chainId: number;
  elysiumRpc: string;
  hyperEvmRpc: string;
  hlInfoUrl: string;
  registryAddress: Address | undefined;
  attestorKeyFile: string;
  relayerKeyFile: string;
  pepperFile: string;
  dbPath: string;
  hlWeightPerMin: number;
  evmReqPerMin: number;
  port: number;
  host: typeof BIND_HOST;
}>;

/** Services bind to loopback only; Caddy routes `/api/passport/*` here (AGENTS.md). */
export const BIND_HOST = "127.0.0.1";

export class ConfigError extends Error {
  override name = "ConfigError";
}

/** Parse and validate the environment. Messages name the variable, never its value. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  // Treat empty strings (e.g. `REGISTRY_ADDRESS=` in .env) as unset.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ""));
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new ConfigError(`invalid passport config:\n  ${problems.join("\n  ")}`);
  }
  const e = parsed.data;
  return Object.freeze({
    chainId: e.CHAIN_ID,
    elysiumRpc: e.ELYSIUM_RPC,
    hyperEvmRpc: e.HYPEREVM_RPC,
    hlInfoUrl: e.HL_INFO_URL,
    registryAddress: e.REGISTRY_ADDRESS,
    attestorKeyFile: e.ATTESTOR_KEY_FILE,
    relayerKeyFile: e.RELAYER_KEY_FILE,
    pepperFile: e.PEPPER_FILE,
    dbPath: e.DB_PATH,
    hlWeightPerMin: e.HL_WEIGHT_PER_MIN,
    evmReqPerMin: e.EVM_REQ_PER_MIN,
    port: e.PORT,
    host: BIND_HOST,
  });
}

// ---------------------------------------------------------------- chains and addresses (§1)

export const ELYSIUM_TESTNET_CHAIN_ID = 99801;
export const HYPEREVM_CHAIN_ID = 999;

/** HyperEVM mainnet (chain 999), verified live 2026-10-11 (§1.2). */
export const HYPEREVM = {
  KHYPE: "0xfD739d4e423301CE9385c1fb8850539D657C296D",
  STAKING_ACCOUNTANT: "0x9209648Ec9D448EF57116B73A2f081835643dc7A", // kHYPEToHYPE(uint256)
  WHYPE: "0x5555555555555555555555555555555555555555",
  KNTQ: "0x000000000000780555bD0BCA3791f89f9542c2d6", // EVM side of HyperCore token 124
  HYPURR: "0x9125E2d6827a00B0F8330D6ef7BEF07730Bac685",
  MULTICALL3: "0xcA11bde05977b3631167028862bE2a173976CA11",
} as const satisfies Record<string, Address>;

/** HyperCore spot token indices (`spotMeta`, §1.2). */
export const HL_TOKEN = { USDC: 0, KNTQ: 124, HYPE: 150 } as const;

// ---------------------------------------------------------------- HL info API budget (§2.11)

/**
 * Weight of each info request type; the service budget is HL_WEIGHT_PER_MIN (HL's IP cap is 1200/min).
 * Per the HL rate-limit docs: userRole 60; clearinghouseState and spotClearinghouseState 2; other
 * documented requests 20. extraAgents and userToMultiSigSigners are undocumented: 20 is assumed.
 */
export const HL_WEIGHT = {
  userRole: 60,
  extraAgents: 20,
  spotClearinghouseState: 2,
  borrowLendUserState: 20,
  delegatorSummary: 20,
  userNonFundingLedgerUpdates: 20,
  portfolio: 20,
  subAccounts: 20,
  userToMultiSigSigners: 20,
  clearinghouseState: 2,
} as const;

/** Airdrop window queried for the GENESIS stamp (§2.6): 2024-11-29 00:00 → 2024-11-30 00:00 UTC. */
export const GENESIS_WINDOW_MS = { start: 1_732_838_400_000, end: 1_732_924_800_000 } as const;

// ---------------------------------------------------------------- scoring (§4)

/** Amounts are fixed-point bigint in 1e8 units (HyperCore's precision). */
export const E8 = 100_000_000n;
export const BPS = 10_000n;
export const DAY_MS = 86_400_000;

/** S = staked × W_STAKED + liquid × W_LIQUID, with kHYPE (in HYPE) weighted W_KHYPE (§4.1). */
export const WEIGHT_BPS = { STAKED: 10_000n, LIQUID: 5_000n, KHYPE: 5_000n } as const;

/** Minimum score (E8) and HL account age (days) per tier (§4.2). Index = tier. */
export const TIERS = [
  { tier: 0, name: "none", minScoreE8: 0n, minAgeDays: 0 },
  { tier: 1, name: "Holder", minScoreE8: 10n * E8, minAgeDays: 0 },
  { tier: 2, name: "Staker", minScoreE8: 100n * E8, minAgeDays: 30 },
  { tier: 3, name: "Pillar", minScoreE8: 1_000n * E8, minAgeDays: 90 },
] as const;

/** HL roles that can never hold a passport (§4.2); `missing` is capped at tier 1 by age 0. */
export const REJECTED_ROLES = ["agent", "vault", "subAccount"] as const;

/** Stamp bitmap (§4.3). Bits 8–31 are reserved and must stay 0. */
export const STAMP = {
  STAKER: 1 << 0,
  KHYPE: 1 << 1,
  GENESIS: 1 << 2,
  VETERAN: 1 << 3,
  TRADER: 1 << 4,
  HYPURR: 1 << 5,
  KNTQ: 1 << 6,
  SEASONED: 1 << 7,
} as const;
export const STAMP_MASK = 0xff;

export const STAMP_RULES = {
  stakerMinE8: 10n * E8,
  khypeMinE8: 10n * E8,
  veteranMinAgeDays: 365,
  traderMinVolumeUsd: 1_000_000,
  hypurrMinCount: 1n,
  kntqMinE8: 1_000n * E8,
  seasonedMinAgeDays: 30,
} as const;

// ---------------------------------------------------------------- link, attestation and re-check timing (§5, §7.2)

const SECOND = 1;
const HOUR = 3_600 * SECOND;

/** Durations in seconds (on-chain timestamps are seconds). */
export const TIMING = {
  linkDeadline: 15 * 60 * SECOND,
  attestationTtl: 7 * 24 * HOUR,
  attestationDeadline: 1 * HOUR,
  renewBefore: 48 * HOUR,
  upgradeConfirmGap: 20 * HOUR,
  recheckBase: 12 * HOUR,
  recheckJitter: 24 * HOUR,
  unlinkPoll: 60 * SECOND,
  forgetUnlinkedAfter: 7 * 24 * HOUR,
} as const;
