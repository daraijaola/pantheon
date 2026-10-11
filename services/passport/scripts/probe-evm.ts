// Live probe, run by hand (never in tests): node scripts/probe-evm.ts <address> [address...]
// Reads HyperEVM holdings through the real reader (one Multicall3 call per address).
import { formatUnits, type Address } from "viem";
import { loadConfig } from "../src/config.ts";
import { createHyperEvmReader, khypeInHype } from "../src/evm/hyperevm.ts";

const users = process.argv.slice(2) as Address[];
if (users.length === 0) {
  console.error("usage: node scripts/probe-evm.ts <address> [address...]");
  process.exit(1);
}

const evm = createHyperEvmReader(loadConfig());
const hype = (v: bigint | null) => (v === null ? "FAILED" : formatUnits(v, 18));

for (const user of users) {
  const started = Date.now();
  const h = await evm.holdings(user);
  console.log({
    user: `${user.slice(0, 6)}…${user.slice(-4)}`,
    block: h.blockNumber,
    nativeHype: hype(h.nativeHype),
    whype: hype(h.whype),
    khype: hype(h.khype),
    khypeRate: hype(h.khypeRate),
    khypeInHype: formatUnits(khypeInHype(h), 18),
    hypurr: h.hypurr,
    kntq: hype(h.kntq),
    failed: h.failed,
    ms: Date.now() - started,
    rpcBudgetLeft: evm.limiter.available(),
  });
}
