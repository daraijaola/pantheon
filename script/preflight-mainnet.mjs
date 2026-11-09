#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const env = process.env;
const rpc = env.ETH_RPC_URL || env.ELYSIUM_RPC;
const file = env.DEPLOYMENT_FILE || "deployments/elysium-mainnet.json";
let requestId = 0;
async function call(method, params) {
  try {
    const response = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }), signal: AbortSignal.timeout(15000) });
    const body = await response.json();
    if (!response.ok || body.error || body.result === undefined) throw new Error();
    return body.result;
  } catch { throw new Error(`RPC ${method} failed (provider details redacted)`); }
}
try {
  if (!rpc || !/^https?:\/\//.test(rpc)) throw new Error("ETH_RPC_URL or ELYSIUM_RPC is required");
  if (!/^0x[0-9a-fA-F]{64}$/.test(env.DEPLOYER_KEY || "")) throw new Error("DEPLOYER_KEY must be a 32-byte key supplied through the environment");
  if (Number(await call("eth_chainId", [])) !== 99901) throw new Error("RPC chainId must be 99901");
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  if (manifest.chainId !== 99901 || manifest.network?.chainId !== 99901) throw new Error("manifest chainId must be 99901");
  const addresses = new Map();
  function visit(value, path) {
    if (typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)) addresses.set(path, value);
    else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) visit(item, `${path}.${key}`);
  }
  visit(manifest.network.external, "network.external");
  for (const [name, key] of [["LAUNCHPAD", "launchpad"], ["USDC", "usdc"], ["BURN_SINK", "burnSink"]]) {
    const value = env[name] || manifest[key];
    if (!value || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`missing or invalid ${name} / manifest.${key}`);
    addresses.set(key, value);
  }
  for (const [path, address] of addresses) {
    if (await call("eth_getCode", [address, "latest"]) === "0x") throw new Error(`${path} has no code`);
    console.log(`CODE OK ${path} ${address}`);
  }
  console.log("Only populated external fields are code-checked; unpublished venue fields do not authorize service cutover.");
  const result = spawnSync("forge", ["script", "script/Deploy.s.sol:Deploy", "--sig", "preflight()"], { env: { ...env, FOUNDRY_ETH_RPC_URL: rpc, WRITE_DEPLOYMENT: "false" }, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const clean = value => String(value || "").split(rpc).join("[RPC]").split(env.DEPLOYER_KEY).join("[KEY]");
  process.stdout.write(clean(result.stdout));
  process.stderr.write(clean(result.stderr));
  if (result.error || result.status !== 0) throw new Error("Solidity deployment preflight failed");
  console.log("PASS read-only mainnet preflight; no broadcast and no manifest writes");
} catch (error) {
  console.error(`Preflight: ${error.message}`);
  process.exitCode = 1;
}
