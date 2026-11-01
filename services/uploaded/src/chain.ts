// Reading Elysium politely. The public RPC rate-limits bursts, so this is the same client as the indexer's,
// the keeper's and DELPHI's.
import { createPublicClient, defineChain, http, type PublicClient } from "viem";

const RATE_LIMIT_CODES = new Set([-32005, 429, -32007, -32017]);
function isRateLimited(status: number, body: string): boolean {
  if (status === 429) return true;
  try {
    const parsed: unknown = JSON.parse(body);
    return (Array.isArray(parsed) ? parsed : [parsed]).some((m) => {
      const e = (m as { error?: { code?: unknown; message?: unknown } } | null)?.error;
      return !!e && (RATE_LIMIT_CODES.has(e.code as number) || /rate limit/i.test(String(e.message)));
    });
  } catch {
    return false;
  }
}

/** A gap between RPC requests, and on a rate-limit answer (Conduit's -32017) a growing wait and a retry. */
export function politeFetch(opts: { minGapMs?: number; retries?: number; fetch?: typeof globalThis.fetch; sleep?: (ms: number) => Promise<void> } = {}): typeof globalThis.fetch {
  const gap = opts.minGapMs ?? 150;
  const retries = opts.retries ?? 6;
  const doFetch = opts.fetch ?? globalThis.fetch;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  let nextSlot = 0;
  return async (input, init) => {
    for (let attempt = 0; ; attempt++) {
      const now = Date.now();
      const wait = Math.max(0, nextSlot - now);
      nextSlot = Math.max(now, nextSlot) + gap;
      if (wait > 0) await sleep(wait);
      const res = await doFetch(input, init);
      const body = await res.text();
      if (attempt < retries && isRateLimited(res.status, body)) {
        await sleep(Math.min(60_000, 2_000 * 2 ** attempt));
        continue;
      }
      return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
    }
  };
}

/**
 * `batch`: gather reads made together into one request, for the explorer's node (the public one refuses
 * batches). That node has no burst limit to respect here: each request waits for the last, so no gap.
 */
export function makeClient(rpc: string, opts: { batch?: boolean } = {}): PublicClient {
  const chain = defineChain({
    id: 99_801,
    name: "Elysium testnet",
    nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
    contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
  });
  return createPublicClient({ chain, transport: http(rpc, { batch: opts.batch ? { batchSize: 100, wait: 5 } : false, retryCount: 3, timeout: 60_000, fetchFn: politeFetch(opts.batch ? { minGapMs: 0 } : {}) }) });
}
