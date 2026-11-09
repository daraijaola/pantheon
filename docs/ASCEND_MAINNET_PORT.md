# PNTH mainnet SeatFactory / Uniswap v4 port

## Scope and safety

Elysium 99901; private Anvil fork at block **3120548**. No public-network
transactions and no private-key use. The deployment script never reads a key.
`Deploy.s.sol`, Covenant contracts, testnet swaps and staking remain unchanged.
The only shared Solidity edit factors registry pool-key validation into a virtual
method: all age, governance, weight, cap, duplicate and exclusion rules stay in
the original implementation.

This is a **contract deployment / basket port**, not a production mainnet rollout.
The canonical manifest retains null PANTHEON addresses. Mainnet web acquisition,
DELPHI's V5 ingestion and keeper/indexer fee-accounting changes are still separate
work, as identified in the historical compatibility audit. In particular, do not
put the seat into the legacy `pnthRouter` field: it is not a CovenantRouter and
does not implement its `run()` ABI/events. A mainnet crank should call
`IndexVaultV5.claimFees()`, `seat.claim(0,false)` and `IndexVaultV5.rebalance(k)`.

## Design

- `AscendV5.sol`: narrowly scoped interfaces matching the full published ABI;
  five-field sorted v4 pool key, dynamic fee `0x800000`, tick spacing `200`,
  Ascend Launchpad as hook.
- `AscendSwapV5`: direct PoolManager `unlock` / `swap` / `sync` / `settle` /
  `take`, empty hook data. Both packed signed deltas are decoded; spend cannot
  exceed exact input. Only the PoolManager may enter an outstanding callback.
  No router, Permit2, Infinity vault or new token approvals are needed for swaps.
- `ConstituentRegistryV5`: inherits the existing registry, overriding **only**
  the pool-key hash. Launch age comes from the real mainnet hook's
  `poolLaunchedAt(bytes32)`, with the same 72-hour minimum and 24-hour proposal
  delay, curator/guardian, five-or-more 20%-capped coins and per-run caps.
- `IndexVaultV5`: ownerless, non-upgradeable, no withdraw/rescue/admin endpoint.
  Uses Launchpad EMA/freshness and StateView `getSlot0`. Keeps the existing
  directional adverse-price limit (2.5% sqrt-price displacement, approximately
  5% price), EMA breaker, cursor/budget/caps, and streams bought coins to
  `PantheonStaking.notifyReward`. With no list it streams USDC. Failed streams
  retain assets for permissionless retry and clear staking allowance.
- `claimFees()` verifies this vault is the seat's fixed 8500-bps slot 1,
  harvests, then claims that slot's **USDC**. Anyone may invoke it; no destination
  is supplied by the caller. Empty/repeated claims are harmless.
- `DeployMainnet.s.sol`: separate, keyless, checked mainnet deployment. Deploys
  Passport, registry, staking, vault, then invokes SeatFactory's checked launch
  in one recorded broadcast sequence. Optional USDC approval is after the vault
  deployment so it cannot disturb its nonce prediction. Approval is exact and
  reset after the optional dev buy. Existing standing allowance must first be
  cleared. No Covenant contracts are needed or deployed.

The script prevalidates chain, all infrastructure code, binding getters, current
RuleSet, allowed quote/start tick, paused status, expected nonce, address/salt
availability, integer bounds, nonzero limits, dev-buy funding/minimum output and
optional output-manifest chain ID before `startBroadcast`. `launchChecked` also
protects against a RuleSet/start-tick change between validation and execution.
The entire sequence must still be simulated before any future real deployment;
it is multiple transactions, not an atomic deployment factory transaction.

## Payout facts and corrected assumptions

Verified against real code on the private fork:

1. Launchpad's pool creator is **CreatorEscrow**, whose recipient is the returned
   **CreatorSeatV5**, not the team or vault directly.
2. `seat.harvest()` settles the escrow, claims its recipient allocation into the
   seat and accounts payee entitlements. It does not push USDC into both payees.
3. `seat.claim(0,false)` pays the team; `seat.claim(1,false)` pays the vault.
   These are permissionless and funds go to stored payees, never to the crank.
   The vault helper performs harvest + its own claim. Ascend's crank may also
   call these; PANTHEON need not depend on it for basket receipts.
4. The **15000-pip setting is the total trading fee**, not a guarantee of 1.5%
   paid to the creator. On a 100-USDC test buy below graduation, 0.150000 USDC
   is released, 0.700000 USDC held and 0.650000 USDC protocol allocation.
   Released receipts are **0.022500 team / 0.127500 vault**. The 15/85 split
   applies to released creator proceeds, not gross trading fees.
5. Held fees require the moving average above the graduation line for one hour,
   within 14 days. The test reaches the threshold with real trades, starts the
   hold, proves immediate graduation fails, advances one hour, performs another
   real trade and graduates. No EMA, hook, pool, escrow or market-cap storage is
   mocked. Held allocation becomes zero and released receipts preserve 15/85.
6. SeatFactory hardcodes **CTO opt-in false**, and namespaces `p.salt` as
   `keccak256(abi.encode(msg.sender,p.salt))` before forwarding to EscrowFactory.
   Both were verified with `debug_traceCall` and successful checked predictions.
   They were not apparent in the abbreviated launch signature.
7. Ascend seats have their own payee migration/sunset machinery; PANTHEON's vault
   cannot authorize migrating its slot. Permissionless claims should be cranked
   regularly rather than assuming the external seat has no liveness policy.
8. There is no PANTHEON token-fee burn leg on this path. `holderBps*`,
   `buybackBps`, `builderFee` and `builder` are zero, as requested.

## Exact launch and constructor parameters

`DeployMainnet` fixes deployer, attestor, curator, guardian and team to
`0xdf6aA48D464d9BC2443096f03cba4Fa750d3bdC6`.

```text
SeatFactoryV5 = 0xBDB8d64452191041C4dAA3AD0f64bE4380FEA0b1
Launchpad     = 0xe0dEF4221b9840a610D4e7d55812a79A6431a8eC
EscrowFactory = 0x63f6a8A8d0257c0363251a50cdE8A8b1046e4d19
PoolManager   = 0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1
StateView     = 0x27eD73aE0652fdCf71d6793412A7525f32bE9dfE

LaunchParams:
  name = "PANTHEON"
  symbol = "PNTH"
  quote = 0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65
  devBuyQuote = MAINNET_DEV_BUY_QUOTE (USDC base units, default 0)
  minDevOut = MAINNET_MIN_DEV_OUT (PNTH base units, default 0)
  salt = MAINNET_PNTH_SALT (required nonzero bytes32)
  creator = address(0)
  fee = 15000
  builderFee = 0

SeatConfig:
  holderBpsQuote = 0
  holderBpsToken = 0
  buybackBps = 0
  burnBought = false (unused with zero buyback)
  devBuyTo = team
  payees = [team, CREATE(team, expectedNonce + 3)]
  bps = [1500, 8500]

launchChecked trailing arguments:
  seatSalt = MAINNET_SEAT_SALT (required nonzero bytes32)
  builder = address(0)
  expectedRuleSet = MAINNET_EXPECTED_RULESET (required address)
  expectedStartTick = MAINNET_EXPECTED_START_TICK (required signed int24)

MAINNET_EXPECTED_NONCE = required deployer nonce
MAINNET_MAX_RUN_CAP = 1000000000 USDC base units (1000 USDC), default
MAINNET_MAX_STALE = 172800 seconds, default
```

Nonzero dev buy requires a nonzero minimum output and sufficient team USDC;
zero dev buy requires zero minimum output. The optional dev-buy fork test uses
1 USDC and min output 1 base unit **only as a test**, not recommended slippage
for a future launch. Production must select a meaningful minimum from simulation.

Predictions use the supplied expected nonce: Passport `N`, registry `N+1`, staking
`N+2`, vault `N+3`; seat is `SeatFactory.predict(team,c,seatSalt)`; escrow/token
come from `EscrowFactory.predict(SeatFactory, namespacedP,
Route(seat,team,address(0),false))`. Launch results must match all predictions.

## Reproduction (local only)

```sh
anvil --fork-url https://rpc.elysium.kinetiq.xyz \
  --fork-block-number 3120548 --hardfork cancun --no-storage-caching \
  --host 127.0.0.1 --port 19545
# Mine one local block if eth_call reports "Excess blob gas not set".
cast rpc --rpc-url http://127.0.0.1:19545 evm_mine

MAINNET_FORK_RPC=http://127.0.0.1:19545 \
ASCEND_MAINNET_FORK_RPC=http://127.0.0.1:19545 forge test -vv
```

New tests require an explicit loopback-only `MAINNET_FORK_RPC`; without it they
are skipped, not silently treated as fork coverage. The full verified invocation
enables both new and historical mainnet suites, and existing testnet forks run
through the unchanged `elysium` Foundry RPC profile.

The basket has one real pre-fork USDC coin:
`0x35F64EAaEB793D51e8328D59b9c5AB29b42d8914`, pool
`0xf9bb5f186363963e1593e49efe06b0e2c683aa157c8367bd0c59070acef329a8`,
mainnet `Launched` block 3120163. Four other constituents are launched only in
private fork state to satisfy the unchanged five-at-20% list rule. The age test
proves this real coin becomes valid exactly at its mainnet launch timestamp +
72h, **before the registry itself is 72h old**. The end-to-end test buys all five,
streams them and lets a PNTH staker claim the real existing coin.

## Sources and evidence

### Verified results

```text
Ran 14 tests for test/fork/AscendMainnetPort.t.sol:AscendMainnetPortTest
Suite result: ok. 14 passed; 0 failed; 0 skipped
Ran 10 test suites in 97.63s (163.00s CPU time): 57 tests passed, 0 failed, 0 skipped (57 total tests)
```

All four fork suites (new port, historical mainnet controls, Ascend testnet PoC,
testnet PANTHEON loop) were enabled, along with every existing unit/fuzz suite.
The new fork suite additionally covers stale/band/breaker skips, callback access,
empty/idempotent claims, refused-stream retention, governance/veto, preflight
failures, integer bounds and an optional dev buy. Nothing is written to the
canonical deployment manifest by the tests or gas simulation.

The final keyless `forge script` simulation used the same pinned-fork Anvil,
expected nonce **0**, RuleSet `0xA9a627729D04576D8f79E3279bd17429C7794712`,
expected start tick **-400600**, zero dev buy and these explicit simulation salts:

```text
MAINNET_PNTH_SALT=0x031cb6aa3cfdf62e1a6407dfbc33017fd4d5fb4a6a8195ea204aa29cd32f656d
MAINNET_SEAT_SALT=0xe20b506f413203d74d5c64e61ae48f5e6cb3c59ee46751a207165cd760a12027
```

They are respectively `keccak256("pantheon-port-gas-pnth")` and
`keccak256("pantheon-port-gas-seat")`, not an instruction to use them on mainnet.
With `--gas-estimate-multiplier 100`, no `--broadcast`, and manifest writing off:

| Recorded transaction | Estimated gas |
| --- | ---: |
| Passport CREATE | 1,154,582 |
| Registry CREATE | 1,342,669 |
| Staking CREATE | 2,357,633 |
| Vault CREATE | 1,815,072 |
| SeatFactory launchChecked | 10,479,654 |
| **Total** | **17,149,610** |

```text
Script ran successfully.
Estimated total gas used for script: 17149610
SIMULATION COMPLETE. To broadcast these transactions, add --broadcast and wallet configuration(s) to the previous command. See forge script --help for more.
```

The deployer nonce on Anvil remained **0 before and after**; the dry-run artifact
contains five transactions and **zero receipts**. No deployment was submitted.
Local-only account funding was used for gas simulation. This is a gas-unit
estimate without the usual 30% Forge multiplier, not a live native-token funding
quote. Optional dev buy adds approval/reset calls and swap execution costs.

Runtime sizes are 7,994 bytes (vault), 5,947 (registry), 10,553 (staking) and
5,071 (Passport), below EIP-170. Forge formatting and compilation succeeded.
Foundry 1.9's simulation still emits debug-source parser warnings, plus
`etherscan config not found` / `chain not supported ... 99901`; setting `--ast`
does not eliminate all parser warnings. These did not prevent EVM simulation or
gas estimation. Explorer verification is not configured or claimed.

Official ABI: <https://ascendlaunch.xyz/abis/ascend-v5-99901-422319.json>.
Retrieved with Chrome CDP after curl returned 403. SHA-256 verified:
`195d9572a792070ce236d4b3ee759f06e3d24f6c9d7c3a4912febe818789d5c8`.

Official documentation:
- <https://ascendlaunch.gitbook.io/docs/developers/integration-guide>
- <https://ascendlaunch.gitbook.io/docs/developers/abis-and-events>
- <https://ascendlaunch.gitbook.io/docs/launching-on-ascend>
- <https://ascendlaunch.gitbook.io/docs/fees-and-revenue/trading-and-creator-fees>
- <https://ascendlaunch.gitbook.io/docs/fees-and-revenue/creator-fee-release-and-takeovers>

Persistent local evidence directory: `/home/ubuntu/notes/mainnet/ascend/`.
`port-all-tests.log`, `port-build.log`, `port-deploy-simulation.log`,
`seat-trace.json`, `full-abi.json`; source-controlled tests contain all fork
assertions. The fork may fund accounts through cheatcodes / local Anvil state
methods; no public-chain writes or token minting permissions are implied.
