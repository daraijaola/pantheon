// Live probe, run by hand: node scripts/probe-recheck.ts <address> [address...]
// Checks that the scheduler's light daily re-check (62 HL weight, cached age/genesis/volume)
// scores a real account exactly like a full first-link snapshot (202 weight). ~264 weight each.
import type { Address } from "viem";
import { loadConfig } from "../src/config.ts";
import { createHyperEvmReader } from "../src/evm/hyperevm.ts";
import { createHlClient } from "../src/hl/client.ts";
import { computePassport } from "../src/score.ts";
import { collectRecheck, collectSnapshot, recheckCost } from "../src/snapshot.ts";

const users = process.argv.slice(2) as Address[];
if (users.length === 0) {
  console.error("usage: node scripts/probe-recheck.ts <address> [address...]");
  process.exit(1);
}
const config = loadConfig();
const hl = createHlClient(config);
const evm = createHyperEvmReader(config);

for (const user of users) {
  const nowMs = Date.now();
  const full = await collectSnapshot(hl, evm, user);
  const a = computePassport(full, nowMs);
  // The binding as the scheduler would hold it the day after linking.
  const binding = { hl: user, firstSeenMs: full.firstSeenMs, genesis: full.hypeGenesis, vlm: full.allTimeVolumeUsd, roleCheckedAt: Math.floor(nowMs / 1000) - 86_400 };
  const before = hl.limiter.available();
  const { snapshot, full: weekly } = await collectRecheck(hl, evm, binding, Math.floor(nowMs / 1000));
  const spent = before - hl.limiter.available();
  const b = computePassport(snapshot, nowMs);
  const view = (p: typeof a) => (p.ok ? { tier: p.tier, stamps: p.stamps } : { rejected: p.error });
  console.log({
    user: `${user.slice(0, 6)}…${user.slice(-4)}`,
    full: view(a),
    light: view(b),
    same: JSON.stringify(view(a)) === JSON.stringify(view(b)),
    lightWeight: spent,
    predicted: recheckCost(binding, Math.floor(nowMs / 1000)),
    weekly,
  });
}
