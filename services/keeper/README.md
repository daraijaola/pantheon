# PANTHEON keeper

The keeper does PANTHEON's routine chores, so nobody has to remember them. Every job is a call anyone may
make on the contracts, but someone has to make it:

1. **Route PNTH's fees** (`CovenantRouter.run`). This collects PNTH's creator fees from Ascend: the PNTH
   half (from sells) is burned, and the USDC half (from buys) goes to the basket.
2. **Spend the basket** (`IndexVault.rebalance(k)`). This buys the next `k` basket coins with the vault's
   USDC and streams them to stakers. With no basket list yet, the contract streams the USDC itself.
3. **Refresh staking boosts** (`PantheonStaking.poke`). A staker's boost doesn't update by itself. A
   lapsed or downgraded Passport would keep its old boost (unfair to everyone else) until someone pokes it.

Owner: Ayinde. Status and notes: `TASKS.md` (A3).

## How a round works (every 5 minutes)

1. **New stakers** are found from `Staked` events since the last round.
2. **Whose boost to check:** everyone the Passport service flags (`GET /passport/pokes?since=`: new tier,
   unlink, expiry), plus a rotating slice of up to 200 of all stakers, so everyone is checked over time.
   If the Passport service is down, the rotation alone still catches every change.
3. **Which boosts to refresh:** any that would **fall**, at once (fairness); any that would **rise** by at
   least 2%, since the time bonus grows every second and crumbs aren't worth gas. Up to 50 per poke.
4. **Simulate the whole bundle on the live chain, in order:** run, then rebalance, then pokes. This uses
   Elysium's `eth_simulateV1`, so the preview shows the events the real calls would emit.
5. **Send only what would do something:** fees delivered, a coin bought or streamed, a boost changed. A
   call that would fail, or would only skip, is never paid for.

**Practice mode** (the default) stops after step 5 and logs what it would have sent. It never loads a key.
**Live mode** (`KEEPER_MODE=live`) sends the calls one by one with a gas-only key, and stops sending if
that wallet has less than 0.001 HYPE.

## Run

```sh
cd services/keeper && npm ci
npm run once                          # one practice round, printed for people (saves nothing)
node scripts/probe-whatif.ts 200      # what-if: simulate a 200 USDC buy + a sell, then the keeper's calls
npm start                             # the loop (on the server it's the systemd service below)
```

**End-to-end test in live mode, on a local copy of the chain** (never the real one):

```sh
anvil --host 127.0.0.1 --port 8547 --fork-url https://testnet-rpc.elysium.kinetiq.xyz --compute-units-per-second 40
node scripts/fork-test.ts             # 11 checks
```

On the fork it trades PNTH (so fees accrue) and stakes, then runs real keeper rounds with anvil's public
test key. It checks:
- fees routed and PNTH burned;
- the basket's USDC streamed;
- the new staker found;
- nothing sent when there's nothing to do;
- boosts refreshed after 3 days (+5% time bonus);
- practice mode sends nothing;
- an empty wallet sends nothing;
- a top-up resumes.

Elysium runs Arbitrum's node software, whose block headers lack Ethereum's blob-gas field. So anvil
refuses calls on the forked block until it has mined one of its own, and the script does that first.

On the server it runs as the systemd unit `pantheon-keeper` (file in `deploy/`), in practice mode, as
`ayinde`, locked down (`systemd-analyze security` 3.0 "OK"). Its state is in `/var/lib/keeper/state.json`.

```sh
sudo systemctl status pantheon-keeper
journalctl -u pantheon-keeper -f      # one JSON line per round
```

## Settings

All have working defaults; set them in `services/keeper/.env` (not committed).

| Variable | Default | Notes |
|---|---|---|
| `KEEPER_MODE` | `dry` | `live` sends; it needs `KEEPER_KEY_FILE` and Micheal's OK |
| `KEEPER_KEY_FILE` | `/var/lib/keeper/keys/keeper.key` | Gas-only key, mode 0600; read only in live mode |
| `INTERVAL_SEC` | `300` | Minimum 60 |
| `BASKET_K` | `5` | Coins per rebalance (Micheal's script uses 5) |
| `POKE_RISE_BPS` | `200` | Refresh a rising boost from +2% |
| `POKE_BATCH` | `50` | Accounts per poke |
| `DEPLOYMENT_FILE` | `../../deployments/elysium-testnet.json` | The same addresses the site uses |
| `PASSPORT_API` | `http://127.0.0.1:8787` | The Passport service |
| `ELYSIUM_RPC` | public testnet RPC | |
| `STATE_FILE` | `data/state.json` | The service uses `/var/lib/keeper/state.json` |

## Checked live (Oct 14)

- **Micheal's first keep, read back:** 50,000 PNTH burned and 5 USDC sent to the basket, then streamed to
  stakers. These receipts are the test fixture (`test/fixtures/first-keep.json`).
- **What-if probe:** a simulated 200 USDC buy and 1M PNTH sell give 1 USDC to the basket and 5,000 PNTH
  burned (the creator's half of the 1% fee), then 1 USDC streamed to stakers. That is about 790k gas,
  roughly 0.00008 HYPE at Elysium's 0.1 gwei.
- **The public RPC** runs `eth_simulateV1` with events. `debug_traceCall` needs a paid key, and we don't need
  it. Like DELPHI, the client paces requests and backs off on the RPC's rate-limit code `-32017`.
- **An empty round** (no fees, no basket USDC, no boost changes) sends nothing and costs nothing.
- **Fork test, live mode:** 11/11 checks pass (4,999 PNTH burned from a 1M PNTH sell's fees; a staker's
  working balance 5,000,000 → 5,250,010 after 3 days).
- **Service:** keeps its state across a restart; an unreachable RPC logs "round failed" and it carries on;
  live mode refuses a key file others can read; practice mode runs with no key file at all.

## Watch out

- **Stale prices block the basket.** The vault skips any coin whose Ascend price average is older than
  48 hours (fixed in the deployed vault). On thin testnet trading most coins go stale, so the basket buys
  nothing until someone trades them. Micheal's `settle` does that with a 1 USDC trade per coin. The
  keeper reports these skips, but doesn't trade.
- **Micheal currently runs `keep` by hand.** Both running is harmless: the second finds nothing to do.

## Commands

| Command | What it does |
|---|---|
| `npm test` | Unit tests (vitest). They never touch the network: `test/setup.ts` rejects any `fetch` to a non-loopback host. |
| `npm run check` | Typecheck, lint and tests; run before every commit |
