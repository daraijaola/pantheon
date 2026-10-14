# DELPHI: the cheat detector for Ascend coins

DELPHI reads every coin launched on Ascend (Elysium testnet) and checks it for three kinds of cheating that charts hide:

| Check | What it looks for | Watch | Flag |
|---|---|---|---|
| Launch bundle | Linked wallets (the creator included) buying in the first 30 s after launch | ≥ 5% of supply | ≥ 15% |
| Wash trading | Fast round trips: the same actor buying and selling the same tokens back within 5 minutes | ≥ 25% of volume | ≥ 50% |
| Hidden concentration | Linked wallets that together hold the circulating supply | ≥ 20% | ≥ 40% |

Each coin gets a verdict, **FLAG**, **WATCH**, **CLEAN** or **NOT ENOUGH DATA**, and a report in which every claim links to the transactions behind it on the explorer. DELPHI reports patterns, not intent: anyone can check its work without trusting it.

Owner: Ayinde. Status and notes: `TASKS.md`. It is **read-only**: public RPC and explorer reads only, no keys, no transactions, nothing to sign.

## Why PANTHEON needs it

PANTHEON's index buys a basket of top Ascend coins. A coin that is "top" only because of a bundled launch or wash volume should not be in the basket. DELPHI is the evidence layer for that choice, and it is useful on its own to any Ascend trader.

## How it decides who is "one actor"

Wallets are joined into clusters by links, and each link records the transaction(s) that prove it:

| Link | Meaning |
|---|---|
| shared funder | Two wallets got their first HYPE from the same private wallet |
| funded by | One wallet on the coin sent HYPE to another |
| token pass | Tokens moved directly between two wallets (not through a pool or router) |
| bought for / sold for | One wallet sent a trade that moved another wallet's tokens |
| is creator | The wallet that sent the launch differs from the creator role it named |

**Public hubs never link anyone.** The Elysium testnet faucet funded most testers, so linking through it would make everyone one big sybil ring. A funder is treated as a public hub if it is a known faucet or has at least 5,000 transactions. The rule is deliberately *not* "funded many wallets", because a sybil farmer does that too. HYPE paid from inside a contract call is credited to whoever sent that transaction, so funding through a public "disperse" contract still shows the real funder.

**Infrastructure is never a holder or a trader.** That covers the launchpad and everything it names (vault, pool manager, treasuries, ListingDesk), the burn sink, every router seen swapping, and any outside pool (a contract that answers `token0()` and `token1()`).

## Things we learned from the live chain (2026-10-14)

- Swap amounts are from the **swapper's** side: positive means the swapper received it. The pool manager's source comment says the opposite; we checked against real transfers. A test pins this down: the dev-buy read from the swap equals the `devBuyTokens` that Ascend's own launch event reports, exactly.
- A swap's `sender` is a router. The real trader is the wallet that sent the transaction.
- Coins also trade **outside Ascend**. On the same pool manager, 6 hookless pools hold Ascend coins, and Ascend's own router routes through them. Those trades pay no Ascend fee. DELPHI counts them (marked `outside`) and measures wash volume in tokens, because outside pools can be priced in another currency (one uses native HYPE).
- One arbitrage bot buys on Ascend and sells into a Uniswap-V2-style pair in the same transaction. That pair is detected as a pool and excluded from holders.
- A normal wallet can carry EIP-7702 delegation code (`0xef0100…`) and is still treated as a wallet.
- The public RPC (Conduit) rate-limits heavy log queries with error `-32017`, which viem does not retry. The client paces requests and backs off on that code. The explorer allows about 2,000 requests per 13.5 minutes, and DELPHI stops cleanly before running out.

## Run

```sh
cd services/delphi
npm ci
node scripts/scan.ts                 # all coins → out/index.md, out/scan.json, out/coins/<token>.{md,json}
node scripts/scan.ts --only 0x…      # one coin's report
node scripts/scan.ts --no-explorer   # reuse cached funding data only
```

The first run fills a local cache (`data/delphi.db`, SQLite) with launches, swaps, transfers and explorer answers. Later runs fetch only what is new. If the explorer allowance runs out mid-scan, the run still finishes: the affected coins say so, and none of them can be called CLEAN.

All settings have working testnet defaults (see `.env.example`). `better-sqlite3` ships prebuilt binaries, so its install script is denied in `package.json` (`allowScripts`).

## Commands

| Command | What it does |
|---|---|
| `npm test` | Unit tests (vitest). They never touch the network: `test/setup.ts` rejects any `fetch` to a non-loopback host. |
| `npm run typecheck` | `tsc --noEmit` (strict) |
| `npm run lint` | ESLint with typescript-eslint |
| `npm run check` | All three; run before every commit |

## Layout

| File | Role |
|---|---|
| `src/config.ts` | Settings, infrastructure and hub lists, and **all thresholds** (`RULES`, versioned into every report) |
| `src/types.ts` | Coin, Trade, TokenTransfer, Funding, Link, Finding |
| `src/chain.ts` | RPC: resumable log scans, tx senders, block times, address kinds, coin names, polite fetch |
| `src/explorer.ts` | Blockscout v2: funding history and tx counts, schema-checked, budget-aware |
| `src/store.ts` | SQLite cache: raw logs with a cursor per stream, remembered lookups |
| `src/ingest.ts` | Raw data → one `CoinData` per coin (`assemble` is pure; `collect` fetches) |
| `src/graph.ts` | Hubs, links, clusters (union-find) |
| `src/detect.ts` | The three detectors: pure functions, exact integer maths |
| `src/report.ts` | Verdicts, JSON and markdown reports, index |
| `scripts/scan.ts` | The live scan (run by hand) |
| `test/` | Synthetic scenarios (`scenario.ts`) and real transactions (`fixtures/live-trades.json`) |

## Safety

- Coin names and symbols are chosen by whoever launched the coin, so they are treated as hostile. Markdown output escapes them (no links, HTML or table breaks) and strips control and bidi characters. File names use the token address only.
- Explorer answers are schema-checked before use. RPC outages are never cached as answers: only a real contract revert is remembered.
- "Nothing found" is not CLEAN unless every check had enough data, including every wallet's funding history.

## Limits (v0)

- Trades on Uniswap-V2-style pairs are not counted as trades yet (their balances are still handled correctly).
- Funding looks at each wallet's earliest 50 incoming transactions and latest 50 contract payments.
- Testnet trading is thin (a few hundred swaps in total), so most coins come out NOT ENOUGH DATA. That answer is honest, not a failure.
- Plain-English AI summaries of each report are planned. They need an API key, so they wait for Micheal's OK.
