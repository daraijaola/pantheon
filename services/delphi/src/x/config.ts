// DELPHI-on-X settings. Keys live in files only the service user can read, outside the repo, and are
// never logged. Everything else has a safe default: she starts in shadow mode (drafts only).
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { OAuthCreds } from "./oauth.ts";

/** Where DELPHI's secrets live: readable by the DELPHI service user only. */
export const KEYS = "/var/lib/delphi/keys";

const n = (def: number) => z.string().trim().regex(/^\d+$/).transform(Number).default(def);

const Env = z.object({
  X_MODE: z.enum(["shadow", "live"]).default("shadow"),
  X_HANDLE: z.string().regex(/^\w{1,15}$/).default("heydelph"),
  X_KEYS_FILE: z.string().default(join(KEYS, "heydelph-x.env")),
  X_CLAUDE_KEY_FILE: z.string().default(join(KEYS, "heydelph-claude.key")),
  X_MODEL: z.string().default("claude-sonnet-5-5"),
  X_POLL_SEC: n(45),
  X_REFRESH_SEC: n(300),
  X_DAILY_CAP: n(300),
  X_USER_HOURLY: n(4),
  /** Usernames she may answer while testing, comma-separated; empty = everyone. */
  X_ALLOW: z.string().default(""),
  X_STATE: z.string().default("data/x.db"),
  X_DRAFTS: z.string().default("out/x/drafts.jsonl"),
  /** Daily Claude spend limit in USD (list prices): she stops answering for the day past it. */
  X_DAILY_USD: z.string().regex(/^\d+(\.\d+)?$/).transform(Number).default(5),
});

export type XConfig = Readonly<{
  mode: "shadow" | "live";
  handle: string;
  keysFile: string;
  claudeKeyFile: string;
  model: string;
  pollSec: number;
  refreshSec: number;
  dailyCap: number;
  perUserHourly: number;
  allow: ReadonlySet<string> | null;
  statePath: string;
  draftsPath: string;
  dailyUsd: number;
}>;

export class XConfigError extends Error {
  override name = "XConfigError";
}

export function loadXConfig(env: Record<string, string | undefined> = process.env): XConfig {
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ""));
  const p = Env.safeParse(cleaned);
  if (!p.success) throw new XConfigError(`invalid X config:\n  ${p.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n  ")}`);
  const e = p.data;
  const allow = e.X_ALLOW.split(",").map((s) => s.trim().replace(/^@/, "").toLowerCase()).filter(Boolean);
  return Object.freeze({
    mode: e.X_MODE,
    handle: e.X_HANDLE,
    keysFile: e.X_KEYS_FILE,
    claudeKeyFile: e.X_CLAUDE_KEY_FILE,
    model: e.X_MODEL,
    pollSec: Math.max(15, e.X_POLL_SEC),
    refreshSec: Math.max(60, e.X_REFRESH_SEC),
    dailyCap: e.X_DAILY_CAP,
    perUserHourly: e.X_USER_HOURLY,
    allow: allow.length ? new Set(allow) : null,
    statePath: e.X_STATE,
    draftsPath: e.X_DRAFTS,
    dailyUsd: e.X_DAILY_USD,
  });
}

/** A secret file: must exist, be readable by its owner only, and not be empty. */
export function readSecret(file: string): string {
  let mode: number;
  try {
    mode = statSync(file).mode;
  } catch {
    throw new XConfigError(`missing ${file}`);
  }
  if ((mode & 0o077) !== 0) throw new XConfigError(`${file} can be read by other users: run chmod 600 on it first`);
  const s = readFileSync(file, "utf8").trim();
  if (!s) throw new XConfigError(`${file} is empty`);
  return s;
}

/** The four OAuth 1.0a values from a KEY=VALUE file. Values are never printed, only their names. */
export function loadXKeys(file: string): OAuthCreds {
  const vars: Record<string, string> = {};
  for (const line of readSecret(file).split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?([^"\s]*)"?\s*$/);
    if (m) vars[m[1]!] = m[2]!;
  }
  const need = ["X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_SECRET"] as const;
  const missing = need.filter((k) => !vars[k]);
  if (missing.length) throw new XConfigError(`${file} is missing ${missing.join(", ")}`);
  return Object.freeze({ apiKey: vars.X_API_KEY!, apiSecret: vars.X_API_SECRET!, accessToken: vars.X_ACCESS_TOKEN!, accessSecret: vars.X_ACCESS_SECRET! });
}
