import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { abi, importDeployment } from "./import-mainnet-deployment.mjs";
const { encodeEventTopics, encodeAbiParameters, keccak256 } = createRequire(new URL("../web/package.json", import.meta.url))("viem");
const manifest = JSON.parse(readFileSync(new URL("../deployments/elysium-mainnet.json", import.meta.url), "utf8"));
const addr = n => `0x${n.toString(16).padStart(40, "0")}`;
const hash = n => `0x${n.toString(16).padStart(64, "0")}`;
const team = "0xdf6aa48d464d9bc2443096f03cba4fa750d3bdc6";
const event = (name, address, args, index) => {
  const item = abi.find(i => i.name === name);
  const inputs = item.inputs.filter(i => !i.indexed);
  return { address, topics: encodeEventTopics({ abi, eventName: name, args }), data: encodeAbiParameters(inputs, inputs.map(i => args[i.name])), logIndex: `0x${index.toString(16)}` };
};
function fixture() {
  const names = ["HypePassportRegistry", "ConstituentRegistryV5", "PantheonStaking", "IndexVaultV5"];
  const transactions = names.map((contractName, i) => ({ hash: hash(i + 1), contractName, transactionType: "CREATE", contractAddress: addr(i + 1), transaction: { from: team } }));
  transactions.push({ hash: hash(5), transactionType: "CALL", transaction: { from: team, to: manifest.network.external.ascend.seatFactory } });
  const receipts = transactions.map((t, i) => ({ transactionHash: t.hash, from: team, status: "0x1", blockNumber: `0x${(100 + i).toString(16)}`, blockHash: hash(100 + i), contractAddress: t.contractAddress ?? null, logs: [] }));
  const pool = keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }], [addr(7), manifest.usdc, 0x800000, 200, manifest.launchpad]));
  receipts[4].logs.push(
    event("SeatDeployed", manifest.network.external.ascend.seatFactory, { seat: addr(5), deployer: team, primaryPayee: team, devBuyTo: team, holderBpsQuote: 0, holderBpsToken: 0, buybackBps: 0, burnBought: false, payees: [team, addr(4)], bps: [1500, 8500], exclusions: [] }, 0),
    event("Launched", manifest.launchpad, { poolId: pool, token: addr(7), creator: addr(6), quote: manifest.usdc, supplySeeded: 10n ** 27n, devBuyTokens: 0n, fee: 15000, builderFee: 0 }, 1),
    event("EscrowLaunched", manifest.network.external.ascend.escrowFactory, { poolId: pool, escrow: addr(6), recipient: addr(5), dev: team, builder: addr(0), ruleSet: manifest.network.external.ascend.ruleSet, cto: false }, 2),
  );
  const artifact = { chain: 99901, transactions, receipts, pending: [] };
  const liveReceipts = structuredClone(receipts);
  const rpc = async (method, args) => {
    if (method === "eth_chainId") return "0x1863d";
    if (method === "eth_getTransactionReceipt") return liveReceipts.find(r => r.transactionHash === args[0]);
    if (method === "eth_getCode") return "0x6000";
    throw new Error(`unexpected method ${method}`);
  };
  return { artifact, liveReceipts, rpc, pool };
}
test("imports all V5 addresses and first block from verified receipts, preserving unpublished metadata", async () => {
  const { artifact, rpc, pool } = fixture();
  const result = await importDeployment(artifact, manifest, rpc);
  assert.equal(result.indexVault, addr(4));
  assert.equal(result.creatorSeat, addr(5));
  assert.equal(result.creatorEscrow, addr(6));
  assert.equal(result.pnth, addr(7));
  assert.equal(result.pnthPool, pool);
  assert.equal(result.network.deployedFrom, 100);
  assert.equal(result.network.acquireUrl, `https://app.ascendlaunch.xyz/tokens/${addr(7)}`);
  assert.equal(result.network.explorerUrl, null);
  assert.deepEqual(result.network.external, manifest.network.external);
  assert.equal(result.pnthRouter, null);
  assert.equal(result.covenantFactory, null);
  assert.equal(manifest.pnth, null);
});
test("rejects missing receipts and wrong chain before any RPC call", async () => {
  const { artifact } = fixture();
  const noRpc = () => { throw new Error("must not query RPC"); };
  await assert.rejects(importDeployment({ ...artifact, receipts: [] }, manifest, noRpc), /mined receipts/);
  await assert.rejects(importDeployment({ ...artifact, chain: 99801 }, manifest, noRpc), /99901/);
});
test("rejects failed/unconfirmed receipts, different logs, empty code and an existing different deployment", async () => {
  const f = fixture();
  f.liveReceipts[0].status = "0x0";
  await assert.rejects(importDeployment(f.artifact, manifest, f.rpc), /not confirmed/);
  const g = fixture();
  g.artifact.receipts[4].logs[0].address = addr(99);
  await assert.rejects(importDeployment(g.artifact, manifest, g.rpc), /logs differ/);
  const h = fixture();
  await assert.rejects(importDeployment(h.artifact, manifest, async (m, p) => m === "eth_getCode" ? "0x" : h.rpc(m, p)), /no deployed code/);
  await assert.rejects(importDeployment(h.artifact, { ...manifest, pnth: addr(99) }, h.rpc), /overwrite/);
});
