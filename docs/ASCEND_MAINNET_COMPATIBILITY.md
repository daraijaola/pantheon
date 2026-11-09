# Ascend mainnet compatibility audit

## Result: not compatible as-is

Audited against `origin/main` at `51a9c45aab5964e59fcd8cdc8ec28b1322d188fd`,
Elysium chain 99901, pinned block **3120548**, on 2026-11-09.
The published deployment begins at **422319**. This is Ascend's start, not a
PANTHEON deployment block; `network.deployedFrom` remains null.

This branch populates published metadata and adds compatibility regression and
positive-control fork tests. It does **not** port the production contracts or
enable mainnet. A full port changes the fee policy and needs the decisions below.
Existing testnet integrations and deployments are unchanged.

## Sources and limits

Saved documentation: `mainnet-contracts.md`, `abis-and-events.md`,
`integration-guide.md`, `apis-and-bridging.md` under
`/home/ubuntu/notes/mainnet/ascend/`.
Public sources: <https://ascendlaunch.gitbook.io/docs/developers/mainnet-contracts>,
<https://ascendlaunch.gitbook.io/docs/developers/abis-and-events>,
<https://ascendlaunch.gitbook.io/docs/developers/integration-guide>,
<https://ascendlaunch.gitbook.io/docs/developers/apis-and-bridging>.

The linked full ABI at
<https://ascendlaunch.xyz/abis/ascend-v5-99901-422319.json> returns **HTTP 403**
from this environment, including the web-fetch attempt. Its documented SHA-256 is
`195d9572a792070ce236d4b3ee759f06e3d24f6c9d7c3a4912febe818789d5c8`;
the download/hash and a full ABI comparison are therefore **unverified**.
Comparisons use the saved human-readable signatures, standard Uniswap v4 event
signatures, pinned read-only calls, actual launch logs and deployed-contract fork
execution. An undocumented function is not assumed absent just because the guide
omits it: `baseQuote()` and `emaUpdatedAt(bytes32)` both answer on mainnet.

## Exact integration mismatches

| Path and symbol | Existing assumption | Mainnet requirement / evidence |
| --- | --- | --- |
| `script/Deploy.s.sol:103`, `_config` | `launchpad.vault()` returns an Infinity vault | Reverts with empty data on V5. Actual script trace reaches this call after successful `baseQuote()` and `poolManager()` reads, before `startBroadcast` at lines 73–74. Address population alone cannot deploy. |
| `src/covenant/CovenantFactory.sol:85–112`, `_launchToken` / `_handOver` | Seven-field `launch` directly on the hook, followed by `transferCreator(pool, router)` | EscrowFactory uses nine-field params (`fee`, `builderFee` added), a Route, and returns token/pool/escrow. `creator` input must be zero. `poolCreator` is the escrow, not the CovenantRouter. The old launch reverts on the fork; the documented checked factory launch succeeds. |
| `src/covenant/CovenantRouter.sol:83–98`, constructor | Infinity key hash and accepting the pool creator role | Mainnet key hash differs; creator custody stays in CreatorEscrow. The constructor's `WrongPool` guard rejects the v4 pool before creator acceptance. A recipient/escrow-aware factory/router is needed, not replacing the hook address with the factory address. |
| `src/covenant/CovenantRouter.sol:104–123`, `run` | Collect, claim token fees and claim quote fees directly from the hook | V5 fee release runs through escrow `settle()` and `claim(recipient)`. Token fee getter/claim calls revert; on an actual live pool, dummy-sender quote claim and creator handoff calls also revert. `collect(pool)` still answers, so it is not classified as a removed selector. Caught failures can make `run()` succeed while delivering no new fees. |
| `script/Deploy.s.sol:199–207`, fee legs | Sell fees in PNTH burn; buy fees in USDC fund the basket, with a team share of each | All V5 fees, buy and sell, are in the pair asset. The RuleSet controls live, held, support, protocol and buyback amounts before recipient credit. A 15% team leg on recipient proceeds is not 15% of all pool fees; automatic PNTH burn no longer follows from the old token leg. |
| `src/common/AscendSwap.sol:39–73` | Infinity `vault.lock` → `lockAcquired`, six-field PoolKey, settlement through a separate vault | Uniswap v4 uses PoolManager custody/unlock and a five-field key. Alternatively UniversalRouter 2.2.0 uses Permit2 and V4_SWAP actions. The old PoolManager swap selector and key encoding differ. |
| `src/index/IndexVault.sol:63,118–124` | `launchpad.vault()`, Infinity key, PoolManager `getSlot0` | Constructor already fails; key must become v4 and spot reads go to StateView. Direct mainnet `PoolManager.getSlot0` reverts while StateView answers. Preserve the existing EMA freshness/price-band/breaker protection when porting; a quote/slippage floor alone is not an equivalent replacement. |
| `src/index/ConstituentRegistry.sol:165–173`, `_checkOne` | Valid constituent must hash to the Infinity-derived key | Even a valid, mature Ascend v4 coin fails this hash check. Fork control verifies the new pool hashes to the documented v4 key and not the old key. |
| `services/delphi/src/chain.ts:26–49,154–157`, `launchpadAddresses`; `src/ingest.ts:234–244` | Read old custody/treasury getters, then old Launched/Initialize/Swap event topics | `vault()` fails in `Promise.all` before scanning. After fixing addresses, all three event signatures still differ. Launched adds fee and builderFee; v4 Swap drops protocolFee; Initialize carries tickSpacing instead of Infinity parameters/manager geometry. Actual pinned 1000-block head sample contains four V5 launches under the new topic. |
| `services/delphi/src/safety.ts:105–106,506`; `src/kalos.ts:68` | Old Launched topic identifies Ascend launches and their creators | Use the new event and join EscrowLaunched to resolve escrow → recipient/RuleSet. Current `Launched.creator` is an escrow, not a human wallet. Merely adding two event fields would misattribute creator/funding analytics. |

References to `src/ingest.ts`, `src/safety.ts`, `src/kalos.ts` in the last two rows
are relative to `services/delphi/`.

### Selectors and event identities

| Operation | Legacy | Mainnet |
| --- | --- | --- |
| Launch | `launch((string,string,address,uint256,uint256,bytes32,address))` = `0xcd2cfd89` | EscrowFactory `launch((string,string,address,uint256,uint256,bytes32,address,uint24,uint24),(address,address,address,bool))` = `0xc254d9d4` |
| Checked launch | None | `launchChecked((string,string,address,uint256,uint256,bytes32,address,uint24,uint24),(address,address,address,bool),address,int24)` = `0x01c2cec9` |
| PoolManager swap | `swap((address,address,address,address,uint24,bytes32),(bool,int256,uint160),bytes)` = `0xcd0cc1ce` | `swap((address,address,uint24,int24,address),(bool,int256,uint160),bytes)` = `0xf3cd914c` |
| Launched topic | `0xa75ce47c3ff6fc75b5270d713acafcfb8149c5f91a73679d659fa90798ecfab4` | `0xe03d17b1e529b1975da402258d101e5f5240440f266b80122f331f42dea41bd7` |

The v4 key is `(currency0,currency1,fee,tickSpacing,hooks)`, with sorted currencies,
`fee=0x800000`, `tickSpacing=200`, and the launchpad as hooks. UniversalRouter's
single-hop action adds `minHopPriceX36` before `hookData`; omitting that field is
not the 2.2.0 ABI. The passing control test encodes it as zero, quotes through
V4Quoter, uses a 99%-of-quote minimum and exercises `0x10` with `0x06/0x0c/0x0f`.
Those values are test inputs, not a selected production slippage or fee policy.

### Reachability and unaffected paths

* Mainnet profiles currently reject missing required fields, including explorer
  configuration. No claim is made that DELPHI is already running these calls on
  mainnet; the incompatible dispatch is verified in its source and read-only
  probes, conditional on satisfying startup configuration.
* `services/keeper/src/keeper.ts:111–112` calls our `run()` and `rebalance()`, not
  Ascend launch/router directly. Its own ABI can remain if a new adapter preserves
  those entry points, but the current contracts cannot deliver the required fees
  or basket buys. `services/keeper/src/chain.ts:8` consumes the old Run shape.
* `services/indexer/src/chain.ts:6–40` indexes PANTHEON events, not Ascend Launched
  events. There is no direct Ascend ABI mismatch there; keeping own event shapes
  avoids a mandatory indexer port. Changed fee semantics still require accurate
  reporting/copy and freshly deployed contract addresses/state.
* `web/src/components/app/get-app.tsx:23` returns an external acquisition link
  on mainnet. Its Infinity swap helper at lines 35–147 is **testnet-only**, not a
  reachable mainnet buy path. Mainnet's acquisition URL remains unpublished/null;
  no fake URL or testnet helper was substituted. An in-app mainnet trade flow,
  if desired, needs Quoter/Permit2/Router encoding like the fork control.
* `web/src/components/app/covenant-app.tsx:108–116` calls our existing factory
  interface for both profiles. A new factory preserving this API could retain
  the UI dispatch, but its fee/recipient controls and promises must be revised.
* Read-only mainnet calls confirm `baseQuote`, `poolManager`, `poolCreator`,
  `poolLaunchedAt`, `poolTokenIs0`, `emaSqrtPrice`, `emaUpdatedAt`, `quoteConfig`
  and `creatorOwedQuote` still answer. Their presence does not establish unchanged
  custody/economics; the full ABI remains unavailable.

## Reproduction

No deployer key is used. No command below broadcasts; all contract writes in tests
exist only inside the local fork. Start with a free loopback port:

```sh
anvil --fork-url https://rpc.elysium.kinetiq.xyz --fork-block-number 3120548 \
  --host 127.0.0.1 --port 19545
```

In another shell, simulate the actual deployment with dummy roles:

```sh
DEPLOYER_KEY=0 DEPLOYER_ADDRESS=0x0000000000000000000000000000000000001234 \
EXPECTED_NONCE=0 TEAM_BPS=1500 WRITE_DEPLOYMENT=false \
TEAM=0x0000000000000000000000000000000000001234 \
CURATOR=0x0000000000000000000000000000000000001234 \
GUARDIAN=0x0000000000000000000000000000000000001234 \
ATTESTOR=0x0000000000000000000000000000000000001234 \
DEPLOYMENT_FILE=deployments/elysium-mainnet.json \
LAUNCHPAD=0xe0dEF4221b9840a610D4e7d55812a79A6431a8eC \
USDC=0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65 \
BURN_SINK=0x9F0b0e3B362937b07Cd1E869b50687961e0c7741 \
forge script script/Deploy.s.sol:Deploy --rpc-url http://127.0.0.1:19545 \
  --sender 0x0000000000000000000000000000000000001234 -vvvv

ASCEND_MAINNET_FORK_RPC=http://127.0.0.1:19545 \
  forge test --match-path test/fork/AscendMainnetCompatibility.t.sol -vvv
forge test --match-path test/unit/Deploy.t.sol -vv
node --test web/src/lib/chain/network-profile.test.ts
(cd services/indexer && npm test -- test/network.test.ts)
```

The fork tests are explicitly skipped without `ASCEND_MAINNET_FORK_RPC`. The
legacy `script/dev/prove-mainnet.mjs` is still a **mock** proof, on a separate
nonforked Anvil at port 18545/chain 99901. Its fixture now isolates the missing
launchpad input and installs mock code at populated external addresses for its
preflight checks; a pass is not evidence of V5 compatibility.

### Observed output

Actual `Deploy.s.sol` simulation on the mainnet fork:

```text
Compiler run successful!
Error: Failed to decode return value: 0x
    ├─ [775] 0xe0dEF4221b9840a610D4e7d55812a79A6431a8eC::baseQuote() [staticcall]
    │   └─ ← [Return] 0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65
    ├─ [929] 0xe0dEF4221b9840a610D4e7d55812a79A6431a8eC::poolManager() [staticcall]
    │   └─ ← [Return] 0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1
    ├─ [1037] 0xe0dEF4221b9840a610D4e7d55812a79A6431a8eC::vault() [staticcall]
    │   └─ ← [Revert] EvmError: Revert
Error: script failed: EvmError: Revert
```

Compatibility regressions and positive controls:

```text
[PASS] test_currentDeployRejectsMainnetVaultAPI() (gas: 12393879)
[PASS] test_documentedV220RouterQuoteAndBuy() (gas: 5917884)
[PASS] test_escrowLaunchWorksButLegacyKeyAndLaunchDoNot() (gas: 5142863)
Ran 1 test suite in 10.49s (10.49s CPU time): 3 tests passed, 0 failed, 0 skipped (3 total tests)
```

The original deployment unit test initially exposed its dependence on the old
null canonical manifest:
`LAUNCHPAD has no code != missing LAUNCHPAD / manifest.launchpad`.
It now uses an isolated empty manifest fixture; its missing-input assertion was
not weakened. Final guard run after the fixture/publication updates:

```text
[PASS] test_mainnetConfigAndGuards() (gas: 55820374)
[PASS] test_currentDeployRejectsMainnetVaultAPI() (gas: 12393905)
Ran 2 test suites in 17.10ms (27.15ms CPU time): 2 tests passed, 0 failed, 0 skipped (2 total tests)
```

Final profile tests:

```text
ℹ tests 6
ℹ pass 6
ℹ fail 0
 Test Files  1 passed (1)
      Tests  22 passed (22)
```

Legacy mock proof, **not** mainnet compatibility:

```text
PASS full chain-99901 deployment simulation, creator handoff and nonce-predicted vault
PASS manifest contract fields written; network block preserved exactly
PASS no transactions broadcast; Anvil deployer nonce remains 0; canonical manifest unchanged
```

Evidence logs and read-only probe scripts are in
`/home/ubuntu/notes/mainnet/ascend/`: `fork-deploy.log`, `fork-compat.log`,
`final-guards.log`, `probe.log`, `escrow-probe.log`,
`web-profile-tests-final.log`, `backend-profile-tests-final.log`, and
`legacy-mock-proof.log`.
Foundry's cold-cache warnings were checked against the loaded repository config
and writable cache. Explorer trace lookup also warns `etherscan config not found`
and `chain not supported chain=99901`; no explorer was invented to suppress them.
Node's direct web test invocation warns `MODULE_TYPELESS_PACKAGE_JSON` because
the existing web package does not declare a module type. No shared package/build
configuration was changed to silence these diagnostics.

## Manifest scope and remaining nulls

All 29 unique addresses in the saved mainnet contract document are copied exactly,
including the governance Safe, trading infrastructure, factories, RuleSet, fee
custody destinations and KNTQ. Existing public consumers retain the root launchpad,
USDC, burnSink and `external.ascendRouter` paths. Newly documented addresses are
under `network.external.ascend`; Multicall3 and WHYPE use their existing paths.
The public RPC was supplied and chain-checked. `ascendFromBlock=422319`.

Still null:

* All eight undeployed PANTHEON fields: `constituentRegistry`, `covenantFactory`,
  `indexVault`, `passportRegistry`, `pnth`, `pnthPool`, `pnthRouter`, `staking`.
* `network.deployedFrom` (PANTHEON, not Ascend), `explorerUrl`, `explorerApi`,
  `archiveRpc`, `creationExplorer`, `acquireUrl`.
* Every existing Kalos field (`api`, `factory`, `factoryBlock`, `positionManager`,
  `whype`, `contracts`, plus all five `pinned` fields).
* Every existing PerpMe field (`launchFactory`, `poolFactory`, `positionManager`,
  `router`, `quoter`, `whype`, `fromBlock`, `locker`, `coinDeployer`, `multicall3`,
  `oldLaunchFactory`, `oldLocker`, `api`, `indexer`).
* Network-scoped derived analytics configuration: `knownHubs`, `baseTokens`,
  `perpmeQuotes`, `knownContracts`, `knownAddresses`, `genericAddresses`. These
  are not blindly copied from testnet or inferred from a partial address list.

## Required decisions before a production-code port

1. Since all V5 proceeds are quote-only, should PNTH distribute recipient credit
   **15% team / 85% basket with no automatic PNTH burn**, or fund a USDC buyback
   and burn leg? If the latter, specify its share. Existing token-side burn and
   quote-side index policies cannot be preserved merely by changing an address.
2. Choose PNTH's creator fee (1%–10%, immutable at launch) and whether it opts into
   community takeovers. The fork's 2% and `cto=false` are test choices only.
3. Obtain the published full ABI file so escrow recipient handoff, claims, held
   fees and RuleSet behavior can be implemented/reviewed against the complete
   interface, rather than inventing an undocumented handoff API.

After those decisions, split the port into (a) escrow-aware factory/router and
fee policy, (b) v4 key/state/swap adapter and registry validation with existing
price protections, and (c) escrow-aware DELPHI events/creator attribution and web
fee-policy copy. Keep testnet on the old adapter; do not replace the vendored
Infinity interface globally. Re-prove atomic deployment, creator/recipient
custody, nonce prediction, fee delivery, buy/sell swaps and event attribution on
the real mainnet fork before enabling any mainnet deployment.
