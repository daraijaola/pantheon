// Batched JSON-RPC for the explorer's own node (archive state, call traces, eth_simulateV1), which
// answers up to 100 calls in one request. The public RPC refuses batches, so heavy reads go here.
// Read-only: only read methods are ever sent.
import { z } from "zod";

/** The explorer's node. Checked live 2026-10-31: archive, batches of 100, debug_trace*, eth_simulateV1. */
export const EXPLORER_RPC = "https://test-explorer.elysium.kinetiq.xyz/rpc";

export type RpcCall = { method: string; params: unknown[] };
export type RpcAnswer<T = unknown> = { result: T; error?: undefined } | { result?: undefined; error: { code: number; message: string } };

export class RpcError extends Error {
  override name = "RpcError";
  readonly code: number | undefined;
  constructor(message: string, code?: number) {
    super(message);
    this.code = code;
  }
}

const Answer = z.object({
  id: z.number(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});

/** "Slow down" codes: standard, 429-in-body, QuickNode's, and Conduit's (seen live). */
const SLOW_DOWN = new Set([-32005, 429, -32007, -32017]);
/**
 * The explorer's node uses -32005 also for "logs count limit exceeded (10000)": the query asked for too
 * much, and waiting won't change the answer. Seen live 2026-10-31. Such an answer goes back to the caller
 * at once, so it can ask for a smaller block range.
 */
const TOO_BIG = /logs count limit|narrow down your query|block range|too many (logs|results)/i;
export const asksTooMuch = (e: { message: string }) => TOO_BIG.test(e.message);
export const isSlowDown = (e: { code: number; message: string }) => SLOW_DOWN.has(e.code) && !asksTooMuch(e);
const READ_ONLY = /^(eth_(call|chainId|blockNumber|getBalance|getBlock\w*|getCode|getLogs|getStorageAt|getTransaction\w*|simulateV1)|debug_trace\w+)$/;

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export class BatchRpc {
  readonly url: string;
  private readonly batchSize: number;
  private readonly gapMs: number;
  private readonly retries: number;
  private readonly fetch: Fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private nextSlot = 0;
  private id = 0;
  /** Requests sent, for logs and tests. */
  requests = 0;

  constructor(url = EXPLORER_RPC, opts: { batchSize?: number; gapMs?: number; retries?: number; fetch?: Fetch; sleep?: (ms: number) => Promise<void> } = {}) {
    this.url = url;
    this.batchSize = opts.batchSize ?? 100;
    this.gapMs = opts.gapMs ?? 150;
    this.retries = opts.retries ?? 6;
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** One call; throws on an error answer. */
  async call<T>(method: string, params: unknown[]): Promise<T> {
    const [a] = await this.many<T>([{ method, params }]);
    if (a!.error) throw new RpcError(`${method}: ${a!.error.message}`, a!.error.code);
    return a!.result as T;
  }

  /**
   * Many calls, in batches, answers in the same order. A call the node refuses with "slow down" is
   * retried after a wait; any other error is returned in its place, so one bad call never sinks the rest.
   */
  async many<T>(calls: readonly RpcCall[]): Promise<RpcAnswer<T>[]> {
    for (const c of calls) if (!READ_ONLY.test(c.method)) throw new RpcError(`not a read method: ${c.method}`);
    const out = new Array<RpcAnswer<T>>(calls.length);
    for (let start = 0; start < calls.length; start += this.batchSize) {
      let todo = calls.slice(start, start + this.batchSize).map((c, i) => ({ ...c, at: start + i }));
      for (let attempt = 0; todo.length; attempt++) {
        const answers = await this.send(todo);
        const again: typeof todo = [];
        todo.forEach((c, i) => {
          const a = answers[i]!;
          if (a.error && isSlowDown(a.error) && attempt < this.retries) again.push(c);
          else out[c.at] = a as RpcAnswer<T>;
        });
        if (again.length) await this.sleep(Math.min(60_000, 2_000 * 2 ** attempt));
        todo = again;
      }
    }
    return out;
  }

  private async send(calls: readonly RpcCall[]): Promise<RpcAnswer[]> {
    const ids = calls.map(() => ++this.id);
    const body = JSON.stringify(calls.map((c, i) => ({ jsonrpc: "2.0", id: ids[i], method: c.method, params: c.params })));
    for (let attempt = 0; ; attempt++) {
      const now = Date.now();
      const wait = Math.max(0, this.nextSlot - now);
      this.nextSlot = Math.max(now, this.nextSlot) + this.gapMs;
      if (wait > 0) await this.sleep(wait);
      this.requests++;
      let res: Response;
      try {
        res = await this.fetch(this.url, {
          method: "POST",
          headers: { "content-type": "application/json", "user-agent": "delphi (read-only checks; pantheonindex.com)" },
          body,
          signal: AbortSignal.timeout(60_000),
        });
      } catch (err) {
        if (attempt >= this.retries) throw new RpcError(`node unreachable: ${(err as Error).message}`);
        await this.sleep(1_000 * 2 ** attempt);
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < this.retries) {
        await this.sleep(Math.min(60_000, 2_000 * 2 ** attempt));
        continue;
      }
      if (!res.ok) throw new RpcError(`node answered HTTP ${res.status}`);
      const parsed = z.array(Answer).safeParse(await res.json());
      if (!parsed.success) throw new RpcError(`unexpected node answer: ${parsed.error.issues[0]?.message}`);
      const byId = new Map(parsed.data.map((a) => [a.id, a]));
      return ids.map((id): RpcAnswer => {
        const a = byId.get(id);
        if (!a) return { error: { code: -1, message: "no answer for this call" } };
        return a.error ? { error: a.error } : { result: a.result };
      });
    }
  }
}
