// Settings. Read-only: no keys, nothing to sign. A wrong value stops it at start.
import { readFileSync } from "node:fs";
import { z } from "zod";

const wholeNumber = z.string().trim().regex(/^\d+$/, "must be a whole number").transform(Number);

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be an address");
/** The contracts this service reads, from the file the site reads too. */
const DeploymentSchema = z.object({ staking: address, passportRegistry: address, pnth: address, usdc: address, indexVault: address.optional(), covenantFactory: address.optional() });

const EnvSchema = z.object({
  /** 8787 Passport, 8789 indexer, 8790 Trials, 3310 DELPHI feed. */
  PORT: wholeNumber.pipe(z.number().min(1024).max(65_535)).default(8791),
  ELYSIUM_RPC: z.url({ protocol: /^https?$/ }).default("https://testnet-rpc.elysium.kinetiq.xyz"),
  /** A node that keeps old blocks and takes batches: the explorer's, as DELPHI uses for heavy reads. */
  ARCHIVE_RPC: z.url({ protocol: /^https?$/ }).default("https://test-explorer.elysium.kinetiq.xyz/rpc"),
  DEPLOYMENT_FILE: z.string().min(1).default("../../deployments/elysium-testnet.json"),
  /** The Trials service on this machine: who voted in each round. */
  TRIALS_URL: z.url({ protocol: /^https?$/ }).default("http://127.0.0.1:8790"),
  /** The indexer on this machine: the basket's buys and every claim. */
  INDEXER_URL: z.url({ protocol: /^https?$/ }).default("http://127.0.0.1:8789"),
  /** DELPHI's latest results. Only ever read. */
  SCAN_FILE: z.string().min(1).default("../delphi/out/scan.json"),
  /** How often to look for a new scan. */
  REFRESH_SEC: wholeNumber.pipe(z.number().min(5)).default(60),
  /** Where DELPHI's code and cache are: fresh reads run there, as DELPHI's own script. */
  DELPHI_DIR: z.string().min(1).default("../delphi"),
  /** Fresh reads for coins whose verdict is getting old. Off: scans only. */
  FRESH_READS: z.enum(["on", "off"]).default("on"),
  /** Asking Hyperliquid and other chains about a wallet tells them its address, so it's off until sign-in. */
  ELSEWHERE_READS: z.enum(["on", "off"]).default("off"),
  /** At most one fresh read this often, however many coins are asked about. */
  FRESH_GAP_SEC: wholeNumber.pipe(z.number().min(60)).default(300),
  /** How often Guard reads on its own, to see verdicts change and creators sell. */
  GUARD_READ_SEC: wholeNumber.pipe(z.number().min(60)).default(900),
  /** What Guard remembers. */
  GUARD_FILE: z.string().min(1).default("data/guard.json"),
});

export type Config = Readonly<{
  port: number;
  rpc: string;
  archiveRpc: string;
  deployment: z.infer<typeof DeploymentSchema>;
  indexerUrl: string;
  trialsUrl: string;
  scanFile: string;
  refreshSec: number;
  delphiDir: string;
  freshReads: boolean;
  elsewhereReads: boolean;
  freshGapSec: number;
  guardReadSec: number;
  guardFile: string;
}>;

export class ConfigError extends Error {
  override name = "ConfigError";
}

export function loadConfig(env: Record<string, string | undefined> = process.env, readFile = (p: string) => readFileSync(p, "utf8")): Config {
  const set = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ""));
  const p = EnvSchema.safeParse(set);
  if (!p.success) throw new ConfigError(`invalid settings:\n  ${p.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n  ")}`);
  const e = p.data;
  let deployment: Config["deployment"];
  try {
    deployment = DeploymentSchema.parse(JSON.parse(readFile(e.DEPLOYMENT_FILE)));
  } catch (err) {
    throw new ConfigError(`can't use ${e.DEPLOYMENT_FILE}: ${(err as Error).message.split("\n")[0]}`);
  }
  return Object.freeze({ port: e.PORT, rpc: e.ELYSIUM_RPC, archiveRpc: e.ARCHIVE_RPC, deployment, indexerUrl: e.INDEXER_URL, trialsUrl: e.TRIALS_URL, scanFile: e.SCAN_FILE, refreshSec: e.REFRESH_SEC, delphiDir: e.DELPHI_DIR, freshReads: e.FRESH_READS === "on", elsewhereReads: e.ELSEWHERE_READS === "on", freshGapSec: e.FRESH_GAP_SEC, guardReadSec: e.GUARD_READ_SEC, guardFile: e.GUARD_FILE });
}
