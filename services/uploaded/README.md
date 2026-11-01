# Get uploaded: the backend

Read-only data for a wallet's space on PANTHEON. Micheal builds the screens; this service gives him clean
answers to plug in. It holds no keys and sends no transactions. Brief:
`/srv/hackathon/notes/BRIEF-techblaze-get-uploaded.md`.

Status: the verdict lookup and the server are done. It listens on this machine only (`127.0.0.1:8791`) and
isn't installed as an always-on service yet. Nothing private may be served until sign-in is decided.

```sh
npm install
npm run check    # types, lint and tests; tests never touch the network
npm start        # settings below; run it from this folder
```

## Settings

| Setting | Default | What it is |
|---|---|---|
| `PORT` | `8791` | Where it listens. Passport has 8787, the indexer 8789, Trials 8790 and the feed 3210. |
| `SCAN_FILE` | `../delphi/out/scan.json` | DELPHI's latest results. Only ever read. |
| `REFRESH_SEC` | `60` | How often to look for a new scan. |

A wrong value stops it at start.

## Routes

| Route | Answer |
|---|---|
| `GET /health` | `{ok, coins, network, scannedAt, stale, reading}`. 503 until it has verdicts. `reading` is `failing` when the latest file can't be read and it's serving the last good copy. |

## The verdict lookup (`src/verdicts.ts`)

Holds what DELPHI last said about every coin in memory, so a lookup never touches the disk.

- **Source:** DELPHI's `out/scan.json`: every coin on Ascend, Kalos and PerpMe, with findings and the
  transactions behind them. `refresh()` reloads it when the file changes.
- **UNKNOWN is never CLEAN.** A coin DELPHI hasn't read, or that has left a scan, comes back `UNKNOWN`.
- **A bad file changes nothing.** The scan rewrites the file in place, so a read can catch it half-written.
  The last good copy keeps answering, and `health()` reports the error.
- **Old verdicts say so.** `stale` turns true when the scan is over 14 hours old.
- **The written explanations in `out/site.json` are not used.** They can be older than the current verdict.
