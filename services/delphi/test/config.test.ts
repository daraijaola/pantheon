import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.ts";

describe("loadConfig", () => {
  it("works with no settings at all (public testnet defaults)", () => {
    const c = loadConfig({});
    expect(c.elysiumRpc).toBe("https://testnet-rpc.elysium.kinetiq.xyz");
    expect(c.launchpad).toBe("0xE2f6254508DEB93Da081837F545e0bAF7b00d8E9");
    expect(c.fromBlock).toBe(3_574_000n);
    expect(Object.isFrozen(c)).toBe(true);
  });

  it("treats empty values as unset and normalises addresses and links", () => {
    const c = loadConfig({
      ELYSIUM_RPC: "",
      LAUNCHPAD: "0xe2f6254508deb93da081837f545e0baf7b00d8e9",
      EXPLORER_WEB: "https://x.test/explorer/",
    });
    expect(c.elysiumRpc).toBe("https://testnet-rpc.elysium.kinetiq.xyz");
    expect(c.launchpad).toBe("0xE2f6254508DEB93Da081837F545e0bAF7b00d8E9");
    expect(c.explorerWeb).toBe("https://x.test/explorer");
  });

  it("picks the rule profile from the chain settings, unless told", () => {
    expect(loadConfig({}).network).toBe("testnet");
    const main = { ELYSIUM_RPC: "https://rpc.elysium.test", EXPLORER_WEB: "https://elysium.test/explorer" };
    expect(loadConfig(main).network).toBe("mainnet");
    expect(loadConfig({ NETWORK: "mainnet" }).network).toBe("mainnet");
    expect(loadConfig({ ...main, NETWORK: "testnet" }).network).toBe("testnet");
    expect(() => loadConfig({ NETWORK: "devnet" })).toThrow(/NETWORK/);
  });

  it("stops at start on a bad value", () => {
    expect(() => loadConfig({ LAUNCHPAD: "0x1234" })).toThrow(ConfigError);
    expect(() => loadConfig({ FROM_BLOCK: "-5" })).toThrow(/FROM_BLOCK/);
    expect(() => loadConfig({ ELYSIUM_RPC: "ftp://rpc.test" })).toThrow(/ELYSIUM_RPC/);
  });
});
