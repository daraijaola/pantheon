// The Claude API key. It lives in a file only the service user can read, outside the repo
// (ANTHROPIC_API_KEY wins if it is set). The key is never logged or written anywhere.
import { readFileSync, statSync } from "node:fs";

export const DEFAULT_KEY_FILE = "/var/lib/delphi/keys/anthropic.key";

export class KeyError extends Error {
  override name = "KeyError";
}

export function loadApiKey(env: Record<string, string | undefined> = process.env): string {
  if (env.ANTHROPIC_API_KEY) return env.ANTHROPIC_API_KEY;
  const file = env.DELPHI_ANTHROPIC_KEY_FILE || DEFAULT_KEY_FILE;
  let mode: number;
  try {
    mode = statSync(file).mode;
  } catch {
    throw new KeyError(`no Claude API key: put it in ${file} (mode 600) or set ANTHROPIC_API_KEY`);
  }
  if ((mode & 0o077) !== 0) throw new KeyError(`${file} can be read by other users: run chmod 600 on it first`);
  const key = readFileSync(file, "utf8").trim();
  if (!key) throw new KeyError(`${file} is empty`);
  return key;
}
