# TASKS — PANTHEON (shared board for Micheal, Ayinde and their Claude sessions)

Update this file when you start/finish something. Read `../AGENTS.md` first.
Deadline: submit Oct 18 (hard deadline Oct 20). Contract freeze: Oct 16.

## Status legend
[ ] todo · [~] in progress (put your name) · [x] done

## Phase 0 — Setup & relationships (Oct 11)
- [x] Server, shared repo `/srv/hackathon/pantheon`, Foundry, Ascend sources vendored
- [x] Fork PoC tests vs live Ascend: contract-as-creator, CREATE2 role handoff, fee claim (3/3 pass)
- [ ] Micheal: send Ascend ticket (security heads-up + 3 questions)
- [ ] Micheal: request private testnet access (comment on @AscendLaunch Oct 7 post)
- [ ] Micheal: GitHub org/repo (public, MIT) + X account for PANTHEON
- [ ] Ayinde: log in to server + T3, read AGENTS.md + this file

## Phase 1 — Contracts (Micheal + Claude) · Oct 11–16
- [ ] Covenant: Factory (launch / adopt / predict) + Router (balance-based fee jobs, receipts, no owner)
- [ ] LinearVesting
- [ ] IndexVault (capped, EMA-bounded basket buys; buy-and-LOCK; vest to stakers)
- [ ] ConstituentRegistry (Trials results + 24h timelock + Ascend guardian veto)
- [ ] PantheonStaking (3-day cooldown, hold-time boost ≤1.5×, Passport boost ≤1.25×)
- [ ] HypePassportRegistry (stamps, tiers, expiry, 1:1 Hyperliquid↔Elysium binding)
- [ ] TrialsBallot (gasless EIP-712 votes, on-chain tally)
- [ ] KNTQ buy-and-burn slice
- [ ] Security: fork tests, fuzz + invariants, Halmos, Slither; threat model
- [ ] Deploy + verify on Elysium testnet; launch PNTH-TEST through Covenant

## Phase 2 — App & services (Ayinde + Claude) · Oct 11–17
- [ ] Next.js app: `/` (index + burn counter), `/stake`, `/passport`, `/trials`, `/launch`, `/r/:pool` receipts, `/security`
- [ ] Indexer (Ascend launches, fees, our contract events)
- [ ] Keeper bot (collect → claim → run fee jobs) on the server
- [ ] HYPE Passport service (Hyperliquid API check + signature link)
- [ ] DELPHI v0: AI reports on candidate coins with tx-linked evidence
- [ ] Hosting on the server (Caddy) or Vercel

## Phase 3 — Traction & submission · Oct 13–18
- [ ] Onboard Ascend testers/creators onto Covenant (target 10+ coins)
- [ ] HYPE Passport verifications (target 150+ real holders)
- [ ] Build-in-public threads on X (3)
- [ ] 60–120 s demo video
- [ ] Submission ticket (6 sections) — send by Oct 18
