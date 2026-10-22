# DELPHI: the cheat detector for Ascend coins

DELPHI reads every coin launched on Ascend (Elysium testnet) and checks it for three kinds of cheating that charts hide:

| Check | What it looks for | Watch | Flag |
|---|---|---|---|
| Launch bundle | Linked wallets (the creator included) buying in the first 30 s after launch | ≥ 5% of supply | ≥ 15% |
| Wash trading | Fast round trips: the same actor buying and selling the same tokens back within 5 minutes | ≥ 25% of volume | ≥ 50% |
| Hidden concentration | Linked wallets that together hold the circulating supply | ≥ 20% | ≥ 40% |

Each coin gets a verdict, **FLAG**, **WATCH**, **CLEAN** or **NOT ENOUGH DATA**, and a report in which every claim links to the transactions behind it on the explorer. DELPHI reports patterns, not intent: anyone can check its work without trusting it.

Owner: Ayinde. Status and notes: `TASKS.md`. It is **read-only**: public RPC and explorer reads only, no wallet keys, no transactions, nothing to sign. The one secret is the Claude API key for the plain-English explanations, kept outside the repo.

## Why PANTHEON needs it

PANTHEON's index buys a basket of top Ascend coins. A coin that is "top" only because of a bundled launch or wash volume should not be in the basket. DELPHI is the evidence layer for that choice, and it is useful on its own to any Ascend trader.

## How it decides who is "one actor"

Wallets are joined into groups by links, and each link records the transaction(s) that prove it:

| Link | Meaning |
|---|---|
| shared funder | Two wallets got HYPE from the same private wallet |
| funded by | One wallet on the coin sent HYPE to another |
| token pass | Tokens moved directly between two wallets (not through a pool or router) |
| bought for / sold for | One wallet sent a trade that moved another wallet's tokens |
| is creator | The wallet that sent the launch differs from the creator role it named |

**Groups never chain (rules v0.3).** A group is one funder's own star of wallets (plus the funder, if it is on the coin), widened by token passes and trades made between wallets. Two funders' stars are never joined through a wallet both of them paid. Up to v0.2, DELPHI joined every link transitively, and on the farmed testnet that made one "group" out of dozens of unrelated wallets: every coin in PANTHEON's basket was flagged as "35 linked wallets hold 50–93%", chained through 25 different funders, while the two big holders had no direct tie at all.

**Second-hand evidence is a WATCH at most.** HYPE a contract pays out inside someone else's transaction is not that person's gift: it is most often a sale or a game win. Seen live: an NFT marketplace paying sellers 88% of a round price, and the CoinFlip and Splash games paying winners from transactions their operators' bots send. v0.2 credited all of it to the sender, so a buyer "funded" everyone it bought from. Now a contract payout links wallets only when one transaction paid two or more of the coin's wallets (a batch payment, as through a disperse contract), and that link can make a WATCH, never a FLAG; the finding says so in plain words. Payouts in a transaction sent by the coin's own creator or launcher still count in full.

**Public hubs never link anyone.** The Elysium testnet faucet funded most testers, so linking through it would make everyone one big sybil ring. A funder is a public hub if it is a known faucet or has at least 5,000 transactions, on any network. A coin's own creator or launcher is never a hub on its own coin.

**Testnet and mainnet.** The `NETWORK` setting (`testnet` or `mainnet`; by default it follows the RPC and explorer addresses) picks the profile. On testnet, people fund many wallets from one, run distribution bots and farm, all with free test money, so a wallet that paid HYPE to 20 or more of the wallets DELPHI tracks, or to 5 or more wallets that between them traded 5 or more different coins (not counting coins it launched itself), is treated as public too. On mainnet only the faucet list and the 5,000-transaction rule apply. Measured on the Oct 22 data, the two profiles disagree on one coin: AK, where one funder's 9 wallets (trading 8 different coins) hold 21.8%, is WATCH on mainnet and has no direct finding on testnet.

**Infrastructure is never a holder or a trader.** That covers the launchpad and everything it names (vault, pool manager, treasuries, ListingDesk), the burn sink, every router seen swapping, and any outside pool (a contract that answers `token0()` and `token1()`). Since rules v0.2 it covers every
other contract too (staking, lockers, faucets): before that, everyone who staked PANTHEON was "one actor"
through the staking contract, and the contract itself counted as a holder with 75% of the supply. A report
notes how much contracts hold once it is 10% or more of the tokens outside the pool, so supply parked in a
contract is said out loud.

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

### Plain-English explanations (Claude)

```sh
node scripts/explain.ts            # coins with a finding or a CLEAN verdict, and any with 5+ trades
node scripts/explain.ts --only 0x…  # one coin
node scripts/explain.ts --dry      # which coins it would explain, and the first one's data; no Claude calls
```

Claude (`claude-opus-5-5`) looks into each coin with read-only tools over DELPHI's own data: `coin_report`, `trades`, `holders`, `links`, `clusters`, `wallet` (funding, linked wallets, other coins it touched), `transaction` and `list_coins`. Amounts arrive in human units (tokens, USDC, HYPE) with the transactions behind them. It writes a headline, a short summary, up to six concrete points and its caveats, then calls `submit_report`, which checks the draft before saving it: the verdict must be DELPHI's, and every cited transaction and full address must be part of that coin's data. Errors go back to Claude until the draft passes. Claude explains verdicts and never changes them.

Output: `out/coins/<token>.ai.{json,md}` and `out/explained.md`. A coin is explained again only when its data, the model or the instructions change. The scan's cache is used as is, so explaining never spends the explorer allowance. The first run (9 coins) cost about $1.20.

The key is read from `/var/lib/delphi/keys/anthropic.key` (owner `ayinde`, mode 600; `ANTHROPIC_API_KEY` wins if set). It is never logged or committed. Run the script as `ayinde`.

All settings have working testnet defaults (see `.env.example`). `better-sqlite3` ships prebuilt binaries, so its install script is denied in `package.json` (`allowScripts`).

## The Trials: from DELPHI's scan to a basket proposal

```sh
node scripts/trials.ts                    # next round: out/trials/round-N.json + round-N.tree.json
node scripts/trials.ts --coins 7 --cap-usdc 100
node scripts/trials.ts --round 1 --count-creator --compare ../../deployments/trials/round-1.json
```

It rebuilds every coin from DELPHI's data and ranks them by **independent trading volume in USDC**: volume
in the coin's Ascend pool, minus trades by the creator (and the launcher, and any wallet DELPHI links to
them), minus wash round trips, counted by the same matching the verdicts use. The top coins share the
basket in proportion to that volume, none above the cap.

**Why not count the creator:** test USDC can be minted for free. Live on Oct 14, round 1's top coin FGK
showed "17,000,170 USDC", but 17M of that was the creator buying their own coin, and other wallets traded
about 170 USDC. Three "CRB" coins had 61,700–594,000 USDC each, and every coin's only trade was a dev-buy by
the same wallet.

**Rules come from the contract.** The coin count, the 20% cap, the 72-hour age and the per-run cap limit
are read from the deployed `ConstituentRegistry` (`MAX_N`, `MAX_WEIGHT_BPS`, `MIN_AGE`, `maxRunCap`). It
also checks: priced in USDC, not PNTH, never a DELPHI FLAG.

**It checks before anyone sends anything.** It dry-runs `propose` as the curator on the live chain. Round 2
was accepted. A list with a too-young coin swapped in was refused with `BadList(4)`, the same rule.

**Anyone can verify a round:**
- The registry stores `keccak256` of the exact bytes of the round file (Micheal's propose script). The
  same scan always gives the same bytes, whatever order the data was read in.
- Round 1's published file hashes exactly to the fingerprint of proposal 0; a test pins this.
- The file's `merkleRoot` is an OpenZeppelin standard Merkle tree with one leaf per coin considered: token,
  pool, verdict, total, wash, creator and independent volume, rank, weight, cap. Any coin's row can be
  proven on its own with the tree file.
- `out/` isn't committed: when a round is proposed, its two files go into `deployments/trials/`.

**It warns about coins the basket won't buy when the round can start** (after the registry's 24-hour wait;
the wait, the 48-hour limit and the 5% band are read from the contracts):
- a price average that will be too old by then;
- a price more than 5% above its average.

After a quiet spell the average lags behind the price. FGK, pumped by its creator, was 43,635% above it. The
curator can leave such a coin out with `--exclude 0xTOKEN:reason` (one per coin), and the reason is recorded in
the round file.

**Rehearsed end to end on a local fork** (`node scripts/fork-trials.ts out/trials/round-N.json`):
- The curator proposes exactly as Micheal's script does. The registry stores the file's fingerprint and the
  exact list, refuses to start it before 24 hours, then starts it.
- The basket buys 0 of 5 coins with no settle trades (all stale), 4 of 5 after one 0.01 USDC trade each, and
  **5 of 5 after small settle trades spread over 6 hours**. Settle the coins a few hours before the round
  starts.

**Micheal's own reader:** a parse-only copy of his `propose` script (the same `vm.parseJson*` calls and
`keccak256(bytes(json))`) reads the round-2 file correctly and gives the same fingerprint as this script.

## Commands

| Command | What it does |
|---|---|
| `npm test` | Unit tests (vitest). They never touch the network: `test/setup.ts` rejects any `fetch` to a non-loopback host. The explainer's test runs the whole Claude loop against a local fake of the API. |
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
| `src/ai/workspace.ts` | The scan plus cached pools and funding, loaded once for the explainer |
| `src/ai/tools.ts` | The explainer's read-only tools (plain functions, wrapped for Claude) |
| `src/ai/explain.ts` | Instructions, the `submit_report` checks, the Claude loop, markdown |
| `scripts/explain.ts` | Plain-English explanations (run by hand) |
| `test/` | Synthetic scenarios (`scenario.ts`) and real transactions (`fixtures/live-trades.json`) |

## Safety

- Coin names and symbols are chosen by whoever launched the coin, so they are treated as hostile. Markdown output escapes them (no links, HTML or table breaks) and strips control and bidi characters. File names use the token address only.
- Explorer answers are schema-checked before use. RPC outages are never cached as answers: only a real contract revert is remembered.
- "Nothing found" is not CLEAN unless every check had enough data, including every wallet's funding history.

## Limits (v0)

- Trades on Uniswap-V2-style pairs are not counted as trades yet (their balances are still handled correctly).
- Funding looks at each wallet's earliest 50 incoming transactions and latest 50 contract payments.
- Testnet trading is thin (a few hundred swaps in total), so most coins come out NOT ENOUGH DATA. That answer is honest, not a failure.
- Claude's explanations are checked for verdicts, transactions and addresses, not for every number in the text. Spot checks so far match the data.
