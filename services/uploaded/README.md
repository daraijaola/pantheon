# Get uploaded: the backend

Read-only data for a wallet's space on PANTHEON. Micheal builds the screens; this service gives him clean
answers to plug in. It holds no keys and sends no transactions. Brief:
`/srv/hackathon/notes/BRIEF-techblaze-get-uploaded.md`.

Status: the verdict lookup, the server, "check any coin" and the holdings reader are done. It listens on this machine only
(`127.0.0.1:8791`) and isn't installed as an always-on service yet. Nothing private may be served until sign-in is decided.

```sh
npm install
npm run check    # types, lint and tests; tests never touch the network
npm start        # settings below; run it from this folder
```

## Settings

| Setting | Default | What it is |
|---|---|---|
| `PORT` | `8791` | Where it listens. Passport has 8787, the indexer 8789, Trials 8790 and the feed 3210. |
| `ELYSIUM_RPC` | the public testnet node | Where balances are read. |
| `SCAN_FILE` | `../delphi/out/scan.json` | DELPHI's latest results. Only ever read. |
| `REFRESH_SEC` | `60` | How often to look for a new scan. |
| `DELPHI_DIR` | `../delphi` | Where DELPHI's code and cache are. Fresh reads run there. |
| `FRESH_READS` | `on` | `off` means scans only. |
| `FRESH_GAP_SEC` | `300` | At most one fresh read this often. |

A wrong value stops it at start.

## Routes

| Route | Answer |
|---|---|
| `GET /health` | `{ok, coins, network, scannedAt, freshAt, stale, reading}`. 503 until it has verdicts. `reading` is `failing` when the latest file can't be read and it's serving the last good copy. |
| `GET /coins/{address}` | DELPHI's verdict, one-line `reason`, `findings` with their transactions, `notes`, `reportUrl`, `disputeUrl`, `venue`, `network`, `scannedAt`, `stale`, and `checking`. A coin it hasn't read is a normal answer with `verdict: "UNKNOWN"`. 400 `INVALID_ADDRESS` if it isn't an address. |

## The verdict lookup (`src/verdicts.ts`)

Holds what DELPHI last said about every coin in memory, so a lookup never touches the disk.

- **Source:** DELPHI's `out/scan.json`: every coin on Ascend, Kalos and PerpMe, with findings and the
  transactions behind them. `refresh()` reloads it when the file changes.
- **UNKNOWN is never CLEAN.** A coin DELPHI hasn't read, or that has left a scan, comes back `UNKNOWN`.
- **A bad file changes nothing.** The scan rewrites the file in place, so a read can catch it half-written.
  The last good copy keeps answering, and `health()` reports the error.
- **Old verdicts say so.** `stale` turns true when the scan is over 14 hours old.
- **The written explanations in `out/site.json` are not used.** They can be older than the current verdict.

## Holdings (`src/holdings.ts`)

`GET /wallets/{address}/holdings` asks the chain what a wallet holds of every coin DELPHI has read, in one
bundled request. The explorer's API has been behind a bot check since Oct 25, so it isn't used. It answers
`{wallet, network, readAt, coinsChecked, holdings, unread}`; each holding has its `amount`, raw `balance`,
`decimals` and `venue`. About 2 s the first time, then remembered for 30 s.

- **Unread is not "not held".** A coin that can't be read goes in `unread`. A read that fails altogether is a 503
  (`CHAIN_UNAVAILABLE`, or `NOT_READY` before DELPHI's coins load). An empty list always means every coin was read.
- **One bundle, one request.** `batchSize: 0` matters: by default viem splits a bundle into many small requests at
  once, and the public node refuses some of them.
- **What it doesn't see:** coins DELPHI hasn't read, and PNTH that's staked (it sits in the staking contract).
- **One wallet at a time,** to go easy on the public node. A busy launch day will need a paid node.
- **Private on purpose:** this route must not go public before sign-in is decided.

## Fresh reads (`src/fresh.ts`)

A question always gets an answer from memory, in milliseconds. If the coin is unknown, or its Ascend verdict is
over 30 minutes old, that answer says `checking: true` and a fresh read starts. Ask again in about 15 seconds
for the new verdict.

- **Ascend only.** A read of Ascend takes about 11 s and gave the same verdict as the scan on all 208 coins
  (Nov 1). All three markets take about 3.5 minutes, so Kalos and PerpMe coins wait for the scan and show how
  old their verdict is. A new Kalos or PerpMe coin stays UNKNOWN until then.
- **Bounded.** One read at a time, at most one every 5 minutes, however many coins are asked about.
- **Separate.** The read is DELPHI's own script (`services/delphi/scripts/fresh-read.ts`) in its own process, so
  a failure can't reach this server. It uses DELPHI's live cache, like `scripts/x.ts --ask`, so this service must
  run as DELPHI's service user.
