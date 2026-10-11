import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { BIND_HOST, ConfigError, HYPEREVM, loadConfig, STAMP, STAMP_MASK, TIERS } from "../src/config.ts";

describe("loadConfig", () => {
  it("applies the spec defaults (§7) to an empty environment", () => {
    const c = loadConfig({});
    expect(c.chainId).toBe(99801);
    expect(c.elysiumRpc).toBe("https://testnet-rpc.elysium.kinetiq.xyz");
    expect(c.hyperEvmRpc).toBe("https://rpc.hyperliquid.xyz/evm");
    expect(c.hlInfoUrl).toBe("https://api.hyperliquid.xyz/info");
    expect(c.registryAddress).toBeUndefined();
    expect(c.hlWeightPerMin).toBe(800);
    expect(c.evmReqPerMin).toBe(60);
    expect(c.port).toBe(8787);
    expect(c.host).toBe("127.0.0.1");
    expect(Object.isFrozen(c)).toBe(true);
  });

  it("coerces numbers and checksums the registry address", () => {
    const c = loadConfig({ PORT: "9000", HL_WEIGHT_PER_MIN: "400", REGISTRY_ADDRESS: "0x5615deb798bb3e4dfa0139dfa1b3d433cc23b72f" });
    expect(c.port).toBe(9000);
    expect(c.hlWeightPerMin).toBe(400);
    expect(c.registryAddress).toBe("0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f");
  });

  it("accepts plain-http loopback URLs for local mocks", () => {
    expect(loadConfig({ HL_INFO_URL: "http://127.0.0.1:9999/info" }).hlInfoUrl).toBe("http://127.0.0.1:9999/info");
  });

  it("treats empty values as unset", () => {
    expect(loadConfig({ REGISTRY_ADDRESS: "", PORT: "" }).port).toBe(8787);
  });

  it.each([
    ["PORT", "abc"],
    ["PORT", "70000"],
    ["CHAIN_ID", "-1"],
    ["REGISTRY_ADDRESS", "0x1234"],
    ["HL_INFO_URL", "not a url"],
    ["HL_INFO_URL", "javascript:alert(1)"],
    ["ELYSIUM_RPC", "file:///etc/passwd"],
    ["PORT", "1e3"],
    ["PORT", "0x10"],
    ["HL_WEIGHT_PER_MIN", "8.5"],
  ])("rejects %s=%s", (key, value) => {
    expect(() => loadConfig({ [key]: value })).toThrow(ConfigError);
  });

  it("refuses a raw key where a key-file path belongs, without echoing it", () => {
    const fakeKey = `0x${"ab".repeat(32)}`;
    for (const key of ["ATTESTOR_KEY_FILE", "RELAYER_KEY_FILE", "PEPPER_FILE"]) {
      let message = "";
      try {
        loadConfig({ [key]: fakeKey });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toContain(key);
      expect(message).not.toContain("abab");
    }
  });

  it("never binds beyond loopback", () => {
    expect(loadConfig({ HOST: "0.0.0.0" }).host).toBe(BIND_HOST);
  });
});

describe("constants", () => {
  it("stores HyperEVM addresses in checksum form", () => {
    for (const a of Object.values(HYPEREVM)) expect(a).toBe(getAddress(a));
  });

  it("uses one distinct bit per stamp, all inside bits 0–7", () => {
    const bits = Object.values(STAMP);
    expect(new Set(bits).size).toBe(bits.length);
    for (const b of bits) {
      expect(b & (b - 1)).toBe(0);
      expect(b & ~STAMP_MASK).toBe(0);
    }
  });

  it("orders tiers by index with rising thresholds", () => {
    TIERS.forEach((t, i) => expect(t.tier).toBe(i));
    for (let i = 1; i < TIERS.length; i++) {
      expect(TIERS[i]!.minScoreE8 > TIERS[i - 1]!.minScoreE8).toBe(true);
      expect(TIERS[i]!.minAgeDays >= TIERS[i - 1]!.minAgeDays).toBe(true);
    }
  });
});
