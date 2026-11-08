import { backendEnv, configured, profile, assertDeploymentChain } from "../../network.mts";
// The Trials vote: settings. It reads the chain only to check PNTH stakes and HYPE Passports; it holds
// no keys and signs nothing. Every value has a working testnet default.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getAddress, type Address } from "viem";
import { z } from "zod";

const Env = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(8790),
  ELYSIUM_RPC: z.url({ protocol: /^https?$/ }).default(() => profile().network.publicRpc),
  DEPLOYMENT: z.string().min(1).default(() => backendEnv({}, "trials").DEPLOYMENT_FILE!),
  ROUNDS_DIR: z.string().min(1).default("../../deployments/trials"),
  STATE_FILE: z.string().min(1).default("data/ballots.json"),
});

export type Config = Readonly<{
  port: number;
  rpc: string;
  chainId: number;
  passportRegistry: Address;
  staking: Address;
  roundsDir: string;
  stateFile: string;
}>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  env = backendEnv(env, "trials");
  const e = Env.parse(Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== "")));
  const d = JSON.parse(readFileSync(resolve(e.DEPLOYMENT), "utf8")) as { chainId: number; passportRegistry: string; staking: string };
  assertDeploymentChain(env, d);
  return configured(env, "trials", {
    port: e.PORT,
    rpc: e.ELYSIUM_RPC,
    chainId: d.chainId,
    passportRegistry: getAddress(d.passportRegistry),
    staking: getAddress(d.staking),
    roundsDir: resolve(e.ROUNDS_DIR),
    stateFile: resolve(e.STATE_FILE),
  });
}
