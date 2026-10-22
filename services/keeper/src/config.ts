// Keeper settings. Practice mode ("dry") is the default: it simulates everything and sends nothing.
// Live mode needs a gas-only key file (mode 0600); creating or funding that key needs Micheal's OK.
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { getAddress, isAddress } from "viem";
import { z } from "zod";

const address = z
  .string()
  .refine((v) => isAddress(v, { strict: false }), "must be an EVM address")
  .transform((v) => getAddress(v));
const wholeNumber = z.string().trim().regex(/^\d+$/, "must be a whole number").transform(Number);

const EnvSchema = z.object({
  ELYSIUM_RPC: z.url({ protocol: /^https?$/ }).default("https://testnet-rpc.elysium.kinetiq.xyz"),
  /** The addresses the site uses too (written by the deploy script). */
  DEPLOYMENT_FILE: z.string().min(1).default("../../deployments/elysium-testnet.json"),
  PASSPORT_API: z.url({ protocol: /^https?$/ }).default("http://127.0.0.1:8787"),
  KEEPER_MODE: z.enum(["dry", "live"]).default("dry"),
  KEEPER_KEY_FILE: z.string().min(1).default("/var/lib/keeper/keys/keeper.key"),
  INTERVAL_SEC: wholeNumber.pipe(z.number().min(60)).default(300),
  /** How many basket coins one rebalance buys (round-robin); Micheal's script uses 5. */
  BASKET_K: wholeNumber.pipe(z.number().min(1).max(10)).default(5),
  /** Refresh a boost that would rise by at least this much (a boost that would fall is always refreshed). */
  POKE_RISE_BPS: wholeNumber.pipe(z.number().min(1).max(10_000)).default(200),
  /** Most accounts in one poke transaction (~450k gas each on Oct 22; a heavier batch is split anyway). */
  POKE_BATCH: wholeNumber.pipe(z.number().min(1).max(200)).default(20),
  /** First block to look for stakers in (just before the Oct 14 deployment). */
  FROM_BLOCK: wholeNumber.default(9_127_000),
  STATE_FILE: z.string().min(1).default("data/state.json"),
});

const DeploymentSchema = z.object({
  chainId: z.literal(99_801),
  pnth: address,
  pnthRouter: address,
  indexVault: address,
  constituentRegistry: address,
  staking: address,
  passportRegistry: address,
  usdc: address,
  burnSink: address,
});
export type Deployment = z.infer<typeof DeploymentSchema>;

export type Config = Readonly<{
  rpc: string;
  passportApi: string;
  mode: "dry" | "live";
  keyFile: string;
  intervalSec: number;
  basketK: number;
  pokeRiseBps: number;
  pokeBatch: number;
  fromBlock: bigint;
  stateFile: string;
  deployment: Deployment;
}>;

export class ConfigError extends Error {
  override name = "ConfigError";
}

const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n  ");

export function loadConfig(env: Record<string, string | undefined> = process.env, readFile = (p: string) => readFileSync(p, "utf8")): Config {
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ""));
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) throw new ConfigError(`invalid keeper config:\n  ${issues(parsed.error)}`);
  const e = parsed.data;

  let raw: unknown;
  try {
    raw = JSON.parse(readFile(resolve(e.DEPLOYMENT_FILE)));
  } catch (err) {
    throw new ConfigError(`cannot read DEPLOYMENT_FILE ${e.DEPLOYMENT_FILE}: ${(err as Error).message}`);
  }
  const deployment = DeploymentSchema.safeParse(raw);
  if (!deployment.success) throw new ConfigError(`bad deployment file ${e.DEPLOYMENT_FILE}:\n  ${issues(deployment.error)}`);

  return Object.freeze({
    rpc: e.ELYSIUM_RPC,
    passportApi: e.PASSPORT_API.replace(/\/$/, ""),
    mode: e.KEEPER_MODE,
    keyFile: e.KEEPER_KEY_FILE,
    intervalSec: e.INTERVAL_SEC,
    basketK: e.BASKET_K,
    pokeRiseBps: e.POKE_RISE_BPS,
    pokeBatch: e.POKE_BATCH,
    fromBlock: BigInt(e.FROM_BLOCK),
    stateFile: e.STATE_FILE,
    deployment: deployment.data,
  });
}

/**
 * The gas key for live mode: a file only its owner can read, holding 32 bytes of hex. Never logged.
 * Only called in live mode, so practice mode never touches a key.
 */
export function readKeeperKey(path: string): `0x${string}` {
  const { mode } = statSync(path);
  if ((mode & 0o077) !== 0) throw new ConfigError(`refusing ${path}: mode ${(mode & 0o777).toString(8)}, must be 0600 or 0400`);
  const v = readFileSync(path, "utf8").trim();
  const hex = v.startsWith("0x") ? v : `0x${v}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw new ConfigError(`${path} must hold 32 bytes of hex`);
  return hex as `0x${string}`;
}

