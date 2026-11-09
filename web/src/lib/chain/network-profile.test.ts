import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const { validateDeployment, ascendBuyUrl } = await import(new URL("./network-profile.ts", import.meta.url).href) as typeof import("./network-profile");
const testnet = JSON.parse(readFileSync(new URL("../../../../deployments/elysium-testnet.json", import.meta.url), "utf8"));
const mainnet = JSON.parse(readFileSync(new URL("../../../../deployments/elysium-mainnet.json", import.meta.url), "utf8"));
const filled = () => ({ ...structuredClone(testnet), pnthRouter: null, covenantFactory: null, creatorSeat: testnet.pnthRouter, creatorEscrow: testnet.covenantFactory, chainId: 99901, network: { ...structuredClone(testnet.network), chainId: 99901, testnet: false, name: "Elysium", publicRpc: "https://rpc.mainnet.invalid", explorerUrl: "https://explorer.mainnet.invalid", deployedFrom: 0, acquireUrl: "https://ascend.mainnet.invalid/pnth" } });

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
test("mainnet buy links target the deployed PNTH token and seats replace Covenants", () => {
  const p = filled();
  assert.equal(ascendBuyUrl(p.pnth), `https://app.ascendlaunch.xyz/tokens/${p.pnth}`);
  assert.throws(() => ascendBuyUrl("" as `0x${string}`), /token address/);
  assert.throws(() => ascendBuyUrl("0x0000000000000000000000000000000000000000"), /token address/);
  assert.doesNotThrow(() => validateDeployment("elysium-mainnet", p));
  assert.throws(() => validateDeployment("elysium-mainnet", { ...p, creatorSeat: null }), /creatorSeat/);
});
test("partially published mainnet reports the remaining missing fields together", () => {
  const partial = structuredClone(mainnet);
  for (const key of ["passportRegistry", "pnth", "staking"]) partial[key] = null;
  partial.network.explorerUrl = null;
  partial.network.deployedFrom = null;
  partial.network.acquireUrl = null;
  assert.throws(() => validateDeployment("elysium-mainnet", partial), (error: unknown) => {
    assert.match(String(error), /missing required fields:.*passportRegistry.*network.explorerUrl.*network.deployedFrom.*network.acquireUrl/);
    assert.doesNotMatch(String(error), /network.publicRpc|network.external.multicall3/);
    return true;
  });
});
test("published mainnet profile binds the confirmed PNTH deployment and explorer", () => {
  assert.equal(mainnet.launchpad, "0xe0dEF4221b9840a610D4e7d55812a79A6431a8eC");
  assert.equal(mainnet.usdc, mainnet.network.external.usdc);
  assert.equal(mainnet.launchpad, mainnet.network.external.ascendLaunchpad);
  assert.equal(mainnet.network.external.ascendRouter, "0x1B341FDD55d56F8E08409A2C25DDFad93Eb03C1a");
  assert.equal(mainnet.network.external.ascend.escrowFactory, "0x63f6a8A8d0257c0363251a50cdE8A8b1046e4d19");
  assert.equal(mainnet.network.ascendFromBlock, 422319);
  assert.equal(mainnet.network.deployedFrom, 3263982);
  assert.equal(mainnet.pnth, "0x660A22496A4eC7BCB5F6d6c0E3B8aA2550372A45");
  assert.equal(mainnet.network.explorerUrl, "https://elysium.kinetiq.xyz");
  assert.doesNotThrow(() => validateDeployment("elysium-mainnet", mainnet));
  assert.equal(mainnet.network.external.kalos.factory, null);
  assert.equal(mainnet.network.external.perpme.launchFactory, null);
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
