import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.ts";

describe("settings", () => {
  it("can switch fresh reads off", () => {
    expect(loadConfig({ FRESH_READS: "off" }).freshReads).toBe(false);
  });

  it("has safe defaults", () => {
    expect(loadConfig({})).toEqual({ port: 8791, rpc: "https://testnet-rpc.elysium.kinetiq.xyz", archiveRpc: "https://test-explorer.elysium.kinetiq.xyz/rpc", scanFile: "../delphi/out/scan.json", refreshSec: 60, delphiDir: "../delphi", freshReads: true, freshGapSec: 300 });
  });

  it("treats an empty value as not set", () => {
    expect(loadConfig({ PORT: "" }).port).toBe(8791);
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
