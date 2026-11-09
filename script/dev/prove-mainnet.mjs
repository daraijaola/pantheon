#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";

// Public, disposable fixture key 1. Never supply a real key to this proof.
const key = `0x${"0".repeat(63)}1`;
const account = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
const rpc = "http://127.0.0.1:18545";
const canonical = "deployments/elysium-mainnet.json";
const fixture = "deployments/local-mainnet-proof.json";
const original = readFileSync(canonical);
const localFixture = Buffer.from(JSON.stringify({ ...JSON.parse(original), launchpad: null }));
const env = { ...process.env, ETH_RPC_URL: rpc, FOUNDRY_ETH_RPC_URL: rpc, DEPLOYER_KEY: key, DEPLOYER_ADDRESS: account, TEAM: account, CURATOR: account, GUARDIAN: account, ATTESTOR: account, TEAM_BPS: "1500", EXPECTED_NONCE: "0", MIN_DEPLOYER_BALANCE_WEI: "10000000000000000", DEPLOYMENT_FILE: fixture, LAUNCHPAD: "0x0000000000000000000000000000000000001002", USDC: "0x0000000000000000000000000000000000001001", BURN_SINK: "0x0000000000000000000000000000000000001005", WRITE_DEPLOYMENT: "false" };
let id = 0;
async function call(method, params) {
  const response = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
  const body = await response.json();
  assert.equal(body.error, undefined, method);
  return body.result;
}
function run(command, args, overrides = {}, success = true) {
  const result = spawnSync(command, args, { env: { ...env, ...overrides }, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  const output = `${result.stdout || ""}${result.stderr || ""}`.split(key).join("[PUBLIC FIXTURE KEY]");
  if (success) assert.equal(result.status, 0, output);
  else assert.notEqual(result.status, 0, "expected failure");
  return output;
}
assert(!existsSync(fixture), "remove an old proof fixture deliberately before rerunning");
assert.equal(Number(await call("eth_chainId", [])), 99901);
writeFileSync(fixture, localFixture);
try {
  for (const [address, contract] of [["0x1001", "DeployDependencyMock"], ["0x1002", "DeployLaunchpadMock"], ["0x1003", "DeployDependencyMock"], ["0x1004", "DeployDependencyMock"], ["0x1005", "DeployDependencyMock"]]) {
    const code = run("forge", ["inspect", `test/unit/Deploy.t.sol:${contract}`, "deployedBytecode"]).trim();
    await call("anvil_setCode", [`0x${address.slice(2).padStart(40, "0")}`, code]);
  }
  const externalCode = run("forge", ["inspect", "test/unit/Deploy.t.sol:DeployDependencyMock", "deployedBytecode"]).trim();
  const external = JSON.stringify(JSON.parse(localFixture).network.external);
  for (const address of new Set(external.match(/0x[0-9a-fA-F]{40}/g) ?? [])) {
    await call("anvil_setCode", [address, externalCode]);
  }
  await call("anvil_setBalance", [account, "0x56bc75e2d63100000"]);
  assert.equal(await call("eth_getTransactionCount", [account, "latest"]), "0x0");
  console.log(run("node", ["script/preflight-mainnet.mjs"]));
  const warning = run("node", ["script/preflight-mainnet.mjs"], { EXPECTED_NONCE: "1" });
  assert(warning.includes("WARNING: nonce differs"));
  console.log("PASS unexpected preflight nonce produces an explicit warning");
  const badKey = run("node", ["script/preflight-mainnet.mjs"], { DEPLOYER_ADDRESS: "0x0000000000000000000000000000000000001234" }, false);
  assert(badKey.includes("deployer does not match"));
  console.log("PASS preflight rejects mismatched deployer/key");
  const missing = run("forge", ["script", "script/Deploy.s.sol:Deploy", "-vvvv"], { LAUNCHPAD: "0x0000000000000000000000000000000000000000", WRITE_DEPLOYMENT: "true" }, false);
  assert(missing.includes("missing LAUNCHPAD / manifest.launchpad"));
  assert(!missing.includes("startBroadcast("), "failure must precede transaction recording");
  assert.deepEqual(readFileSync(fixture), localFixture);
  console.log("PASS missing LAUNCHPAD reverts before startBroadcast; manifest unchanged");
  const output = run("forge", ["script", "script/Deploy.s.sol:Deploy"], { WRITE_DEPLOYMENT: "true" });
  console.log(output);
  const deployed = JSON.parse(readFileSync(fixture, "utf8"));
  const previous = JSON.parse(original);
  assert.deepEqual(deployed.network, previous.network);
  for (const field of ["passportRegistry", "covenantFactory", "pnth", "pnthRouter", "constituentRegistry", "staking", "indexVault"]) assert.match(deployed[field], /^0x[0-9a-fA-F]{40}$/);
  assert.equal(deployed.chainId, 99901);
  assert.equal(deployed.teamBps, 1500);
  assert.equal(deployed.team.toLowerCase(), account.toLowerCase());
  assert.equal(await call("eth_getTransactionCount", [account, "latest"]), "0x0");
  assert.deepEqual(readFileSync(canonical), original);
  console.log("PASS full chain-99901 deployment simulation, creator handoff and nonce-predicted vault");
  console.log("PASS manifest contract fields written; network block preserved exactly");
  console.log("PASS no transactions broadcast; Anvil deployer nonce remains 0; canonical manifest unchanged");
} finally {
  unlinkSync(fixture);
}
