# PANTHEON indexer: the site's live numbers

A small read-only service. It follows PANTHEON's contracts on Elysium testnet and gives the site ready
JSON, with **every number linked to its transaction**: PNTH burned, USDC sent to the basket, each basket
buy, the basket's coin list and proposals, and staking totals. Without it, the site would have to search
the chain in each visitor's browser, which is slow and runs into the public RPC's rate limits.

Owner: Ayinde. Status and notes: `TASKS.md` (A4). It has no keys and signs nothing.

## Routes (on `127.0.0.1:8789`)

| Route | What it gives |
|---|---|
| `GET /stats` | Totals: PNTH supply, burned (all, and from fees, with the last burn), basket USDC received / spent / streamed / waiting, buys and skips, staking total, stakers, rewards per token. Also cross-checks against the contracts (`consistent`). |
| `GET /basket` | The active coin list (each coin's weight, per-run cap, total bought, USDC spent, last buy, last skip) and every proposal with its status (`waiting`, `ready`, `active`, `replaced`, `vetoed`, `lapsed`), start time, Merkle root and transactions. |
| `GET /receipts` | Every event, newest first. Filters: `kind=burn,buy,…`, `account=0x…`, `token=0x…`, `limit=1–200` (50). Page with `before=<next>`. |
| `GET /health` | `{ok, block, events}`; 503 until the first read of the chain is done. |

Event kinds:
- `burn` (PNTH burned from fees), `to-basket` (USDC from fees to the basket), `run` (one fee routing), `deferred` (a leg that waits for the next run);
- `buy`, `skip` (with the reason), `stream` (the basket);
- `proposed`, `executed`, `vetoed` (basket lists);
- `stake`, `unstake`, `cancel-unstake`, `withdraw`, `claim`, `reward` (staking).

Every amount looks like `{raw, value, symbol, token}`: `raw` is in the token's smallest unit, `value` is readable. Every event has `tx`, `url` (explorer), `block` and `at` (unix time). Answers can be cached for 15 s.

## Connecting the site (Micheal)

One rewrite in `web/next.config.ts`, next to the Passport one:

```ts
{ source: "/api/:path(stats|basket|receipts)", destination: `${process.env.INDEXER_API ?? "http://127.0.0.1:8789"}/:path` },
```

Query strings pass through. The site already forwards each visitor's address (checked: Passport sees real
visitor addresses through it). So the limit of 120 requests per minute applies per visitor, not to the
whole site.

## How it works

- **Every 30 s** it reads new events from the four contracts (fee router, basket vault, basket registry,
  staking) since its cursor, in 500k-block chunks, plus the time of each event's block. It then reads the
  current values with one batched call: burn-sink balance, PNTH supply, vault USDC, staking totals, reward
  tokens, the active list and every proposal.
- **What it has read is saved** in `/var/lib/indexer/index.json` (temporary file, then rename). A restart
  continues from the cursor instead of re-reading the chain; it's ready again in about 3 s.
- **Visitors never cause chain reads.** Answers are built from memory. If a poll fails, the last good data
  keeps being served.
- **Coin symbols** are chosen by their creators, so they are stripped to short printable text.
- **Proposal status** follows the registry's own rules: a 24 h wait, then 7 days to start it; a newer
  active list replaces older ones.

## On the server

The systemd unit is `pantheon-indexer` (file in `deploy/`). It runs as `ayinde`, read-only to the system
and code, writing only to `/var/lib/indexer`; `systemd-analyze security` rates it 3.0 ("OK").

```sh
sudo systemctl status pantheon-indexer
journalctl -u pantheon-indexer -f
curl -s 127.0.0.1:8789/stats
```

Ports: 8787 is the live Passport, 8788 is Micheal's development Passport, 8789 is this.

## Checked live (Oct 14)

- **It matches the chain:** 50,000 PNTH burned (one burn); 5 USDC to the basket and on to stakers; 82M PNTH
  staked by one staker; basket proposal 0 (FGK, FLOW, FLOWR, PACT, DAWN at 20% each, cap 100 USDC per run)
  waiting to start on 15 Oct 20:21 UTC. Staked totals rebuilt from events equal the contract's own.
- **Load:** 200 requests over 20,000 events take under 3 s (answers are built once per poll).
- **The site's rewrite line** was checked with Next.js 16.4's own route matcher. It matches exactly
  `/api/stats`, `/api/basket` and `/api/receipts`, never Passport's routes or look-alikes, and passes the
  query on.
- **Resilience:** after a restart it's ready in about 3 s without re-reading; after `kill -9` it's back on its
  own; with the RPC unreachable it answers 503 "not ready" cleanly. It answers bad queries with a reason
  (400), unknown paths with 404, and floods from one address with 429.

## End-to-end test on a local copy of the chain

```sh
anvil --host 127.0.0.1 --port 8547 --fork-url https://testnet-rpc.elysium.kinetiq.xyz --compute-units-per-second 40
node scripts/fork-test.ts             # 26 checks; start each run from a fresh fork
```

On the fork it makes every kind of event:
- PNTH trades, then the fee run (burn + basket payment);
- a stake, an unstake, a cancel, another unstake;
- basket proposal 0 started after its 24 hours;
- a 1 USDC "settle" trade per basket coin, 50 USDC into the basket, a rebalance;
- 3 days later, a withdraw and the claims.

Then it indexes from the deployment block and checks each answer against the fork's own numbers: burn
sink, vault USDC before and after, the staking total, and the active list. **Last run: 26/26 (28 events).**

**Found in that run, for the basket:** after the 1 USDC settle trades, 3 of the 5 coins were skipped as
"price more than 5% above its average". In these thin pools the settle buy itself seems to push the price
past the basket's buying range. Settle trades should be smaller, or a buy and sell, or made well before
the rebalance.

## Commands

| Command | What it does |
|---|---|
| `npm test` | Unit tests (vitest), including the real Oct 14 transactions. They never touch the network. |
| `npm run check` | Typecheck, lint and tests; run before every commit |
| `npm start` | Run it by hand (the server uses the systemd unit) |

DELPHI's coin reports are not served here: the site reads DELPHI's published file directly.
