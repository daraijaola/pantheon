// Indexer settings. Read-only: no keys, nothing to sign. A wrong value stops it at start.
import { readFileSync } from "node:fs";
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
  EXPLORER_WEB: z.url({ protocol: /^https?$/ }).default("https://elysium.kinetiq.xyz/testnet-explorer"),
  DEPLOYMENT_FILE: z.string().min(1).default("../../deployments/elysium-testnet.json"),
  /** 8788 is Micheal's development Passport; the live Passport is 8787. */
  PORT: wholeNumber.pipe(z.number().min(1024).max(65_535)).default(8789),
  POLL_SEC: wholeNumber.pipe(z.number().min(5)).default(30),
  /** Just before the Oct 14 deployment. */
  FROM_BLOCK: wholeNumber.default(9_127_000),
  STATE_FILE: z.string().min(1).default("data/index.json"),
});

const DeploymentSchema = z.object({
  chainId: z.literal(99_801),
  pnth: address,
  pnthRouter: address,
  indexVault: address,
  constituentRegistry: address,
  staking: address,
  usdc: address,
  burnSink: address,
});
export type Deployment = z.infer<typeof DeploymentSchema>;

export type Config = Readonly<{
  rpc: string;
  explorer: string;
  port: number;
  pollSec: number;
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
  if (!parsed.success) throw new ConfigError(`invalid indexer config:\n  ${issues(parsed.error)}`);
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
    explorer: e.EXPLORER_WEB.replace(/\/$/, ""),
    port: e.PORT,
    pollSec: e.POLL_SEC,
    fromBlock: BigInt(e.FROM_BLOCK),
    stateFile: e.STATE_FILE,
    deployment: deployment.data,
  });
}
