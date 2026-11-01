# The Trials: the basket vote

PNTH stakers and HYPE Passport holders pick coins for PANTHEON's basket. A vote is a free signature, not a
transaction: the wallet signs "in round N, I vote for these coins" (EIP-712). The service checks the
signature, then reads the wallet's stake and Passport on-chain:

| The wallet has | Votes on each coin it picks |
|---|---|
| At least 1 PNTH staked (`MIN_STAKE`; tokens that are unlocking don't count) | 1 |
| A HYPE Passport, tier 1, 2 or 3 | 1, 2 or 3 more (a Passport alone also votes) |

So a staker with a tier 3 Passport puts 4 votes on each pick. One wallet is one voter, and a newer ballot
replaces an older one until the vote closes. Each ballot keeps the stake, tier and weight it was counted
with.

Why stake: it's what PNTH holders do to earn the basket, so the people who vote are the people paid by it.
A stake can't be moved to another wallet to vote twice in a round, because unstaking takes 3 days and
rounds are shorter than that. Keep them shorter. On testnet the bar is 1 PNTH and test PNTH is free, so one
person with many wallets can cast many votes; on mainnet PNTH costs money, and `MIN_STAKE` should be set
with the launch price in mind.

Owner: Micheal. It holds no keys and signs nothing; it only reads stakes and Passport tiers from the chain.

## How a round works

1. **Open.** `node scripts/open.ts --round 6 --hours 46` writes `deployments/trials/round-6.vote.json` from
   DELPHI's latest data. A coin can be voted for if it traded with someone other than its creator, DELPHI
   never flagged it, it's priced in USDC, and it will be 72 hours old when the vote closes (the basket
   list's own rule). The basket list will hold `--coins` coins (10). All but `--seats` (3) of them are in
   by trading before anyone votes: the best ranks, written as `tradingSeats`. So whenever there are more
   candidates than the list holds, the vote decides 3 coins of its own (with fewer, every candidate gets
   in anyway). The file says all of it in words too (`method`). Commit the file: it's the public record
   of the candidates, the rules and the times. The service re-reads the folder on every request, so
   there's nothing to restart.
2. **Vote.** pantheonindex.com/trials/vote. Each voter picks up to `seats` coins from the ones not in by
   trading.
3. **Close.** `node scripts/close.ts --round 6` counts the ballots and picks the list: the coins in by
   trading, then the vote's winners, then the most independent trading, up to `--coins`. It prints the
   DELPHI command that builds the proposal for exactly that list. `--merge` then checks DELPHI's file and
   adds the vote to it: every signed ballot, the count and the winners. The result is
   `deployments/trials/round-6.json`.
4. **Propose.** `script/Testnet.s.sol propose(file)`, run by the curator, stores keccak256 of that file
   on-chain. The ballots are part of what was proposed. The list waits 24 hours, and the guardian can veto
   it.

Rounds 1 to 5 had no `tradingSeats`, and a round file without it is counted exactly as before: the
vote's seats go to the most-voted coins of all, and `close.ts` takes the winners, then the most
independent trading. Recounting them gives the same winners.

Anyone can recount: `GET /api/trials/rounds/3` returns every ballot with its signature.

## Round fields

Each newer rule is on only when its field is in the round file. `open.ts` writes it.

| Field | What it does | Without it |
|---|---|---|
| `tradingSeats` | The coins with the `tradingSeats` best ranks are in by trading, fixed when the round opens. The vote's `seats` go to the most-voted coins among the rest (at least 1 vote; equal votes go to the better rank). A seat nobody votes for goes to the best rank left. A ballot can't pick a coin in by trading (`ALREADY_IN`) | The vote's seats go to the most-voted coins of all |

## API (127.0.0.1:8790; the site forwards `/api/trials/*`)

| Route | What it gives |
|---|---|
| `GET /trials/current[?voter=0x…]` | The newest round: status, times, `seats`, `tradingSeats` if it has it, candidates with live votes and `inByTrading` (always false before round 6), the leaders, and, with `voter`, that wallet's votes (`weight`), `staked`, `tier` and ballot |
| `POST /trials/vote` | `{round, voter, coins, signedAt, signature}`. Errors are codes: `NO_VOTES` (no PNTH staked and no Passport), `ALREADY_IN` (a coin picked is in by trading already), `BAD_SIGNATURE`, `CLOSED`, `NOT_OPEN`, `WRONG_ROUND`, `TOO_MANY_COINS`, `DUPLICATE_COIN`, `NOT_A_CANDIDATE`, `STALE_SIGNATURE` (older than 10 minutes), `OLDER_BALLOT`, `CHAIN_UNAVAILABLE`, `INVALID_BALLOT`, `RATE_LIMITED` |
| `GET /trials/rounds/:n` | A whole round with every signed ballot |
| `GET /health` | `{ok, round, status}` |

The EIP-712 domain is `{name: "PANTHEON Trials", version: "1", chainId}` with type
`Ballot(uint256 round, address voter, address[] coins, uint64 signedAt)`. `web/src/components/app/trials-app.tsx`
signs the same thing.

## Run

```sh
npm ci
npm run check        # typecheck, lint, tests (no network: test/setup.ts blocks it)
npm start            # 127.0.0.1:8790; ballots in data/ballots.json unless STATE_FILE is set
```
