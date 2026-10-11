// Live probe, run by hand (never in tests): node scripts/probe-hl.ts <address> [address...]
// Calls every info request the service uses through the real client and prints a summary.
import type { Address } from "viem";
import { GENESIS_WINDOW_MS, HL_TOKEN, loadConfig } from "../src/config.ts";
import { createHlClient } from "../src/hl/client.ts";

const users = process.argv.slice(2) as Address[];
if (users.length === 0) {
  console.error("usage: node scripts/probe-hl.ts <address> [address...]");
  process.exit(1);
}

const config = loadConfig();
const hl = createHlClient(config);
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

for (const user of users) {
  const started = Date.now();
  const role = await hl.userRole(user);
  const spot = await hl.spotClearinghouseState(user);
  const lend = await hl.borrowLendUserState(user);
  const staking = await hl.delegatorSummary(user);
  const ledger = await hl.userNonFundingLedgerUpdates(user, 0);
  const genesis = await hl.userNonFundingLedgerUpdates(user, GENESIS_WINDOW_MS.start, GENESIS_WINDOW_MS.end);
  const portfolio = await hl.portfolio(user);
  const subs = await hl.subAccounts(user);
  const multisig = await hl.userToMultiSigSigners(user);

  const hypeLend = lend.tokenToState.find(([token]) => token === HL_TOKEN.HYPE)?.[1];
  console.log({
    user: short(user),
    role: role.role,
    spotHype: spot.balances.find((b) => b.token === HL_TOKEN.HYPE)?.total ?? "0",
    borrowedHype: hypeLend?.borrow.value ?? "0",
    staked: { delegated: staking.delegated, undelegated: staking.undelegated, pending: staking.totalPendingWithdrawal },
    ledger: { entries: ledger.length, first: ledger[0] ? new Date(ledger[0].time).toISOString() : null },
    hypeGenesis: genesis.some((e) => e.delta.type === "spotGenesis" && e.delta.token === "HYPE"),
    allTimeVolume: portfolio.find(([p]) => p === "allTime")?.[1].vlm ?? null,
    subAccounts: subs.length,
    multisig: multisig !== null,
    ms: Date.now() - started,
    budgetLeft: hl.limiter.available(),
  });
}
