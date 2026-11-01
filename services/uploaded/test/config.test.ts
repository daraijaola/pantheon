import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.ts";

describe("settings", () => {
  it("has safe defaults", () => {
    expect(loadConfig({})).toEqual({ port: 8791, scanFile: "../delphi/out/scan.json", refreshSec: 60 });
  });

  it("treats an empty value as not set", () => {
    expect(loadConfig({ PORT: "" }).port).toBe(8791);
  });

  it("stops at start on a wrong value, and says which", () => {
    expect(() => loadConfig({ PORT: "abc" })).toThrow(ConfigError);
    expect(() => loadConfig({ PORT: "abc" })).toThrow(/PORT/);
    expect(() => loadConfig({ PORT: "80" })).toThrow(/PORT/);
    expect(() => loadConfig({ REFRESH_SEC: "1" })).toThrow(/REFRESH_SEC/);
  });
});
