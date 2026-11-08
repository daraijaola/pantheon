# Backend deployment selection

Services share `network.mts` and the canonical manifests in `../deployments/`.
Ship both with every isolated service release. `NETWORK=testnet|mainnet` or
`DEPLOYMENT=elysium-testnet|elysium-mainnet` selects the profile; unset selection
keeps testnet. Existing canonical `DEPLOYMENT_FILE` paths also select their
profile. Conflicting selectors/files and mismatching deployment chain IDs fail.

Required unknown fields produce one `Network profile …: missing required fields`
error, naming manifest paths. RPC/explorer/start-block environment overrides
remain supported; they never cause a testnet fallback. Mainnet RPC checks on the
indexer, keeper, Passport, Trials, Uploaded, DELPHI collection and optional
feed smart-wallet verifier reject a wrong chain.
Keep private provider credentials in server-side `ELYSIUM_RPC`/`DELPHI_HEAVY_RPC`,
never in committed manifests.

## Consumer requirements

All consumers need valid chain metadata, RPC, explorer and Multicall3.

| Consumer | Additional strict dependencies | Optional / disabled when absent |
|---|---|---|
| Indexer | Basket contracts, PNTH, USDC, burn sink, deployment start | None |
| Keeper | Basket contracts, Passport registry, deployment start; explicit mainnet `PASSPORT_API` | None; practice mode remains default |
| Passport | Passport registry | Relayer remains optional; HyperCore/HyperEVM readers retain their independent network |
| Trials | Passport registry and staking | No rounds is an empty vote list; cross-chain rounds are rejected |
| Uploaded | PNTH, USDC, staking, Passport, archive RPC; explicit mainnet `INDEXER_URL` and `TRIALS_URL` | Trusted address labels |
| DELPHI refresh/explainer/X | Ascend, current Kalos/PerpMe contracts/APIs/start blocks, archive/explorer endpoints, quote/base-token sets, burn sink | Legacy PerpMe addresses and trusted hub/identity maps; absence logged, no testnet labels substituted |
| DELPHI feed/publisher | Network metadata, isolated feed/output paths | No dependency on scan/venue contract configuration; smart-wallet disputes remain opt-in |

The X entry point loads scan configuration for live refreshes as well as its own
settings. Current Kalos/PerpMe venues are deliberately strict: populate verified
mainnet data before enabling these scanners rather than silently omitting a venue.
Unknown mainnet fields remain null in the committed manifest.

## Storage and child processes

Testnet keeps legacy paths. Mainnet inserts `elysium-mainnet` into each database,
state, scan/output, round, feed/dispute and X database/drafts path, including
explicit overrides; paths already namespaced are unchanged. An opposite-network
path is rejected. Uploaded wallet reads live beside its namespaced guard state.
`DELPHI_DIR` is executable source, not state, and is not rewritten.

Refresh wrappers must pass the same selection/path environment through scan,
explain and feed-publish. Fresh-reader subprocesses inherit the selection.
Trial generators use selected manifests and isolated input/output folders.
Feed publication rejects scan metadata from another network.

Passport registry defaults now come from the manifest even without an explicit
`REGISTRY_ADDRESS`; existing deployment overrides retain their behavior. No keys
are generated or changed by selection. Do not reuse operating/signing state or
point mainnet service URLs at testnet services.

Run each package's `npm run typecheck` and `npm test`. Shared selector, validation,
state-isolation and filled/null-mainnet cases are in
`indexer/test/network.test.ts`; Trials and feed tests cover cross-chain inputs.
