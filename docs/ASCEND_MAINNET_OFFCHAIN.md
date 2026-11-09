# Ascend V5 off-chain integration

Chain 99901 selects the V5 path. Chain 99801 retains its existing contracts,
selectors, inline swapper and state paths. No deployment or production switch is
part of this change.

## Keeper and indexer

Mainnet simulates these calls together, in order:

1. CreatorSeat `harvest()`.
2. CreatorSeat `claim(0, false)` (team's quote-side slot).
3. IndexVaultV5 `claimFees()` (harvests and pulls the basket slot).
4. IndexVaultV5 `rebalance(k)`.

Only useful simulated operations are sent in live mode. Every chosen mainnet
operation is simulated again immediately before sending; another crank emptying
a claim therefore suppresses that transaction. Empty fee calls have no narrative
log lines. Testnet still calls `CovenantRouter.run()` then `rebalance(k)`.
V5 breaker resets are useful even without a purchase: persisting that one-run
pause allows a later rebalance to recover. Testnet selection is unchanged.

The indexer records positive vault `FeesClaimed` as basket receipts and quote-side
slot-0 `PayeeClaimed` as team payments. Seat slot 1 is deliberately not counted
again: the vault receipt already represents it. No mainnet Covenant burn/run is
invented. The old manual fork/probe tools explicitly reject mainnet because they
depend on testnet minting and the Infinity pool key.

## Ascend readers and buying

DELPHI selects V5 `Launched`, v4 `Initialize`/`Swap`, EscrowFactory
`EscrowLaunched` and Launchpad `HookSwap`. The matching escrow route supplies the
actual developer and identifies the escrow/seat as infrastructure. Safety reads
use the same mainnet launch and custody path. Unpublished Kalos/PerpMe venues
are disabled with explicit coverage notes, not substituted with testnet values.

For a native Ascend trade, the caller's gross token movements are
`PoolManager Swap - HookSwap`. The reader matches pool, transaction and sender,
using the nearest preceding unused AMM event. A hook-only fill uses zero AMM
delta. A native AMM event missing its hook event fails closed rather than silently
understating the trade. Outside pools retain their AMM records.

The mainnet Buy button **deep-links** to
`https://app.ascendlaunch.xyz/tokens/<PNTH>`. This intentionally delegates native
quoting and UniversalRouter execution to Ascend; PANTHEON does not add a native
mainnet swapper or call the legacy router/quoter. No off-chain reader calls the
Infinity vault or PoolManager's old slot0 API. The existing on-chain V5 vault uses
StateView. Mainnet Covenant launch controls are disabled.

## Post-deployment manifest import (read-only RPC)

PANTHEON addresses remain null until real deployment. Existing `indexVault` and
`constituentRegistry` keys hold the V5 addresses on mainnet; `creatorSeat` and
`creatorEscrow` are new. `pnthPool` is the bytes32 v4 pool ID.

After an authorized deployment, from the repository root with web dependencies
installed:

```sh
node script/import-mainnet-deployment.mjs \
  broadcast/DeployMainnet.s.sol/99901/run-latest.json
```

An optional second argument selects an alternate manifest file. The default RPC
is the manifest's public mainnet RPC; `ELYSIUM_RPC` may select a mainnet provider.
Never select a local fork for a release import. Keep the legacy Solidity
`MAINNET_WRITE_DEPLOYMENT` option **false**: fork/simulation predictions are not
release manifests. Use this receipt importer instead.

The importer requires chain 99901, no pending transactions, successful receipts
for every transaction, matching live RPC receipts/logs, the expected deployer,
four named contract creations, trusted launch/escrow/seat events, the fixed
15/85 allocation and 15000-pip fee, the v4 pool ID and deployed code. It rejects
dry-run artifacts before querying RPC or writing anything, and refuses to
replace different deployed addresses. It fills the eight PANTHEON addresses/ID,
deployment block and token acquisition link. Unpublished external metadata stays
null. No RPC mutation or transaction submission method is used.

## Checks and remaining launch gates

Final checks for this change:

- Keeper: typecheck, lint, **36 tests passed**.
- Indexer: typecheck, lint, **48 tests passed**.
- DELPHI/feed/X: typecheck, lint, **625 tests passed** (including selected-mainnet
  subprocess coverage of event, custody and safety paths).
- Trials: typecheck, lint, **34 tests passed**.
- Uploaded: typecheck, lint, **378 tests passed**.
- Web: typecheck, lint, **117 unit tests passed**; production build plus **6
  Chromium desktop/mobile Get/network tests passed** using offline fixtures.
- Importer: **3 mocked tests passed**; the existing zero-receipt deployment
  simulation is rejected with `complete mined receipts required; dry runs and
  pending broadcasts are rejected`.
- Passport typecheck/lint pass, but its suite has a missing
  `docs/passport-fixtures/` directory and an on-chain unlink assertion
  (`expected +0 to be 1`, `test/stack.chain.test.ts:101`). Both failures reproduce
  in a detached worktree at parent `a2f9cc2`; they were not changed here.

Same-day launch still needs an actual funded, authorized deployment, receipt
import, and isolated mainnet service/web releases. Mainnet explorer URLs/API,
creation explorer and archive RPC must be supplied/validated; profiles continue
to fail closed where those are required. Kalos/PerpMe remain unavailable until
published. Configure a separately funded mainnet keeper, SIWE origin/chain,
fresh chain-specific state and acquisition funding; do not repoint testnet
services or timers. Complete a live mainnet smoke test after deployment.
The basket's 24-hour proposal delay still applies; until constituents activate,
the empty-list USDC-to-stakers fallback is available.

No public transactions were sent. The mainnet UI, real fee-race behavior and full
mainnet refresh are not live-verified by these mocked/offline tests. Evidence
logs are under `/home/ubuntu/notes/mainnet/ascend/offchain-*`.

Sources: Ascend's official
[ABI/events](https://ascendlaunch.gitbook.io/docs/developers/abis-and-events),
[integration guide](https://ascendlaunch.gitbook.io/docs/developers/integration-guide)
and [mainnet contracts](https://ascendlaunch.gitbook.io/docs/developers/mainnet-contracts).
The official integration guide explicitly distinguishes HookSwap's hook delta
from PoolManager Swap's AMM delta. The subtraction is also covered with the
public-RPC event pair: AMM quote `-74250000`, hook quote `750000`, gross quote
`-75000000` base units. Ascend's app bundle exposes `/tokens/<address>`.
