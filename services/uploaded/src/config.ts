// Settings. Read-only: no keys, nothing to sign. A wrong value stops it at start.
import { z } from "zod";

const wholeNumber = z.string().trim().regex(/^\d+$/, "must be a whole number").transform(Number);

const EnvSchema = z.object({
  /** 8787 Passport, 8789 indexer, 8790 Trials, 3210 DELPHI feed. */
  PORT: wholeNumber.pipe(z.number().min(1024).max(65_535)).default(8791),
  ELYSIUM_RPC: z.url({ protocol: /^https?$/ }).default("https://testnet-rpc.elysium.kinetiq.xyz"),
  /** DELPHI's latest results. Only ever read. */
  SCAN_FILE: z.string().min(1).default("../delphi/out/scan.json"),
  /** How often to look for a new scan. */
  REFRESH_SEC: wholeNumber.pipe(z.number().min(5)).default(60),
  /** Where DELPHI's code and cache are: fresh reads run there, as DELPHI's own script. */
  DELPHI_DIR: z.string().min(1).default("../delphi"),
  /** Fresh reads for coins whose verdict is getting old. Off: scans only. */
  FRESH_READS: z.enum(["on", "off"]).default("on"),
  /** At most one fresh read this often, however many coins are asked about. */
  FRESH_GAP_SEC: wholeNumber.pipe(z.number().min(60)).default(300),
});

export type Config = Readonly<{ port: number; rpc: string; scanFile: string; refreshSec: number; delphiDir: string; freshReads: boolean; freshGapSec: number }>;

export class ConfigError extends Error {
  override name = "ConfigError";
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const set = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ""));
  const p = EnvSchema.safeParse(set);
  if (!p.success) throw new ConfigError(`invalid settings:\n  ${p.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n  ")}`);
  const e = p.data;
  return Object.freeze({ port: e.PORT, rpc: e.ELYSIUM_RPC, scanFile: e.SCAN_FILE, refreshSec: e.REFRESH_SEC, delphiDir: e.DELPHI_DIR, freshReads: e.FRESH_READS === "on", freshGapSec: e.FRESH_GAP_SEC });
}
