# Slither review (2026-10-14)

[Slither](https://github.com/crytic/slither) 0.11 ran over every contract in `src/` (libraries, tests and scripts filtered out) with all 102 detectors. It reported 69 notes: 1 high, 23 medium, 35 low and 10 informational. We read each one. None is a real problem in the deployed contracts. The reasoning is below so anyone can check it.

## High (1)

| Note | Where | Verdict |
|---|---|---|
| `uninitialized-state`: `_lists` is never initialized | `ConstituentRegistry` | False alarm. `propose` writes it through a storage reference (`Constituent[] storage stored = _lists[id]; stored.push(...)`), which Slither does not follow. Proposal 0 on the live testnet reads back correctly. |

## Medium (23)

| Note | Count | Verdict |
|---|---|---|
| `incorrect-equality` (`== 0`, tier `== 1/2/3`) | 9 | Intended. These compare our own values (a tier, an empty budget or stake), not a balance someone could round to. Sending tokens to the vault only makes the next run buy more. |
| `uninitialized-local` | 6 | Intended: counters and flags that start at zero or false. |
| `reentrancy-no-eth` | 3 | Safe. `CovenantRouter.run` and `IndexVault.rebalance` are `nonReentrant`, and `deliverLeg` can only be called by the router itself. The outside calls go to Ascend's launchpad and vault, to our staking contract, and to plain ERC-20 transfers. |
| `unused-return` | 3 | Intended. `vault.settle()` follows a transfer of the exact amount owed, `collect` is measured through balances afterwards, and only the price is needed from `getSlot0`. |
| `divide-before-multiply` | 1 | Accepted. `workingOf` rounds down twice, which loses less than one unit (10^-18 of a token) of staking weight. A 1,000-run fuzz test shows stakers are never paid more than the stream received. |
| `write-after-write` | 1 | Intended: `_inLock` is a transient flag set for the length of one swap. |

## Low (35) and informational (10)

- **Loops with outside calls** (11): each is bounded: at most 10 basket coins, 6 jobs per side, and 24 reward tokens.
- **Use of `block.timestamp`** (14): needed for the reward streams, the 24-hour wait, the 3-day unlock and Passport expiry. Minutes of drift do not matter at those scales.
- **Missing zero-address checks** (6): on immutable constructor arguments. They are set once at deploy, and the deployed values were checked against the explorer.
- **Benign reentrancy and event ordering** (4), **naming, assembly, complexity and the like** (10): style only.

To run it again: `slither . --foundry-compile-all --filter-paths "lib/|test/|script/"`.
