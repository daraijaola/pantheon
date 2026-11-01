# Get uploaded: the backend

Read-only data for a wallet's space on PANTHEON. Micheal builds the screens; this service gives him clean
answers to plug in. It holds no keys and sends no transactions. Brief:
`/srv/hackathon/notes/BRIEF-techblaze-get-uploaded.md`.

Status: the verdict lookup, the server, "check any coin", the holdings reader, wallet history, the bag, the wallet scan, stake data, basket data, standing facts, Guard, the Trials round and the voting record are done. It listens on this machine only
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
| `ARCHIVE_RPC` | the explorer's node | Where wallet history is read: it needs old blocks and batches. |
| `DEPLOYMENT_FILE` | `../../deployments/elysium-testnet.json` | The contract addresses, from the file the site reads. |
| `INDEXER_URL` | `http://127.0.0.1:8789` | The indexer: the basket's buys, every claim and every stake. |
| `TRIALS_URL` | `http://127.0.0.1:8790` | The Trials service: who voted in each round. |
| `SCAN_FILE` | `../delphi/out/scan.json` | DELPHI's latest results. Only ever read. |
| `REFRESH_SEC` | `60` | How often to look for a new scan. |
| `DELPHI_DIR` | `../delphi` | Where DELPHI's code and cache are. Fresh reads run there. |
| `FRESH_READS` | `on` | `off` means scans only. |
| `FRESH_GAP_SEC` | `300` | At most one fresh read this often. |
| `GUARD_READ_SEC` | `900` | How often Guard reads on its own. Needs `FRESH_READS` on. |
| `GUARD_FILE` | `data/guard.json` | What Guard remembers: past verdicts and its alerts. Keep this file: it's the only record of them. |

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

## The Trials round (`src/trials.ts`)

`GET /trials/round` answers the latest round: `{round, status, opensAt, closesAt, secondsLeft, seats, ballots, method,
candidates}`, or 404 `NO_ROUND`, or 503 `TRIALS_UNAVAILABLE`. Each candidate has `votes`, `voters`, `rank`, `inSeat`,
DELPHI's `verdict` now, `verdictAtOpen`, `verdictChanged`, `reason`, `reportUrl`, `disputeUrl` and `stale`.

- **Two verdicts, on purpose.** A round's file records each coin's verdict when the round was set, and a coin can
  change after that. 3 of round 5's 20 candidates had changed by Nov 1.
- **A candidate that's now FLAG stays a candidate.** That's what the round says; the screen shows the new verdict.
  What should happen to it is Micheal's call.
- **`status` comes from the times,** so a remembered answer can't say open after a round has closed. The round is
  remembered for 15 s, but the clock and the verdicts are live.
- On Nov 1, round 5's votes matched a recount from the raw ballots on all 20 candidates. No round was open then, so the
  open and upcoming states are covered by tests, not a real round.

## Ballot and voting record (`src/record.ts`)

The vote itself stays where it is: the page signs a ballot and posts it to `/api/trials/vote`, as it does today. That
service already refuses more picks than the round has seats.

`GET /wallets/{address}/ballot` says whether this wallet can vote now: `{round, canVote, whyNot, votes, maxPicks, picks,
closesAt}`. `whyNot` is `NO_ROUND`, `NOT_OPEN`, `CLOSED`, `NO_VOTES`, or `UNKNOWN` when the chain didn't answer.

`GET /wallets/{address}/record` is its voting record, newest round first: `{rounds, totals, complete}`. Each pick has
`wonSeat`, `inBasketNow`, `verdictNow` and `changePct`. Both answer 503 `TRIALS_UNAVAILABLE` if that service is down.

- **`wonSeat` is the vote; `inBasketNow` is what's in the basket today.** They can differ.
- **`changePct`** is the price change since the round closed, in test money on testnet. It's null with no fresh read
  yet, for a coin with no trade by then, and while a round is open. It uses the last traded price, which can be old on a
  quiet coin, and fresh reads cover Ascend only.
- **Only this wallet's own ballot is shown.** The Trials service publishes every ballot, so anyone can read them there.
- On Nov 1 all 43 real voters were right on rounds and all 131 picks, against the raw ballots. Price changes were
  within 5 points of the basket's own buy prices on all 9 pairs that could be compared. No round was open, so voting
  while a round is open wasn't tried for real.

## Guard (`src/guard.ts`)

`GET /wallets/{address}/guard?since={date}` lists alerts on the coins this wallet holds now, newest first, going back
a week by default. It answers `{alerts, coinsWatched, watchingSince, salesSeenOn, unread, complete}`. Each alert has
`kind`, the coin, `at`, `reason`, `evidence` (transactions), `reportUrl` and `disputeUrl`, plus `from` and `to` or
`soldPct`. An empty list is the normal answer. How alerts reach people is undecided, so this only keeps the list.

- **`verdict-drop`:** a coin went from CLEAN to WATCH or FLAG. Nothing else alerts, not even WATCH to FLAG, as the
  brief says. DELPHI keeps only the latest verdict, so Guard remembers the last one in its own file.
- **`creator-sold`:** the creator's group (creator, launcher and wallets linked to them) sold 1% or more of the supply
  in a UTC day. One alert per coin per day, which grows if more is sold. Ascend only: only a fresh read has sales.
- **A rules change isn't news.** If DELPHI's rules version changed, a new verdict alerts no one.
- **It only speaks for what it watched.** The first read of a coin sets the starting point, and sales over 2 days old
  are history, so it won't report last month on day one. `watchingSince` says when it began.
- **Choices worth a second look:** the 1% line came from real data on Nov 1: every coin-day of sales was under 0.5% or
  over 1%. Mainnet may differ.

## Standing facts (`src/standing.ts`)

`GET /wallets/{address}/standing` answers `{firstSeen, staking, roundsVoted, coinsLaunched, passport, complete}`. These
are facts only. What earns each role (Staker, Councillor, Creator, Pillar, Genesis) is Micheal's to decide, so no role
is named here, and the rules can sit on top of these later.

- `staking`: `now`, `bonusSince` (when the current bonus started) and `firstStaked` (the first stake ever).
- `roundsVoted`: the Trials rounds this wallet voted in, oldest first. Closed rounds are read once.
- `coinsLaunched`: `total` and `byVerdict`. Covenant launches don't credit a person yet (see Wallet history).
- `passport`: `tier` and `boost`.
- **A part that can't be read is null, never 0 or an empty list,** and `complete` is false. If the indexer or Trials
  is down, `firstStaked` or `roundsVoted` is null. "Never voted" always means it was checked.

On Nov 1 this matched 41 of 41 real wallets on rounds voted, on first stake (against the chain's own events) and on
coins launched, and all 6 real Passports on tier and boost.

## Basket and rewards (`src/basket.ts`)

`GET /basket` answers `{updatedAt, proposal, coins, recentBuys}`: each coin's weight, what was bought and spent, its
last buy, and DELPHI's verdict, reason and dispute link, plus the 20 newest buys with their transactions.

`GET /wallets/{address}/rewards` answers `{coins, recentClaims, passportBoost, unread, complete}`. Each coin has
`claimable`, `claimed` and `earned` (both together), and DELPHI's `verdict`, which is null for USDC. Most to claim
comes first. Both are remembered for 30 s, so `claimable` can be slightly behind: rewards stream every second.

- **Claimable comes from the staking contract, claimed from the indexer.** On Nov 1, claimed totals matched the
  chain's own claim events on 393 of 393 coins checked, and 150 simulated claims paid what was shown or up to 0.1% more.
- **If the indexer is down,** claimable still answers, `claimed` and `earned` are null (never 0) and `complete` is false.
- **The testnet contract predates `retiredTokens`,** so that read may fail. Coins a wallet claimed once are always
  included, even if they've left the contract's list.

## Stake data (`src/stake.ts`)

`GET /wallets/{address}/stake` answers `{staked, cooling, coolEnd, canWithdraw, stakeStart, timeBonus, passportBoost,
multiplier, needsRefresh}`. `GET /wallets/{address}/stake/unstake-preview?amount={raw PNTH}` answers what signing an
unstake of that amount would do: `{stakedAfter, coolingAfter, coolEndAfter, restartsCooldown, timeBonus, daysLost,
working, bonusLost}`, or 400 `ZERO_AMOUNT`, `TOO_MUCH` or `INVALID_AMOUNT`. Both are remembered for 10 s only.

The sums copy `PantheonStaking` exactly. On Nov 1 they matched the contract on 59 of 59 real stakers, and the preview
matched 48 of 48 unstakes simulated on the node, to the last digit. The screen should say these plainly:

- **Unstaking any amount restarts the time bonus on the whole stake.** Unstaking 1 PNTH of a million sends all of it
  back to 1.0×. `daysLost` and `bonusLost` are that cost. `bonusLost` is on what stays staked.
- **`cancelUnstake` doesn't bring the bonus back.** It restarts the clock again. Simulated on the node.
- **A second unstake restarts the 3 days** on everything already unlocking (`restartsCooldown`).
- **The bonus shown may not be earning yet.** What earns is a stored number that only moves when the account is
  touched. `multiplier.earning` is what the stake earns at now, `ifRefreshed` is what it would earn at, and
  `needsRefresh` says a `poke` would raise it. Anyone can call `poke`, and whoever does pays the gas.

## The wallet scan (`src/scan.ts`)

`GET /wallets/{address}/scan` is the one the upload animation uses. It stays open and sends each stage as soon as
it's ready, as server-sent events: one `stage` event each, then `done`. Times are from real wallets on Nov 1, for a
wallet not read in the last minute. A wallet read recently answers in milliseconds.

| Stage | About | `data` |
|---|---|---|
| `history` | 0.4 s | The quick part of `/history`: `txsSent`, `hype`, `coinsLaunched`, `network` |
| `holdings` | 2 s | The same as `/holdings` |
| `verdicts` | right after holdings | The same as `/bag` |
| `firstDay` | 3 s | `{firstSeen}`: `{block, time}`, or null if the wallet has never been active |
| `standing` | 3 to 5 s, with the first day | The same as `/standing` |

They always come in that order. Each is `{stage, ok: true, data}` or `{stage, ok: false, error}`, where `error` is
`CHAIN_UNAVAILABLE`, `NOT_READY` or `TIMEOUT` (a stage gives up after 30 s). A failed stage never
stops the others. `verdicts` fails if `holdings` did. `done` is `{failed: [stage names]}`.

```js
const es = new EventSource(`/api/uploaded/wallets/${wallet}/scan`); // the site's forwarding isn't set up yet
es.addEventListener("stage", (e) => {
  const { stage, ok, data, error } = JSON.parse(e.data);
  // show this stage, or leave it out if !ok
});
es.addEventListener("done", () => es.close()); // close here, or EventSource reconnects and scans again
```

The first day is its own stage on purpose. Every trip to the node takes about 400 ms and the search needs about 8,
so inside `history` it would hold back everything behind it, and all the stages would land together.

## The bag (`src/bag.ts`)

`GET /wallets/{address}/bag` joins holdings and verdicts, worst first: FLAG, WATCH, UNKNOWN, NOT_ENOUGH_DATA, CLEAN.
It answers `{wallet, network, readAt, coins, counts, unread, complete, checking}`. Each coin has its amount, verdict,
one-line `reason`, `findings` with their transactions, `notes`, `reportUrl`, `disputeUrl`, `scannedAt` and `stale`.

- **`counts`** are plain coin counts for each verdict. Unread and too-new coins are never counted as clean. Holdings
  are remembered for 30 s, but verdicts aren't, so a verdict is always the latest.
- **`complete`** is false if any coin couldn't be read, so an Integrity figure shouldn't be shown as final.
- **`checking`** is true while a fresh read is running that may change a verdict here.
- **Integrity isn't worked out here.** The brief says it's "the % of the bag", and that could mean by coin count or
  by value. By value needs prices. That's Micheal's call.

## Wallet history (`src/history.ts`)

`GET /wallets/{address}/history` answers `{wallet, network, readAt, firstSeen, txsSent, hype, coinsLaunched}`.
About 3 s the first time, then remembered for a minute. A first day, once found, is kept until restart.

- **First day:** the first block where the wallet had HYPE or had sent a transaction, found by searching past
  blocks, 48 points a step. On 30 real wallets it matched DELPHI's own funding records exactly (Nov 1).
- **Funders are not read,** because they're never shown.
- **Coins launched:** from DELPHI's scan, with each coin's verdict. Coins launched through Covenant name the
  Covenant factory as their creator (PNTH and COVD do), so the person who launched them gets no credit yet.
- A wallet that only ever received tokens has no first day, and `firstSeen` is null.

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
