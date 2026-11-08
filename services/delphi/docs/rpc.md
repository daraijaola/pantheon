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

| Variable | Public default | Meaning |
| --- | ---: | --- |
| `DELPHI_RPC_BATCH_SIZE` | 10 | Metered calls per HTTP batch (1–1000) |
| `DELPHI_RPC_GAP_MS` | 1000 | Minimum gap between heavy HTTP requests (0–60000) |
| `DELPHI_RPC_CONCURRENCY` | 6 | Heavy in-flight HTTP requests / lookup workers (1–128) |
| `DELPHI_RPC_SINGLE_GAP_MS` | 150 | Ordinary viem request gap (0–60000) |
| `DELPHI_RPC_RETRIES` | 6 | Heavy/per-call and polite-fetch retries (0–20) |

The approximate heavy call cap is batch size divided by request gap. Increasing
concurrency does not create another URL budget. Set capacity only after measuring
the authenticated provider's per-method/CU limits; large batches can still throttle.
Invalid settings fail before requests. Endpoint path keys, query credentials and
userinfo are removed from provider/transport error details, including nested viem
errors; never print the configured URL itself.

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

## Safe Multicall views

`viewsAt` batches only `balanceOf(address)`, `totalSupply()` and `decimals()` at
explicit historical blocks, in groups of at least eight. Unknown implementations,
proxies/delegations, other selectors and `latest` use the original direct path.
Multicall3's runtime hash is pinned to its measured canonical deployment on 99801.
Every chunk checks its first and last answer against direct calls; a mismatch or
outer failure discards the entire target/block group's batched results. Failed or
malformed individual subcalls are re-read directly. Original null/revert/error
handling is retained. No requests are signed or broadcast.

The default runtime allowlist is deliberately small. Source-reviewed immutable
implementations have caller-independent, side-effect-free storage/constant getters:

- [TestUSDC](https://contracts.conduit.xyz/v2/contract/99801/0x852043605E2F2F326F6Bed69E5e5Baf970366473?fields=sources,compilation,runtimeBytecode):
  `0x400afd838d4b8888b195f8231b65b87f326adf2cf0205dcbe71f2703ca1161fe`.
- [EridanosToken](https://contracts.conduit.xyz/v2/contract/99801/0x13aCae05DF01026AbEf8A48425D41F6955f05C90?fields=sources,compilation,runtimeBytecode):
  `0xfd581a067231878993acf06be55d9499fcd0b0f428041685933715be8ccb1546`.
  Its only parent is OpenZeppelin ERC20; it does not override the three getters.

Do not automatically approve a contract just because a few samples agree. Add
comma-separated **source-audited runtime hashes** via `DELPHI_MULTICALL_CODE_HASHES`
only after checking caller/gas independence, no writes/external dependencies, and
same-block full-read parity. A code hash is not a proof that arbitrary code is safe.
`DELPHI_MULTICALL_BATCH_SIZE` defaults to 128 (8–512). `DELPHI_MULTICALL=0` disables
batching for parity checks/rollback. Most unverified Kalos implementations remain
direct reads until reviewed: the optimistic all-token projection is not enabled.

## Hybrid sender reads

Kalos/PerpMe pass the transaction/block positions already recorded in launch/swap
logs to `sendersOf`. Cached `txfrom` values still require no network work. For
uncached transactions, a full block is used only when at least two needed hashes
share a block; singletons/unknown positions retain `eth_getTransactionByHash`.
Block numbers, transaction hashes and sender addresses are validated. Missing,
malformed, duplicate or wrong-block entries, and denied full-block requests, fall
back to individual transaction lookups. Results are cached only after the whole
lookup chunk succeeds. Router addresses in Swap events are never used as senders.

## Small parity benchmark (2026-11-07)

Offline-selected real inputs from the immutable copied cache were read at block
22,760,398: TestUSDC balances for all 59 nonzero addresses touched by its recorded
transfers, and the latest 128/2048 distinct KPIX swap transaction senders. Both
paths started with empty in-memory sender caches. These are small stage probes,
not an end-to-end scan or a sustained provider-capacity test.

| Endpoint / workload | Old → new metered reads | Old → new HTTP requests | Old → new seconds |
| --- | ---: | ---: | ---: |
| Public / 59 balances | 59 → 5 | 12 → 3 | 22.129 → 6.124 |
| Public / 128 senders | 128 → 123 | 26 → 25 | 51.993 → 49.872 |
| Keyed / 59 balances | 59 → 5 | 2 → 3 | 0.698 → 0.748 |
| Keyed / 128 senders | 128 → 123 | 5 → 6 | 1.375 → 1.574 |
| Keyed / 2048 senders | 2048 → 1994 | 82 → 80 | 20.759 → 20.580 |

All balance bytes and sender maps matched exactly; no throttling/error responses.
Public probes deliberately used batch 5 / gap 2000ms / concurrency 1 to leave the
existing scan capacity. Keyed probes used batch 32 / gap 250ms / concurrency 4,
measuring about 99 metered transaction reads/s, not the provider's advertised
maximum. Keep that setting below the account's 12,500 CU/s budget: `eth_call`
costs more than transaction/block reads. These probes used well below 1M CU.
The free account's 100M CU/month is not enough for twice-daily production scans:
senders plus mostly-direct dirty balances alone project to roughly 300M CU/month.

The sparse KPIX sample saved only 2.6% of sender reads at 2048 transactions; do
not extrapolate it as a large block-density speed-up. Setup/parity overhead made
both tiny keyed samples slightly slower despite lower metered-call counts.
With roughly 212k new swap senders per 12h, measured ~99 reads/s suggests ~36min
for direct senders, or ~27min **if** the wider Kalos workload retains the separately
measured 25.7% occupied-block reduction. Another ~34.7k dirty balances needs ~7min
at the small direct-call sample's ~85/s. Allowing logs/views/funding/safety/local
work, budget roughly 50–80min; ≤1h is a target, not measured full-run evidence.
Unverified Kalos getters are not assumed Multicall-eligible in that projection.

Tracing was tested separately from output parity, with no cache writes. For 32
deterministically sampled uncached KALOS-holder wallets, recomputed first funding
was direct in every case: 32/32 with or without traces, zero added coverage. A
positive-control sample of 16 wallets with historical internal payments was also
searched from genesis: actual first-funding coverage was 6/16 without traces and
16/16 with traces (+10). All ten internal first-funding transactions matched the
copied historical cache. Merely finding a later internal payment is not evidence
that first funding needs a trace. The no-trace baseline emulated the public node's
observed -32401 denial while all other reads used the same keyed endpoint. These
selected samples do not estimate scan-wide missing coverage; cached fundings are
already reused, and new trace evidence may legitimately change detector inputs.
