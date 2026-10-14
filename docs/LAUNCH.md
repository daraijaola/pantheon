# PANTHEON: launch plan

The grant needs a token launched through Ascend on Elysium **mainnet**. A testnet launch doesn't count. Ascend goes live on mainnet's first day, and so does PNTH.

## What works today (Elysium testnet)

- **PNTH**, launched through Covenant. Its Covenant holds the creator role: sell fees are burned, and buy fees go to the basket that's paid out to stakers.
- **Covenant**, for anyone: pantheonindex.com/covenant/launch. Two coins are on it so far: PNTH and Covenant Demo (COVD).
- **Staking**: a 3-day unlock, a time bonus up to 1.5×, and a HYPE Passport boost up to 1.25×. Rewards stream over a day.
- **The basket**: proposal 0 (FGK, FLOW, FLOWR, PACT and DAWN, 20% each, chosen from DELPHI's data) starts after its 24-hour wait.
- **HYPE Passport**: the service is live and signs Passports that the on-chain registry checks.
- **DELPHI**: scans every Ascend coin twice a day. Claude writes plain-English reports, and every claim links to its transaction: pantheonindex.com/delphi
- **Proof**: 7 of our contracts are verified on the explorer, and the Slither review is in `docs/security/slither.md`. There are 24 contract tests (7 against a copy of live Ascend), 141 Passport service tests and 87 DELPHI tests.

## Day one on mainnet

Each step is a script that is already run on testnet (`script/Deploy.s.sol`):

1. Deploy the HYPE Passport registry. Its attestor is the Passport service. Its guardian is Ascend if they agree to hold it, otherwise a multisig.
2. Deploy the Covenant factory.
3. Launch PNTH through the factory: 1 billion supply, no presale, no team allocation and no dev-buy (a Covenant launch can't have one). Covenant's jobs are set at launch and can never change.
4. Deploy the basket list, the staking contract and the basket vault.
5. Verify every contract on the explorer and publish the addresses on pantheonindex.com/security.
6. Point the site, the Passport service, the keeper and DELPHI at mainnet.
7. The first basket comes about 4 days later: a coin must be 3 days old to enter, and every list waits 24 hours. Until then, buy fees reach stakers as USDC.

## Before mainnet

- An outside review of the five core contracts (Covenant, the basket list, the vault, staking and the Passport registry), paid for from the grant.
- A multisig for the curator. The guardian goes to Ascend if they accept.
- The keeper running on its own: it routes PNTH's fees, buys the basket and refreshes Passport boosts.
- The Trials vote: HYPE Passport holders vote three coins into the basket each week.

## Token plan

- 1,000,000,000 PNTH, the Ascend standard. No presale, no team tokens, no dev-buy.
- Every trade pays Ascend's 1% fee: 0.5% to Ascend and 0.5% to PNTH's Covenant. Covenant's half from buys goes to the basket for stakers, and its half from sells is burned.
- **Open:** whether the team takes a small share of Covenant's half to keep building. It's 0% today, and it has to be decided before launch, because Covenant's jobs can't change afterwards.

## After launch

- The weekly Trials vote, with Passport tiers giving 1, 2 or 3 votes.
- Covenant for every Ascend creator: burns, team pay and a share to the basket, with no owner.
- DELPHI as a public good: reports on every Ascend coin, and an open feed other apps can use.
- The HYPE Passport as Elysium's "real HYPE holder" check, for any app.

## What we'd ask of Ascend

- To hold the guardian key that can veto basket lists (it can only stop a list, never add one).
- To confirm the creator share on mainnet: 50% in the code, 25% in the docs.
- Public testing access, so others can trade the coins PANTHEON shows.
