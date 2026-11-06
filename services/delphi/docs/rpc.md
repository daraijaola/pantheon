# Heavy RPC reads

All `BatchRpc` readers (scan, funding, safety, explanation, social readers and fixture
recorders) resolve `DELPHI_HEAVY_RPC`, then `ELYSIUM_RPC`, then
`https://testnet-rpc.elysium.kinetiq.xyz`. Explicit constructor URLs still override
these defaults. Keep authenticated URLs private; never include them in logs.

The explorer gateway is no longer a working default. On 2026-11-06 it answered
`eth_getLogs` and `debug_traceBlockByNumber` with HTTP 403, JSON-RPC -32601,
"Method not allowed". HTTP failures now retain the provider's error code and
bounded, control-character-stripped response detail in `RpcError`.

## Public testnet measurements (2026-11-06)

- Batches of 10 returned all answers. Arrays of 100, 101 and 1,000 were accepted
  but individual calls were throttled with -32017, "Rate Limit Exceeded". A large
  batch is not a way around the call quota. No numeric quota or Retry-After was
  advertised in these public-node responses; the exact sustained quota is unknown.
- A factory-only query spanning 17,000,000 historical blocks returned 125 logs,
  94,397 response bytes, in 349 ms. No small fixed block-range limit was observed.
- KALOS transfers over 10,000 blocks returned 2,849 logs / 1,803,515 response
  bytes in 1.02 s. Over 100,000 blocks the node returned -32005, "logs count limit
  exceeded (10000) consider refine/narrow down your query". This is a result-count
  limit, not a retryable rate limit. An independent byte-size limit was not found.
- Factory code at block 7,645,302 was available (24,535 bytes). At that same old
  block, `eth_call` with injected runtime code returned the expected integer 42.
- `eth_simulateV1` at block 7,645,302, with validation disabled and a balance
  override, executed a synthetic transfer successfully (`status: 0x1`, gas 21,000).
  Nothing was signed or broadcast.
- Actual `debug_traceBlockByNumber` with `callTracer` returned -32401,
  "authenticated API key required for method". The explorer also denied that
  actual trace request; it is not a viable fallback. Full internal-funding and
  creator-trace coverage needs a trace-capable authenticated endpoint supplied
  as `DELPHI_HEAVY_RPC`. Without it, existing missing-data handling still applies;
  the public node is not a claim of complete tracing coverage.

## Budgets and recovery

Default requests contain at most ten calls and are spaced one second apart.
Pacing is shared by URL between `BatchRpc` instances in one process, including
funding readers; different processes and ordinary viem reads do not share that
budget. Avoid running several refreshes concurrently against a public endpoint.
HTTP 429/5xx and per-call throttling use bounded exponential backoff; HTTP
Retry-After is honored up to 60 seconds. Only throttled calls are retried.

Log scanning aims for 3,000 results per range and budgets 6,000 expected logs per
request. Ranges shrink on result-count errors and grow for quiet streams. The
10,000-result rejection is never retried unchanged with backoff. Cursors are
saved after each successful contiguous range, so interrupted runs can resume.

The public node supports archive reads and safety simulations, but this is not a
guarantee of unlimited throughput or of trace access. Do not silently substitute
missing trace results with evidence that a wallet is unrelated or a contract safe.
