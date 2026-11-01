# Get uploaded: the backend

Read-only data for a wallet's space on PANTHEON. Micheal builds the screens; this service gives him clean
answers to plug in. It holds no keys and sends no transactions. Brief:
`/srv/hackathon/notes/BRIEF-techblaze-get-uploaded.md`.

Status: the verdict lookup is done. There is no server yet, so nothing is reachable from outside.

```sh
npm install
npm run check    # types, lint and tests; tests never touch the network
```

## The verdict lookup (`src/verdicts.ts`)

Holds what DELPHI last said about every coin in memory, so a lookup never touches the disk.

- **Source:** DELPHI's `out/scan.json`: every coin on Ascend, Kalos and PerpMe, with findings and the
  transactions behind them. `refresh()` reloads it when the file changes.
- **UNKNOWN is never CLEAN.** A coin DELPHI hasn't read, or that has left a scan, comes back `UNKNOWN`.
- **A bad file changes nothing.** The scan rewrites the file in place, so a read can catch it half-written.
  The last good copy keeps answering, and `health()` reports the error.
- **Old verdicts say so.** `stale` turns true when the scan is over 14 hours old.
- **The written explanations in `out/site.json` are not used.** They can be older than the current verdict.
