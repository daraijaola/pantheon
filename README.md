# PANTHEON

**The best of Ascend, in one token.** PANTHEON ($PNTH) is the index of [Ascend](https://x.com/AscendLaunch), the token launchpad on Elysium. Buys fill a basket of the best Ascend coins, which is paid out to people who stake PNTH. Sells burn PNTH.

Live on Elysium testnet: **[pantheonindex.com](https://pantheonindex.com)** · X: [@pantheonindex](https://x.com/pantheonindex)

## Try it

| | |
|---|---|
| [Get test PNTH](https://pantheonindex.com/get) | One click: free test USDC, then a buy straight from PNTH's Ascend pool |
| [Stake](https://pantheonindex.com/stake) | Earn the basket. 3-day unlock, up to 1.5× for holding 30 days |
| [HYPE Passport](https://pantheonindex.com/passport/get) | Prove you hold HYPE on Hyperliquid, without revealing the wallet. Up to 1.25× more from staking |
| [DELPHI](https://pantheonindex.com/delphi) | An AI that checks every Ascend coin for bundled launches, wash trading and hidden whales. Every claim links to its transaction |
| [Launch on Covenant](https://pantheonindex.com/covenant/launch) | Launch your own Ascend coin with fee rules nobody can change |
| [Security](https://pantheonindex.com/security) | Every contract, every key and what it can do |

## How it works

- **Fees.** Every Ascend trade pays a 1% fee. Half goes to Ascend, and half to the coin's creator, which for PNTH is **Covenant**, a contract with no owner. Of Covenant's half, 85% does PNTH's jobs: buys fill the basket and sells are burned. From mainnet, 15% pays the team; the testnet version runs at 0%. The split is fixed at launch and can't be changed.
- **The basket.** Up to 10 Ascend coins, each at most 20%, at least 3 days old and trading against USDC. A coin [DELPHI](services/delphi) flags is never picked. A new list waits 24 hours on-chain, and a guardian key can veto it but never add to it. The vault only buys within 5% of Ascend's own average price, keeps each buy small, and pauses a coin after a big move.
- **Staking.** Whatever the basket buys is streamed to stakers over a day. The time bonus grows to 1.5× over 30 days, and the Passport boost is capped at 1.25×. Rewards can never exceed what came in: a 1,000-run fuzz test checks it.
- **The Trials** (next): HYPE Passport holders will vote three coins into the basket each week.

## What's in this repo

| Path | What it is |
|---|---|
| `src/covenant` | `CovenantFactory` launches a coin straight into a `CovenantRouter`, which holds the creator role and runs the fee jobs (pay, burn, basket, stream) |
| `src/index` | `ConstituentRegistry`: the basket list, with the 24-hour wait and the veto. `IndexVault`: buys the basket and streams it |
| `src/staking` | `PantheonStaking`: multi-token reward streams, the time bonus and the Passport boost |
| `src/passport` | `HypePassportRegistry`: records Passports signed by the Passport service, which expire within 8 days |
| `test/` | Unit tests (with a fuzz test), Passport tests, and fork tests against Ascend's live testnet contracts |
| `script/` | `Deploy.s.sol` (the whole system in one run), `Testnet.s.sol` (hands-on testnet actions) |
| `deployments/` | Live addresses, plus each Trials round's data file (`trials/round-1.json`) |
| `web/` | The site (Next.js) |
| `services/passport` | The HYPE Passport service: reads Hyperliquid, signs Passports, relays them |
| `services/delphi` | DELPHI: the cheat detector, and Claude-written reports checked against the data |
| `services/keeper` | Runs the routine calls: route fees, buy the basket, refresh boosts |
| `services/indexer` | The site's live numbers, each linked to its transaction |
| `docs/` | The [mainnet launch plan](docs/LAUNCH.md) and the [Slither review](docs/security/slither.md) |

## Live contracts (Elysium testnet, chain 99801)

| Contract | Address |
|---|---|
| PNTH | [`0x048aCeb334cb1835dc897a749C5985e169EAb1C5`](https://elysium.kinetiq.xyz/testnet-explorer/token/0x048aCeb334cb1835dc897a749C5985e169EAb1C5) |
| Covenant for PNTH | [`0xE0Fb49DBDC3406cF1f175EeCABDFb282a7a98b66`](https://elysium.kinetiq.xyz/testnet-explorer/address/0xE0Fb49DBDC3406cF1f175EeCABDFb282a7a98b66) |
| Covenant factory | [`0x42b9F24d88Ca015CC59E516B272F7A46a87Fa35a`](https://elysium.kinetiq.xyz/testnet-explorer/address/0x42b9F24d88Ca015CC59E516B272F7A46a87Fa35a) |
| Basket list | [`0xD8cEA0015E2C876ab5fa6D9178b46B57d65c6087`](https://elysium.kinetiq.xyz/testnet-explorer/address/0xD8cEA0015E2C876ab5fa6D9178b46B57d65c6087) |
| Basket vault | [`0xE636003Feb05D0FB8f6016733C3d723446C9f221`](https://elysium.kinetiq.xyz/testnet-explorer/address/0xE636003Feb05D0FB8f6016733C3d723446C9f221) |
| Staking | [`0x30c88fce1fAD545Df0fC603287f93F0f94076224`](https://elysium.kinetiq.xyz/testnet-explorer/address/0x30c88fce1fAD545Df0fC603287f93F0f94076224) |
| HYPE Passport registry | [`0x0Eb4A8eB47364Be9d18410AF2f850db92b807290`](https://elysium.kinetiq.xyz/testnet-explorer/address/0x0Eb4A8eB47364Be9d18410AF2f850db92b807290) |

Every contract we wrote is verified on the explorer. PNTH itself is a standard Ascend token made by Ascend's launchpad.

## Run it

```sh
forge build
forge test --no-match-path "test/fork/*"   # unit and Passport tests
forge test --match-path "test/fork/*"      # against Ascend's live testnet (RPC alias "elysium")
```

Each service has its own README; `npm ci && npm run check` runs its typecheck, lint and tests. Tests never touch the network.

## Security

Not audited yet; an outside review comes before mainnet. No key can move anyone's funds. The curator can propose basket lists, the guardian can only block them or switch Passports off, and the Passport signer issues certificates that expire within 8 days. Details: [pantheonindex.com/security](https://pantheonindex.com/security). Found a problem? Message [@pantheonindex](https://x.com/pantheonindex) and we'll take it private.

## Team

Micheal ([@daraijaola](https://github.com/daraijaola)) leads and builds the contracts and the site. Ayinde ([@Ayindecodes](https://github.com/Ayindecodes)) builds the services.
