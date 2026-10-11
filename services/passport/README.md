# HYPE Passport attestor service

Proves that an Elysium wallet belongs to a real Hyperliquid holder. The service reads Hyperliquid mainnet (info API + HyperEVM), computes a tier (0–3) and stamps, signs an EIP-712 attestation, and relays it to `HypePassportRegistry` on Elysium testnet.

Spec: [`docs/PASSPORT_SPEC.md`](../../docs/PASSPORT_SPEC.md). Owner: Ayinde. Tickets and status: `TASKS.md` (Phase 2).

## Requirements

- Node 24+ (runs `.ts` files directly, so there is no build step)
- npm 11

## Setup

```sh
cd services/passport
npm ci
cp .env.example .env   # local only, never committed
```

`better-sqlite3` ships prebuilt binaries, so its install script is denied in `package.json` (`allowScripts`). Nothing is compiled during install.

## Commands

| Command | What it does |
|---|---|
| `npm test` | Unit tests (vitest). They never touch the network: `test/setup.ts` rejects any `fetch` to a non-loopback host. |
| `npm run test:watch` | Tests in watch mode |
| `npm run typecheck` | `tsc --noEmit` (strict) |
| `npm run lint` | ESLint with typescript-eslint |
| `npm run check` | All three; run before every commit |
| `npm run test:contracts` | Foundry: the reference registry accepts our attestations (needs `forge`) |
| `npm run fixture:attestation` | Rewrite the Foundry fixture after changing attestation code |

## Configuration

`src/config.ts` reads the environment (or `.env` via `node --env-file=.env`) and validates it with zod. It throws a `ConfigError` that names bad variables without printing their values.

| Variable | Default | Notes |
|---|---|---|
| `CHAIN_ID` | `99801` | Elysium testnet |
| `ELYSIUM_RPC` | `https://testnet-rpc.elysium.kinetiq.xyz` | |
| `HYPEREVM_RPC` | `https://rpc.hyperliquid.xyz/evm` | HyperEVM **mainnet** |
| `HL_INFO_URL` | `https://api.hyperliquid.xyz/info` | Hyperliquid **mainnet** |
| `REGISTRY_ADDRESS` | unset | Set once the registry is deployed (P9) |
| `ATTESTOR_KEY_FILE` | `/var/lib/passport/keys/attestor.key` | Path only, mode 0600; a raw key here is refused |
| `RELAYER_KEY_FILE` | `/var/lib/passport/keys/relayer.key` | Gas-only key, separate from the attestor |
| `PEPPER_FILE` | `/var/lib/passport/keys/pepper` | 32 bytes hex |
| `DB_PATH` | `/var/lib/passport/passport.db` | |
| `HL_WEIGHT_PER_MIN` | `800` | Hyperliquid info API weight budget |
| `EVM_REQ_PER_MIN` | `60` | HyperEVM RPC request budget |
| `PORT` | `8787` | Always bound to `127.0.0.1`; Caddy exposes `/api/passport/*` |

Spec constants (addresses, weights, tiers, stamps, timings) are exported from `src/config.ts`. Each one cites its spec section.

## Layout

```
src/config.ts         env + constants
src/ratelimit.ts      sliding-window weight limiter (HL info API, HyperEVM RPC)
src/hl/schemas.ts     zod schemas for the HL info responses (§2)
src/hl/client.ts      one method per HL request type; budget, retries, typed HlError
src/evm/hyperevm.ts   HyperEVM holdings in one Multicall3 call (§3)
src/snapshot.ts       gathers one account's data (HL calls + HyperEVM read, in parallel)
src/score.ts          PURE scoring: snapshot + time → tier, stamps, reasons (§4)
src/eip712.ts         EIP-712 domain, types and Link payload shared with the UI and registry (§5.1)
src/link.ts           challenge + signature checks for linking, hlKey (§5)
src/db.ts             SQLite schema (§7.1) and the single-use challenge store
src/attest.ts         build + sign Attestations; key/pepper file loaders (mode 0600/0400 only)
contracts-check/      isolated Foundry project: our attestations vs the reference registry
scripts/make-attestation-fixture.ts  writes contracts-check/fixtures/attestation.json
scripts/probe-registry-call.ts  live, read-only: the Elysium node runs registry + our attestation in one eth_call
scripts/probe-hl.ts   live probe, run by hand
scripts/probe-evm.ts  live probe, run by hand
scripts/probe-passport.ts  live end-to-end scoring, run by hand
test/setup.ts         blocks live network calls in tests
test/mockHl.ts        fake HL /info on 127.0.0.1, answering from the fixtures
test/mockEvm.ts       fake HyperEVM (Multicall3 per wallet) for tests
test/fixtures/hl/     copies of docs/passport-fixtures (a test fails if they drift)
```

Planned modules (spec §7): `relayer.ts`, `scheduler.ts`, `api.ts`, `db.ts`.

## Hyperliquid client

- Every request is charged its weight (§2.11) before it is sent, retries included. The limiter is a sliding window, so no 60 s span ever exceeds `HL_WEIGHT_PER_MIN`. When the budget is spent, calls wait.
- **Retried:** HTTP 429, HTTP 5xx, dropped connections and timeouts (10 s per attempt). Three retries after 5, 10 and 20 s, or longer if the server sends `Retry-After`. Then the call fails with `HlError` code `UNAVAILABLE`.
- **Not retried:** other 4xx. HL answers malformed requests with `422` and a plain-text message. These fail with `BAD_REQUEST`. A `200` that isn't JSON, or has an unexpected shape, fails with `BAD_RESPONSE`.
- Amounts stay as HL's decimal strings. Scoring converts them to fixed-point, never via floats.
- Spot balances may include HIP-4 outcome positions without a `token` (coin `o458`, `+103990`). They are accepted and never count as HYPE or KNTQ.

Live check by hand (uses about 202 weight per address):

```sh
node scripts/probe-hl.ts 0xbd2d67376d2e9abb125a70e817896425f5f22289
```

## HyperEVM reader

- One `aggregate3` call per wallet: block number, native HYPE, WHYPE, kHYPE, the kHYPE→HYPE rate, Hypurr and KNTQ. Always at the latest block, because HyperEVM's public RPC serves nothing else. Each call costs one unit of `EVM_REQ_PER_MIN` (HL caps the public RPC at 100/min per IP).
- A single read that reverts comes back `null` and is listed in `failed`. Scoring counts it as 0.
- If the whole batch fails, the reader retries (5, 10, 20 s), then throws `EvmError` `UNAVAILABLE`. viem reports a failed batch as "every call failed" rather than throwing, so the block-number read is used as a canary. An outage is never reported as an empty wallet.
- A kHYPE rate outside 1.0–1.2 is treated as unread. The rate contracts are upgradeable proxies, and HL has no automatic slashing.

```sh
node scripts/probe-evm.ts 0xcf2115a890a19b706582692ce3513b61a507ad7c   # kHYPE ≈ 5247, rate ≈ 1.026
```

## Scoring

`computePassport(snapshot, nowMs)` is pure: no clock reads and no I/O, so the same input always gives the same result.

- **Exact maths.** Amounts are bigint in 1e8 units. HL strings are truncated past the 8th decimal (never rounded up), and strings like `1e-8` are refused. On-chain 18-decimal amounts are floored.
- **The score.** `S = staked + 0.5 × liquid`.
  - staked = delegated + undelegated.
  - liquid = pending withdrawals + max(0, spot − borrowed) + sub-account spot + EVM HYPE + WHYPE + kHYPE × rate.
- **Tiers.** T1 S ≥ 10. T2 S ≥ 100 and age ≥ 30 d. T3 S ≥ 1000 and age ≥ 90 d. A `missing` account is capped at T1.
- **Rejections.** `AGENT_WALLET` (with the master address), `NOT_A_SIGNING_ACCOUNT` (vault, sub-account or any unknown role) and `MULTISIG_UNSUPPORTED`.
- **Reasons** explain why the account isn't one tier higher, as codes only: `SCORE_BELOW_10|100|1000`, `ACCOUNT_AGE_BELOW_30D|90D`, `NO_HYPERCORE_HISTORY`, `PARTIAL_EVM_READ`.
- **Cached facts.** The snapshot carries derived facts (first-seen time, genesis, all-time volume) so that re-checks can reuse cached values (§7.1, §7.2).

```sh
node scripts/probe-passport.ts 0xbd2d67376d2e9abb125a70e817896425f5f22289   # tier 2, stamps 189
```

## Linking

1. `createChallenge` checks both addresses and rejects API wallets, vaults, sub-accounts and multi-sigs before anyone signs. It then stores a random 32-byte nonce valid for 15 minutes and returns the Link typed data as plain JSON.
2. The HL wallet signs it, and the Elysium wallet signs the same data (one signature is enough if they are the same address). The UI passes the JSON through `toSignable()` first, because viem's types want bigint for `deadline`/`chainId`.
3. `verifyLink` rebuilds the message from the stored challenge; only the signatures come from the client. It checks both signers, then consumes the nonce atomically, so only one verify can ever succeed.
   - A bad signature does **not** burn the challenge.

- **No `chainId` in the domain.** MetaMask (`@metamask/signature-controller` 40.0.0, `validation.js:106-116`) and Rabby (`provider/controller.ts:418-427`) refuse typed data whose domain `chainId` differs from the active network. The chain ID lives in the message instead.
- **Wallet interop.** `test/wallet-interop.test.ts` drives viem/wagmi `signTypedData` through MetaMask's signer (`@metamask/eth-sig-util` V4) with the HL wallet on HyperEVM, Arbitrum and Ethereum. `package.json` `overrides` pins `uuid` ≥ 11.1.1 because of an advisory inside MetaMask's utils (dev-only).
- **`hlKey = keccak256(pepper ‖ hlAccount)`**, which hides the HL address on-chain.

## Attestations

- `buildAttestation` sets issuedAt = now, expiry = +7 d, deadline = +1 h, chainId 99801.
  - issuedAt is bumped to `lastIssuedAt + 1` when needed, because the registry wants strictly newer attestations.
  - It refuses anything the registry would reject: tier > 3, stamp bits 8–31, a zero account or hlKey, or an issuedAt more than 10 min ahead.
- `signAttestation` produces the 65-byte, low-s signature `HypePassportRegistry.submit` verifies. It reproduces the spec's §5.1 cross-check digest and signature byte for byte.
- `contracts-check/` holds a reference copy of the spec's Appendix A registry (not deployed from here; the real one is P6 in `src/passport/`). Its 6 Foundry tests submit our signed attestations: accepted, renewal, tier-0 downgrade, replay, deadline, tampering. They also pass on a fork of Elysium testnet (`forge test --fork-url https://testnet-rpc.elysium.kinetiq.xyz`).
- `loadAttestor` / `loadPepper` refuse files that group or others can read. Create them with `umask 077` (for example `umask 077; cast wallet new | ...`) so they start out as 0600.
- **Live check (no transaction):** `forge build` in `contracts-check`, then `node scripts/probe-registry-call.ts`. A single `eth_call` makes the Elysium testnet node deploy the reference registry and submit a fresh attestation signed by `attest.ts`, all inside the call. Nothing is broadcast and no real key is used.
  - On 2026-10-11 it returned: accepted (tier 2, 1.20×), a tampered tier → `BadSignature`, a late one → `DeadlinePassed`, signed for another registry → `BadSignature`.

## Rules

- No keys, pepper, `.env` or databases in git. Only `.env.example` is committed.
- Tests use fixtures only. Live probes live in `scripts/` and are run by hand.
- Commit only this folder: `git add services/passport`.
