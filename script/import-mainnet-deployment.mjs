import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const { decodeEventLog, parseAbi, getAddress, keccak256, encodeAbiParameters } = createRequire(new URL("../web/package.json", import.meta.url))("viem");
const TEAM = "0xdf6aa48d464d9bc2443096f03cba4fa750d3bdc6";
export const abi = parseAbi([
  "event Launched(bytes32 indexed poolId, address indexed token, address indexed creator, address quote, uint256 supplySeeded, uint256 devBuyTokens, uint24 fee, uint24 builderFee)",
  "event EscrowLaunched(bytes32 indexed poolId, address indexed escrow, address indexed recipient, address dev, address builder, address ruleSet, bool cto)",
  "event SeatDeployed(address indexed seat, address indexed deployer, address indexed primaryPayee, address devBuyTo, uint16 holderBpsQuote, uint16 holderBpsToken, uint16 buybackBps, bool burnBought, address[] payees, uint16[] bps, address[] exclusions)",
]);
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const check = (condition, message) => { if (!condition) throw new Error(message); };
const success = r => r && [1, "1", "0x1", "success"].includes(r.status);
const logsOf = receipt => receipt.logs.map(l => [l.address.toLowerCase(), l.topics.map(t => t.toLowerCase()), l.data.toLowerCase(), String(BigInt(l.logIndex))]);

export async function importDeployment(artifact, manifest, rpc) {
  check(Number(artifact.chain) === 99901 && manifest.chainId === 99901 && manifest.network.chainId === 99901 && manifest.network.testnet === false, "chain 99901 mainnet artifact and manifest required");
  check(artifact.transactions?.length && artifact.receipts?.length === artifact.transactions.length && !artifact.pending?.length, "complete mined receipts required; dry runs and pending broadcasts are rejected");
  check(BigInt(await rpc("eth_chainId", [])) === 99901n, "RPC chain mismatch");
  for (const t of artifact.transactions) {
    check(same(t.transaction?.from, TEAM), "unexpected deployment sender");
    const receipt = artifact.receipts.find(r => same(r.transactionHash, t.hash));
    check(success(receipt) && receipt.blockHash && receipt.blockNumber, "missing or failed transaction receipt");
    const live = await rpc("eth_getTransactionReceipt", [t.hash]);
    check(success(live) && same(live.blockHash, receipt.blockHash) && same(live.transactionHash, receipt.transactionHash), "receipt is not confirmed on the selected RPC");
    check(same(live.from, TEAM) && (live.contractAddress == null ? receipt.contractAddress == null : same(live.contractAddress, receipt.contractAddress)), "receipt sender or creation mismatch");
    check(JSON.stringify(logsOf(live)) === JSON.stringify(logsOf(receipt)), "artifact receipt logs differ from RPC");
  }
  const next = structuredClone(manifest);
  const creations = { HypePassportRegistry: "passportRegistry", ConstituentRegistryV5: "constituentRegistry", PantheonStaking: "staking", IndexVaultV5: "indexVault" };
  for (const [contract, field] of Object.entries(creations)) {
    const txs = artifact.transactions.filter(t => t.transactionType === "CREATE" && t.contractName === contract);
    check(txs.length === 1, `exactly one ${contract} creation required`);
    const tx = txs[0];
    const receipt = artifact.receipts.find(r => same(r.transactionHash, tx.hash));
    check(same(receipt.contractAddress, tx.contractAddress), `${contract} creation address mismatch`);
    next[field] = getAddress(receipt.contractAddress);
  }
  const external = manifest.network.external.ascend;
  const events = artifact.receipts.flatMap(r => r.logs).flatMap(l => {
    try { return [{ address: l.address, ...decodeEventLog({ abi, topics: l.topics, data: l.data }) }]; } catch { return []; }
  });
  const one = (name, address) => {
    const found = events.filter(e => e.eventName === name && same(e.address, address));
    check(found.length === 1, `exactly one trusted ${name} event required`);
    return found[0].args;
  };
  const launch = one("Launched", manifest.launchpad);
  const escrow = one("EscrowLaunched", external.escrowFactory);
  const seat = one("SeatDeployed", external.seatFactory);
  check(same(launch.poolId, escrow.poolId) && same(launch.creator, escrow.escrow) && same(escrow.recipient, seat.seat), "launch/escrow/seat mismatch");
  check(same(launch.quote, manifest.usdc) && launch.fee === 15000 && launch.builderFee === 0, "unexpected PNTH fee terms");
  check(same(seat.deployer, TEAM) && same(seat.devBuyTo, TEAM) && same(escrow.dev, TEAM) && escrow.cto === false, "unexpected launch roles");
  check(same(seat.primaryPayee, TEAM) && same(escrow.builder, "0x0000000000000000000000000000000000000000") && same(escrow.ruleSet, external.ruleSet), "unexpected escrow route");
  check(seat.payees.length === 2 && same(seat.payees[0], TEAM) && same(seat.payees[1], next.indexVault) && seat.bps[0] === 1500 && seat.bps[1] === 8500, "unexpected seat payees");
  check(!seat.holderBpsQuote && !seat.holderBpsToken && !seat.buybackBps && !seat.burnBought, "unexpected seat allocation");
  const [currency0, currency1] = [getAddress(launch.token), getAddress(launch.quote)].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1);
  const pool = keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }], [currency0, currency1, 0x800000, 200, manifest.launchpad]));
  check(same(pool, launch.poolId), "V4 pool key mismatch");
  Object.assign(next, { pnth: getAddress(launch.token), pnthPool: pool, creatorSeat: getAddress(seat.seat), creatorEscrow: getAddress(escrow.escrow), pnthRouter: null, covenantFactory: null });
  next.network.deployedFrom = Math.min(...artifact.receipts.map(r => Number(BigInt(r.blockNumber))));
  check(Number.isSafeInteger(next.network.deployedFrom) && next.network.deployedFrom > 0, "invalid deployment block");
  next.network.acquireUrl = `https://app.ascendlaunch.xyz/tokens/${next.pnth}`;
  for (const field of [...Object.values(creations), "pnth", "creatorSeat", "creatorEscrow"]) {
    check(!/^0x0{40}$/i.test(next[field]), `zero ${field}`);
    const code = await rpc("eth_getCode", [next[field], "latest"]);
    check(typeof code === "string" && /^0x(?:[0-9a-f]{2})+$/i.test(code), `${field} has no deployed code`);
    check(!manifest[field] || same(manifest[field], next[field]), `refusing to overwrite a different ${field} deployment`);
  }
  return next;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [artifactPath, manifestPath = "deployments/elysium-mainnet.json"] = process.argv.slice(2);
    check(artifactPath, "usage: node script/import-mainnet-deployment.mjs <broadcast/DeployMainnet.s.sol/99901/run-latest.json> [manifest.json]");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const rpc = async (method, params) => {
      const response = await fetch(process.env.ELYSIUM_RPC || manifest.network.publicRpc, { method: "POST", headers: { "content-type": "application/json", "user-agent": "Mozilla/5.0 PANTHEON read-only artifact verification" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(30_000) });
      check(response.ok, `RPC HTTP ${response.status}`);
      const body = await response.json();
      check(!body.error, `RPC ${method} failed`);
      return body.result;
    };
    const next = await importDeployment(JSON.parse(readFileSync(artifactPath, "utf8")), manifest, rpc);
    writeFileSync(manifestPath, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`Imported confirmed chain-99901 deployment from block ${next.network.deployedFrom}; no transactions sent`);
  } catch (error) {
    console.error(error instanceof Error && !/fetch failed/i.test(error.message) ? error.message : "RPC request failed");
    process.exitCode = 1;
  }
}
