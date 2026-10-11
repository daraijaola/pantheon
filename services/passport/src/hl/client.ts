// Typed client for the Hyperliquid info API (spec §2): one method per request type, every
// request charged to a shared weight budget, temporary failures retried with backoff.
import { isAddress, type Address } from "viem";
import type { z } from "zod";
import { HL_WEIGHT, type Config } from "../config.ts";
import { realSleep, WeightLimiter, type Sleep } from "../ratelimit.ts";
import * as S from "./schemas.ts";

export type HlRequestType = keyof typeof HL_WEIGHT;

/**
 * BAD_REQUEST: our request was refused (4xx other than 429, or a bad address); retrying won't help.
 * BAD_RESPONSE: HL answered 200 but not with what we expect (not JSON, or the schema changed).
 * UNAVAILABLE: 429, 5xx, network error or timeout, still failing after every retry.
 */
export type HlErrorCode = "BAD_REQUEST" | "BAD_RESPONSE" | "UNAVAILABLE";

export class HlError extends Error {
  override name = "HlError";
  readonly code: HlErrorCode;
  readonly requestType: HlRequestType;
  readonly status: number | undefined;

  constructor(code: HlErrorCode, requestType: HlRequestType, message: string, opts: { status?: number; cause?: unknown } = {}) {
    super(`${requestType}: ${message}`, { cause: opts.cause });
    this.code = code;
    this.requestType = requestType;
    this.status = opts.status;
  }
}

export type HlClientOptions = {
  url: string;
  limiter: WeightLimiter;
  fetch?: typeof fetch;
  sleep?: Sleep;
  timeoutMs?: number;
  /** Delay before each retry; its length is the number of retries (§2: 5 s, 10 s, 20 s). */
  retryDelaysMs?: readonly number[];
};

const MAX_RETRY_AFTER_MS = 60_000;

export class HlClient {
  readonly limiter: WeightLimiter;
  #url: string;
  #fetch: typeof fetch;
  #sleep: Sleep;
  #timeoutMs: number;
  #retryDelaysMs: readonly number[];

  constructor(o: HlClientOptions) {
    this.#url = o.url;
    this.limiter = o.limiter;
    this.#fetch = o.fetch ?? globalThis.fetch;
    this.#sleep = o.sleep ?? realSleep;
    this.#timeoutMs = o.timeoutMs ?? 10_000;
    this.#retryDelaysMs = o.retryDelaysMs ?? [5_000, 10_000, 20_000];
  }

  userRole(user: Address) {
    return this.#post("userRole", { user }, S.UserRole);
  }

  extraAgents(user: Address) {
    return this.#post("extraAgents", { user }, S.ExtraAgents);
  }

  spotClearinghouseState(user: Address) {
    return this.#post("spotClearinghouseState", { user }, S.SpotClearinghouseState);
  }

  borrowLendUserState(user: Address) {
    return this.#post("borrowLendUserState", { user }, S.BorrowLendUserState);
  }

  delegatorSummary(user: Address) {
    return this.#post("delegatorSummary", { user }, S.DelegatorSummary);
  }

  /** Times are ms, both inclusive; `endTime` defaults to now on HL's side. */
  userNonFundingLedgerUpdates(user: Address, startTime: number, endTime?: number) {
    return this.#post("userNonFundingLedgerUpdates", { user, startTime, ...(endTime === undefined ? {} : { endTime }) }, S.LedgerUpdates);
  }

  portfolio(user: Address) {
    return this.#post("portfolio", { user }, S.Portfolio);
  }

  /** Never null: an account without sub-accounts gives []. */
  subAccounts(user: Address) {
    return this.#post("subAccounts", { user }, S.SubAccounts);
  }

  userToMultiSigSigners(user: Address) {
    return this.#post("userToMultiSigSigners", { user }, S.MultiSigSigners);
  }

  clearinghouseState(user: Address) {
    return this.#post("clearinghouseState", { user }, S.ClearinghouseState);
  }

  async #post<T>(type: HlRequestType, params: { user: Address } & Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
    if (!isAddress(params.user, { strict: false })) throw new HlError("BAD_REQUEST", type, "user is not an address");
    const body = JSON.stringify({ type, ...params, user: params.user.toLowerCase() });

    for (let attempt = 0; ; attempt++) {
      await this.limiter.take(HL_WEIGHT[type]);
      const outcome = await this.#attempt(type, body);
      if (outcome.ok) return this.#parse(type, outcome.text, schema);

      const delay = this.#retryDelaysMs[attempt];
      if (delay === undefined) {
        throw new HlError("UNAVAILABLE", type, `gave up after ${attempt + 1} attempts: ${outcome.reason}`, {
          ...(outcome.status === undefined ? {} : { status: outcome.status }),
          cause: outcome.cause,
        });
      }
      await this.#sleep(Math.max(delay, outcome.retryAfterMs ?? 0));
    }
  }

  /** One HTTP round trip. Returns retryable failures; throws the ones retrying cannot fix. */
  async #attempt(type: HlRequestType, body: string): Promise<Attempt> {
    let res: Response;
    let text: string;
    try {
      res = await this.#fetch(this.#url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      text = await res.text();
    } catch (cause) {
      const timedOut = cause instanceof DOMException && cause.name === "TimeoutError";
      return { ok: false, reason: timedOut ? `timeout after ${this.#timeoutMs} ms` : "network error", cause };
    }
    if (res.ok) return { ok: true, text };
    if (res.status === 429 || res.status >= 500) {
      return { ok: false, reason: `HTTP ${res.status}`, status: res.status, retryAfterMs: retryAfterMs(res.headers.get("retry-after")) };
    }
    // HL answers malformed requests with 422 and a plain-text message (checked live 2026-10-11).
    throw new HlError("BAD_REQUEST", type, `HTTP ${res.status}: ${text.slice(0, 200)}`, { status: res.status });
  }

  #parse<T>(type: HlRequestType, text: string, schema: z.ZodType<T>): T {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (cause) {
      throw new HlError("BAD_RESPONSE", type, "response is not JSON", { cause });
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      const where = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
      throw new HlError("BAD_RESPONSE", type, `unexpected shape (${where.join("; ")})`, { cause: parsed.error });
    }
    return parsed.data;
  }
}

type Attempt =
  | { ok: true; text: string }
  | { ok: false; reason: string; status?: number; retryAfterMs?: number | undefined; cause?: unknown };

/** Retry-After in seconds (HTTP-date form ignored), capped. HL sends none today, CloudFront may. */
function retryAfterMs(header: string | null): number | undefined {
  if (header === null || !/^\d+$/.test(header.trim())) return undefined;
  return Math.min(Number(header) * 1000, MAX_RETRY_AFTER_MS);
}

export function createHlClient(config: Config, opts: Partial<HlClientOptions> = {}): HlClient {
  return new HlClient({ url: config.hlInfoUrl, limiter: new WeightLimiter(config.hlWeightPerMin), ...opts });
}
