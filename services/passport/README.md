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
scripts/probe-hl.ts   live probe, run by hand
test/setup.ts         blocks live network calls in tests
test/mockHl.ts        fake HL /info on 127.0.0.1, answering from the fixtures
test/fixtures/hl/     copies of docs/passport-fixtures (a test fails if they drift)
```

Planned modules (spec §7): `evm/hyperevm.ts`, `score.ts`, `link.ts`, `attest.ts`, `relayer.ts`, `scheduler.ts`, `api.ts`, `db.ts`.

## Hyperliquid client

- Every request is charged its weight (§2.11) before it is sent, retries included. The limiter is a sliding window, so no 60 s span ever exceeds `HL_WEIGHT_PER_MIN`. When the budget is spent, calls wait.
- **Retried:** HTTP 429, HTTP 5xx, dropped connections and timeouts (10 s per attempt). Three retries after 5, 10 and 20 s, or longer if the server sends `Retry-After`. Then the call fails with `HlError` code `UNAVAILABLE`.
- **Not retried:** other 4xx. HL answers malformed requests with `422` and a plain-text message. These fail with `BAD_REQUEST`. A `200` that isn't JSON, or has an unexpected shape, fails with `BAD_RESPONSE`.
- Amounts stay as HL's decimal strings. Scoring converts them to fixed-point, never via floats.

Live check by hand (uses about 202 weight per address):

```sh
node scripts/probe-hl.ts 0xbd2d67376d2e9abb125a70e817896425f5f22289
```

## Rules

- No keys, pepper, `.env` or databases in git. Only `.env.example` is committed.
- Tests use fixtures only. Live probes live in `scripts/` and are run by hand.
- Commit only this folder: `git add services/passport`.
