// One careful way to read JSON from the outside: a User-Agent (some of these servers refuse anonymous
// clients), a timeout, a few retries on server trouble, and every answer schema-checked before use.
// Every client takes its own fetch, so tests can replay recorded answers.
import type { z } from "zod";

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export const USER_AGENT = "delphi (read-only checks; pantheonindex.com)";

export class HttpError extends Error {
  override name = "HttpError";
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

export type JsonOptions = {
  method?: "GET" | "POST";
  body?: unknown;
  /** Answer null instead of throwing when the server says 404 (for "not verified", "not found"). */
  notFoundIsNull?: boolean;
  /** The server may answer 200 with "try again in a moment"; say so, and the answer is retried. */
  retryIf?: (body: unknown) => boolean;
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** GET or POST `url` and check the JSON answer against `schema`. */
export async function getJson<T>(fetch: Fetch, url: string, schema: z.ZodType<T>, opts: JsonOptions & { notFoundIsNull: true }): Promise<T | null>;
export async function getJson<T>(fetch: Fetch, url: string, schema: z.ZodType<T>, opts?: JsonOptions): Promise<T>;
export async function getJson<T>(fetch: Fetch, url: string, schema: z.ZodType<T>, opts: JsonOptions = {}): Promise<T | null> {
  const retries = opts.retries ?? 3;
  const sleep = opts.sleep ?? defaultSleep;
  const init: RequestInit = {
    method: opts.method ?? "GET",
    headers: { accept: "application/json", "user-agent": USER_AGENT, ...(opts.body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    signal: AbortSignal.timeout(30_000),
  };
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      if (attempt >= retries) throw new HttpError(`${url} unreachable: ${(err as Error).message}`);
      await sleep(1_000 * 2 ** attempt);
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      await sleep(1_000 * 2 ** attempt);
      continue;
    }
    if (res.status === 404 && opts.notFoundIsNull) return null;
    if (!res.ok) throw new HttpError(`${url} answered HTTP ${res.status}`, res.status);
    const body: unknown = await res.json();
    if (opts.retryIf?.(body) && attempt < retries) {
      await sleep(1_000 * 2 ** attempt);
      continue;
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new HttpError(`unexpected answer from ${url}: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`);
    return parsed.data;
  }
}
