import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const { validateDeployment } = await import(new URL("./network-profile.ts", import.meta.url).href) as typeof import("./network-profile");
const testnet = JSON.parse(readFileSync(new URL("../../../../deployments/elysium-testnet.json", import.meta.url), "utf8"));
const mainnet = JSON.parse(readFileSync(new URL("../../../../deployments/elysium-mainnet.json", import.meta.url), "utf8"));
const filled = () => ({ ...structuredClone(testnet), chainId: 99901, network: { ...structuredClone(testnet.network), chainId: 99901, testnet: false, name: "Elysium", publicRpc: "https://rpc.mainnet.invalid", explorerUrl: "https://explorer.mainnet.invalid", deployedFrom: 0, acquireUrl: "https://ascend.mainnet.invalid/pnth" } });

test("canonical testnet manifest preserves the production chain, addresses and start", () => {
  const value = validateDeployment("elysium-testnet", testnet);
  assert.equal(value.network.chainId, 99801);
  assert.equal(value.network.deployedFrom, 9127000);
  assert.equal(value.swapper, "0x31A67d054D34Ec18cb23A43B0E3ad1F756aA1500");
  assert.equal(value.network.testnet, true);
});
test("filled mainnet is accepted without using any testnet network fallback", () => {
  const value = validateDeployment("elysium-mainnet", filled());
  assert.equal(value.chainId, 99901);
  assert.equal(value.network.testnet, false);
  assert.equal(value.network.publicRpc, "https://rpc.mainnet.invalid");
  assert.equal(value.network.deployedFrom, 0);
});
test("null mainnet reports all missing fields together", () => {
  assert.throws(() => validateDeployment("elysium-mainnet", mainnet), (error: unknown) => {
    assert.match(String(error), /missing required fields:.*passportRegistry.*network.publicRpc.*network.explorerUrl.*network.deployedFrom.*network.external.multicall3.*network.acquireUrl/);
    return true;
  });
});
test("unknown and empty deployments fail closed", () => {
  assert.throws(() => validateDeployment("typo", undefined), /unknown deployment/);
  assert.throws(() => validateDeployment("elysium-mainnet", {}), /missing required fields/);
});
test("mismatched chain, address, public URL and start block fail with field names", () => {
  for (const mutate of [
    (v: ReturnType<typeof filled>) => { v.network.chainId = 99801; },
    (v: ReturnType<typeof filled>) => { v.network.external.usdc = "bad"; },
    (v: ReturnType<typeof filled>) => { v.network.publicRpc = "https://elysium-mainnet.g.alchemy.com/v2/never-a-real-key"; },
    (v: ReturnType<typeof filled>) => { v.network.deployedFrom = -1; },
    (v: ReturnType<typeof filled>) => { v.network.acquireUrl = "javascript:alert(1)"; },
  ]) {
    const value = filled(); mutate(value);
    assert.throws(() => validateDeployment("elysium-mainnet", value), /invalid fields:/);
  }
});
