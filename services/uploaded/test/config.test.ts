import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig as realLoad } from "../src/config.ts";

const A = "0x" + "a".repeat(40);
const FILE = JSON.stringify({ staking: A, passportRegistry: A, pnth: A, usdc: A });
const loadConfig = (env: Record<string, string | undefined>) => realLoad(env, () => FILE);

describe("settings", () => {
  it("can switch fresh reads off", () => {
    expect(loadConfig({ FRESH_READS: "off" }).freshReads).toBe(false);
  });

  it("has safe defaults", () => {
    expect(loadConfig({})).toEqual({ port: 8791, rpc: "https://testnet-rpc.elysium.kinetiq.xyz", archiveRpc: "https://test-explorer.elysium.kinetiq.xyz/rpc", deployment: { staking: A, passportRegistry: A, pnth: A, usdc: A }, indexerUrl: "http://127.0.0.1:8789", trialsUrl: "http://127.0.0.1:8790", scanFile: "../delphi/out/scan.json", refreshSec: 60, delphiDir: "../delphi", freshReads: true, freshGapSec: 300, guardReadSec: 900, guardFile: "data/guard.json" });
  });

  it("treats an empty value as not set", () => {
    expect(loadConfig({ PORT: "" }).port).toBe(8791);
  });

  it("stops at start if the contracts file is missing or wrong", () => {
    expect(() => realLoad({}, () => "{}")).toThrow(ConfigError);
    expect(() => realLoad({}, () => "not json")).toThrow(ConfigError);
    expect(() =>
      realLoad({}, () => {
        throw new Error("no such file");
      }),
    ).toThrow(/no such file/);
  });

  it("stops at start on a wrong value, and says which", () => {
    expect(() => loadConfig({ PORT: "abc" })).toThrow(ConfigError);
    expect(() => loadConfig({ PORT: "abc" })).toThrow(/PORT/);
    expect(() => loadConfig({ PORT: "80" })).toThrow(/PORT/);
    expect(() => loadConfig({ REFRESH_SEC: "1" })).toThrow(/REFRESH_SEC/);
    expect(() => loadConfig({ FRESH_READS: "maybe" })).toThrow(/FRESH_READS/);
    expect(() => loadConfig({ FRESH_GAP_SEC: "5" })).toThrow(/FRESH_GAP_SEC/);
  });
});
