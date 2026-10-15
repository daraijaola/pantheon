# The Trials: the basket vote

HYPE Passport holders pick coins for PANTHEON's basket. A vote is a free signature, not a transaction: the
wallet signs "in round N, I vote for these coins" (EIP-712). The service checks the signature and the
voter's Passport on-chain, and counts each pick as 1, 2 or 3 votes by Passport tier. One Passport is one
voter, and a newer ballot replaces an older one until the vote closes.

Owner: Micheal. It holds no keys and signs nothing; it only reads Passport tiers from the chain.

## How a round works

1. **Open.** `node scripts/open.ts --round 3 --hours 46` writes `deployments/trials/round-3.vote.json` from
   DELPHI's latest data. A coin can be voted for if it traded with someone other than its creator, DELPHI
   never flagged it, it's priced in USDC, and it will be 72 hours old when the vote closes (the basket
   list's own rule). Commit the file: it's the public record of the candidates and the times. The service
   re-reads the folder on every request, so there's nothing to restart.
2. **Vote.** pantheonindex.com/trials/vote. Each voter picks up to `seats` coins (3).
3. **Close.** `node scripts/close.ts --round 3` counts the ballots and picks the list: the vote's winners,
   then the coins with the most independent trading. It prints the DELPHI command that builds the proposal
   for exactly that list. `--merge` then checks DELPHI's file and adds the vote to it: every signed ballot,
   the count and the winners. The result is `deployments/trials/round-3.json`.
4. **Propose.** `script/Testnet.s.sol propose(file)`, run by the curator, stores keccak256 of that file
   on-chain. The ballots are part of what was proposed. The list waits 24 hours, and the guardian can veto
   it.

Anyone can recount: `GET /api/trials/rounds/3` returns every ballot with its signature.

## API (127.0.0.1:8790; the site forwards `/api/trials/*`)

| Route | What it gives |
|---|---|
| `GET /trials/current[?voter=0x…]` | The newest round: status, times, candidates with live votes, the leaders, and, with `voter`, that wallet's tier and ballot |
| `POST /trials/vote` | `{round, voter, coins, signedAt, signature}`. Errors are codes: `NO_PASSPORT`, `BAD_SIGNATURE`, `CLOSED`, `NOT_OPEN`, `WRONG_ROUND`, `TOO_MANY_COINS`, `DUPLICATE_COIN`, `NOT_A_CANDIDATE`, `STALE_SIGNATURE` (older than 10 minutes), `OLDER_BALLOT`, `RATE_LIMITED` |
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
