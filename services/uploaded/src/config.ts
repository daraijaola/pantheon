// Settings. Read-only: no keys, nothing to sign. A wrong value stops it at start.
import { z } from "zod";

const wholeNumber = z.string().trim().regex(/^\d+$/, "must be a whole number").transform(Number);

const EnvSchema = z.object({
  /** 8787 Passport, 8789 indexer, 8790 Trials, 3210 DELPHI feed. */
  PORT: wholeNumber.pipe(z.number().min(1024).max(65_535)).default(8791),
  /** DELPHI's latest results. Only ever read. */
  SCAN_FILE: z.string().min(1).default("../delphi/out/scan.json"),
  /** How often to look for a new scan. */
  REFRESH_SEC: wholeNumber.pipe(z.number().min(5)).default(60),
});

export type Config = Readonly<{ port: number; scanFile: string; refreshSec: number }>;

export class ConfigError extends Error {
  override name = "ConfigError";
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const set = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ""));
  const p = EnvSchema.safeParse(set);
  if (!p.success) throw new ConfigError(`invalid settings:\n  ${p.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n  ")}`);
  return Object.freeze({ port: p.data.PORT, scanFile: p.data.SCAN_FILE, refreshSec: p.data.REFRESH_SEC });
}
