// Live probe, run by hand (never in tests): node scripts/probe-passport.ts <address> [address...]
// Scores accounts end to end against live Hyperliquid + HyperEVM (202 HL weight + 1 RPC each).
import { formatUnits, type Address } from "viem";
import { DAY_MS, loadConfig } from "../src/config.ts";
import { createHyperEvmReader } from "../src/evm/hyperevm.ts";
import { createHlClient } from "../src/hl/client.ts";
import { computePassport, stampNames } from "../src/score.ts";
import { collectSnapshot } from "../src/snapshot.ts";

const users = process.argv.slice(2) as Address[];
if (users.length === 0) {
  console.error("usage: node scripts/probe-passport.ts <address> [address...]");
  process.exit(1);
}

const config = loadConfig();
const hl = createHlClient(config);
const evm = createHyperEvmReader(config);

for (const user of users) {
  const snap = await collectSnapshot(hl, evm, user);
  const p = computePassport(snap, Date.now());
  const who = `${user.slice(0, 6)}…${user.slice(-4)}`;
  if (!p.ok) {
    console.log({ user: who, rejected: p.error });
    continue;
  }
  console.log({
    user: who,
    tier: p.tier,
    stamps: p.stamps,
    stampNames: stampNames(p.stamps),
    score: formatUnits(p.scoreE8, 8),
    ageDays: Math.floor(p.parts.ageMs / DAY_MS),
    reasons: p.reasons,
  });
}
