# Offline verdict goldens

Run `npm test` at the package's default timeout. `test/golden-verdicts.test.ts` invokes the
scanner's real `analyze()` / `verdictOf()` path, all three exported detectors, balances and
round-trip matching. No RPC, API key, running feed server or local database is required.
The tests replace `fetch` with a throwing spy during regression evaluation.

## Evidence, not artificial detector scenarios

- `cache.json.gz` contains **decoded detector inputs**, not old verdict reports: original
  coin identities, every selected trade and transfer, funding-derived links with transaction
  evidence, infrastructure classification, roles, funding completeness and network. BigInts,
  Maps and Sets have explicit JSON tags. Inflation is lossless; no trade is downsampled and
  no transfer is replaced with an invented balance. Infrastructure is reduced to addresses
  encountered by each case; liquidity/safety/API payloads that the detectors do not read are omitted.
- Source: the existing read-only local copy of the server's `delphi.db` plus WAL, copied
  on Nov 6. All event reads were bounded to the Nov 4 scan's head **22738575**. The comparison
  snapshot is `generatedAt=2026-11-04T00:23:23.405Z`, testnet **99801**, `delphi-v0.5`.
  Cached lookup/classification/funding metadata was captured later: this is a reconstruction,
  not a claim that the entire cache is a transactionally pinned Nov 4 snapshot. Each case
  retains the old report's verdict separately as `historicalVerdict` for comparison.
  Cross-coin hub/role context was reconstructed from cached senders/funders; uncached
  launchpad getter-derived EOA treasuries are not inferred. Consequently historical link
  and holder counts need not match the old reports. The approved counts describe these
  explicit inputs, not a byte-for-byte replay of the complete historical collector run.
- The additional cases prioritize every historical FLAG/WATCH, CLEAN cases with at most
  1,000 trades, and selected insufficient-data coins. The full 38 CLEAN reports contain
  **598,514 trades**; the large omitted histories are not substituted with synthetic cases.
- Existing checked-in encoded logs are also replayed through the real decoders/assemblers:
  `live-trades.json`, `kalos/ta.json`, `kalos/elant.json`, `kalos/sign.json`,
  `perpme/coin.json`. Those fixtures have no funding observations: their funding is marked
  unknown, **not** an empty-but-complete history. `sign.json` records only two KALOS trades;
  it is not the Nov 4 222,808-trade KALOS report. The first-mint sender supplies creator
  context; supply 1e27 is recorded in that snapshot's KALOS liquidity report.
- `round-1.json` is a ranking/report, not raw detector input. Safety simulations, deployment
  name lists, and intentionally changed restriction/sell fixtures are not verdict goldens.
  Synthetic fairness/precedence cases remain explicitly labeled **scenarios** in the test.

For cache cases the assemblers and graph functions ran during capture; their decoded outputs
are frozen inputs to the detectors. These cases protect detector/report behavior, not future
changes to collectors or graph reconstruction. The existing encoded-log cases exercise their
decoder/assembler and direct-link paths on every run. No detector or rules changes are part
of this test addition.

### Coverage and size

There are **43 cases / 42 distinct tokens**: 38 cache reconstructions and five existing
encoded-log cases (one token has both a complete and a partial-history case).
All **12 FLAG + 3 WATCH** Nov 4 coins are included; all 38 reconstructed verdicts match
their historical verdicts. **19 of 38 CLEAN** coins are included without downsampling.
KALOS is covered only by its explicitly partial recorded two-trade fixture.

| Venue | FLAG | WATCH | CLEAN | NOT_ENOUGH_DATA | Cases |
| --- | ---: | ---: | ---: | ---: | ---: |
| Ascend | 12 | 2 | 11 | 3 | 28 |
| Kalos | 0 | 1 | 2 | 4 | 7 |
| PerpMe | 0 | 0 | 6 | 2 | 8 |
| Total | 12 | 3 | 19 | 9 | 43 |

The cache is **3,046,662 bytes gzip**, **19,355,379 bytes inflated**. Approved measurements
are 54,075 bytes and the ledger 88 bytes. Reused encoded raw fixtures total 135,088 bytes;
total evidence/baseline bytes are **3,235,913** (excluding this README and TypeScript).

## Approval and deliberate re-baselining

`delphi-v0.5.json` records each coin's verdict, all detector sufficiency/severity/metrics/notes,
report statistics, early-buy share/count, wallet-held and largest-holder supply shares,
matched round-trip share/count and group count. Counts and integer values are exact;
noninteger numbers tolerate **1e-9 absolute**, much smaller than the detectors' 0.01% precision.
The input bytes are hashed, and `ledger.json` pins every approved baseline's SHA-256.

On a change, the test prints **every changed case**, including token ID, changed verdict,
checks and numbers, plus the approval command. Never use snapshot-update flags or edit an
existing version/ledger hash to silence a regression. Review the evidence first. Then:

1. Bump `RULES.version` in `src/config.ts` for a reviewed testnet rules change (and the
   mainnet version too when the change affects that profile).
2. Run `node test/golden/rebaseline.ts --accept-rules <new-version> --reason "reviewed rationale"`.
3. Review the new JSON diff; retain all prior version files and ledger entries unchanged.
4. Run `npm run typecheck && npm run lint && npm test`, commit the rules change and its
   new approval together. The command refuses to overwrite any existing rules version.

The initial v0.5 approval records current behavior, **not proof that every alert is correct**.
KPIX's historical WATCH deserves review: its concentration check attributes **33.86%** of
wallet-held circulating tokens to **217 wallets linked to the creator**, excluding the creator's
own balance. The report also says **28.64%** fast round-trip volume involves Kalos's factory
owner, `0x9332e35e87eac40a0810813a7a12c458e8043184`; that wash activity is contextual,
not the WATCH trigger. A legitimate team distribution could resemble linked concentration,
but the owner label alone does not disprove the separate 217-wallet finding.
The bounded cache reconstruction also yields WATCH, at **32.34% / 212 linked wallets /
2,950 holders**, with 3,595 links versus the historical report's 3,705; its contextual team
wash note is **28.25% / 169 wallets**. These numeric differences are explicitly not claimed
to be detector regressions: the historical collector's entire cross-coin context is not pinned.
The twelve historical FLAGs all have symbol SNPTEST and linked early buys of **16.8–23.78%**;
that name is not proof of malicious intent. Keep these observations separate from a validated
malicious-token ground truth. No alert was weakened or detector logic changed here.
