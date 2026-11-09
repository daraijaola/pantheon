import { describe, expect, it } from "vitest";
import testnet from "../../../deployments/elysium-testnet.json" with { type: "json" };
import mainnet from "../../../deployments/elysium-mainnet.json" with { type: "json" };
import { assertRpcChain, backendEnv, deploymentName, profile, statePath, type Service } from "../../network.mts";

const filled = () => ({ ...structuredClone(testnet), creatorSeat: testnet.pnthRouter, creatorEscrow: testnet.covenantFactory, chainId: mainnet.chainId, network: { ...structuredClone(testnet.network), external: { ...structuredClone(testnet.network.external), ascend: mainnet.network.external.ascend }, chainId: mainnet.chainId, testnet: false, name: "Mainnet fixture", publicRpc: "http://127.0.0.1:19999", explorerUrl: "https://mainnet.invalid" } });
const services: Service[] = ["indexer", "keeper", "passport", "trials", "uploaded", "delphi", "feed", "x"];

describe("canonical backend networks", () => {
  it("keeps the existing testnet metadata and legacy paths by default", () => {
    expect(profile()).toEqual(testnet);
    expect(backendEnv({}, "indexer").FROM_BLOCK).toBe(String(testnet.network.deployedFrom));
    expect(backendEnv({}, "delphi").FROM_BLOCK).toBe(String(testnet.network.ascendFromBlock));
    expect(statePath("data/state.json", {})).toBe("data/state.json");
    expect(backendEnv({}, "passport").REGISTRY_ADDRESS).toBeUndefined();
  });

  it("accepts aliases and rejects conflicting or unknown selectors", () => {
    expect(deploymentName({ NETWORK: "mainnet" })).toBe("elysium-mainnet");
    expect(deploymentName({ DEPLOYMENT: "elysium-mainnet" })).toBe("elysium-mainnet");
    expect(deploymentName({ DEPLOYMENT_FILE: "../../deployments/elysium-mainnet.json" })).toBe("elysium-mainnet");
    expect(() => deploymentName({ NETWORK: "devnet" })).toThrow(/selection/);
    expect(() => deploymentName({ NETWORK: "mainnet", DEPLOYMENT: "elysium-testnet" })).toThrow(/conflicting/);
  });

  it.each(services)("%s rejects the incomplete mainnet with field names", service => {
    expect(() => backendEnv({ NETWORK: "mainnet" }, service)).toThrow(/Network profile elysium-mainnet: missing required fields:.*network.explorerUrl/);
  });

  it.each(services)("%s accepts a filled mainnet without testnet state or upstream defaults", service => {
    const e = backendEnv({ NETWORK: "mainnet", INDEXER_URL: "http://127.0.0.1:19998", TRIALS_URL: "http://127.0.0.1:19997", PASSPORT_API: "http://127.0.0.1:19996", STATE_FILE: "/shared/state.json", DB_PATH: "/shared/state.db" }, service, filled());
    expect(e.CHAIN_ID).toBe(String(mainnet.chainId));
    expect(e.ELYSIUM_RPC).toBe("http://127.0.0.1:19999");
    for (const key of ["STATE_FILE", "DB_PATH", "OUT_DIR", "SCAN_FILE", "ROUNDS_DIR", "FEED_DB", "DISPUTE_LOG", "GUARD_FILE", "X_STATE", "X_DRAFTS"]) expect(e[key]).toContain("elysium-mainnet");
    expect(e.STATE_FILE).toBe("/shared/elysium-mainnet/state.json");
  });

  it("rejects cross-network paths and never double-namespaces a path", () => {
    expect(() => statePath("/state/elysium-testnet/index.json", { NETWORK: "mainnet" })).toThrow(/another network/);
    expect(() => statePath("/state/elysium-mainnet/index.json", {})).toThrow(/another network/);
    expect(statePath("/state/elysium-mainnet/index.json", { NETWORK: "mainnet" })).toBe("/state/elysium-mainnet/index.json");
  });

  it("allows absent legacy PerpMe deployments without inventing mainnet addresses", () => {
    const p = filled();
    const input = { ...p, network: { ...p.network, external: { ...p.network.external, perpme: { ...p.network.external.perpme, oldLaunchFactory: null, oldLocker: null } } } };
    expect(profile({ NETWORK: "mainnet" }, "delphi", input).network.external.perpme.oldLaunchFactory).toBeNull();
  });

  it("checks mainnet RPC identity without changing testnet startup or leaking provider errors", async () => {
    const selected = profile({ NETWORK: "mainnet" }, "feed", filled());
    let calls = 0;
    const client = { getChainId: async () => { calls++; return mainnet.chainId; } };
    await assertRpcChain(client, profile());
    expect(calls).toBe(0);
    await assertRpcChain(client, selected);
    expect(calls).toBe(1);
    await expect(assertRpcChain({ getChainId: async () => testnet.chainId }, selected)).rejects.toThrow(/RPC chainId mismatch/);
    await expect(assertRpcChain({ getChainId: async () => { throw new Error("private provider details"); } }, selected)).rejects.toThrow("Network profile elysium-mainnet: RPC chainId verification failed");
  });

  it("rejects chain mismatches, invalid addresses/URLs and missing nested venue fields", () => {
    const p = filled();
    expect(() => profile({ NETWORK: "mainnet", CHAIN_ID: String(testnet.chainId) }, "indexer", p)).toThrow(/CHAIN_ID/);
    expect(() => profile({ NETWORK: "mainnet", ELYSIUM_RPC: "file:///bad" }, "indexer", p)).toThrow(/ELYSIUM_RPC/);
    expect(() => profile({ NETWORK: "mainnet", REGISTRY_ADDRESS: "bad" }, "passport", p)).toThrow(/passportRegistry/);
    const ascendOnly = profile({ NETWORK: "mainnet" }, "delphi", { ...p, network: { ...p.network, external: mainnet.network.external } });
    expect(ascendOnly.network.external.kalos.factory).toBeNull();
    expect(ascendOnly.network.external.perpme.launchFactory).toBeNull();
    expect(() => backendEnv({ NETWORK: "mainnet" }, "keeper", p)).toThrow(/PASSPORT_API/);
    expect(() => backendEnv({ NETWORK: "mainnet" }, "uploaded", p)).toThrow(/INDEXER_URL/);
  });
});
