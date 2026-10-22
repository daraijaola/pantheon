import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, readKeeperKey } from "../src/config.ts";
import { loadState, saveState } from "../src/state.ts";
import { DEP } from "./fakes.ts";

const deploymentFile = (body: unknown) => () => JSON.stringify(body);

describe("loadConfig", () => {
  it("defaults to practice mode every 5 minutes, with the live deployment's addresses", () => {
    const c = loadConfig({}, deploymentFile({ ...DEP, pnthPool: "0x01", extra: true }));
    expect(c).toMatchObject({ mode: "dry", intervalSec: 300, basketK: 5, pokeRiseBps: 200, pokeBatch: 20, passportApi: "http://127.0.0.1:8787" });
    expect(c.deployment.pnthRouter).toBe(DEP.pnthRouter);
    expect(Object.isFrozen(c)).toBe(true);
  });

  it("stops at start on a bad setting or a bad deployment file", () => {
    expect(() => loadConfig({ KEEPER_MODE: "yolo" }, deploymentFile(DEP))).toThrow(ConfigError);
    expect(() => loadConfig({ INTERVAL_SEC: "5" }, deploymentFile(DEP))).toThrow(/INTERVAL_SEC/);
    expect(() => loadConfig({}, deploymentFile({ ...DEP, staking: "0x123" }))).toThrow(/staking/);
    expect(() => loadConfig({}, deploymentFile({ ...DEP, chainId: 1 }))).toThrow(/chainId/);
    expect(() => loadConfig({}, () => { throw new Error("ENOENT"); })).toThrow(/cannot read DEPLOYMENT_FILE/);
  });
});

describe("readKeeperKey", () => {
  const dir = mkdtempSync(join(tmpdir(), "keeper-"));
  const write = (name: string, body: string, mode: number) => {
    const p = join(dir, name);
    writeFileSync(p, body);
    chmodSync(p, mode);
    return p;
  };
  // anvil's first public test key: never holds anything real.
  const ANVIL = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

  it("reads a key only its owner can read", () => {
    expect(readKeeperKey(write("ok.key", `${ANVIL}\n`, 0o600))).toBe(`0x${ANVIL}`);
  });

  it("refuses a key others can read, or a file that isn't a key", () => {
    expect(() => readKeeperKey(write("loose.key", ANVIL, 0o644))).toThrow(/mode 644/);
    expect(() => readKeeperKey(write("junk.key", "hello", 0o600))).toThrow(/32 bytes/);
  });
});

describe("state", () => {
  const dir = mkdtempSync(join(tmpdir(), "keeper-state-"));

  it("starts fresh, then round-trips", () => {
    const p = join(dir, "sub", "state.json");
    const s = loadState(p, 9_127_000n);
    expect(s).toEqual({ stakedCursor: "9127000", stakers: [], sweep: 0, pokesSince: 0 });
    saveState(p, { ...s, stakers: ["0x155224663abe76b427f07ebf34b57cc920c47e9e"], sweep: 1 });
    expect(loadState(p, 0n).stakers).toEqual(["0x155224663abE76b427F07EbF34B57cC920C47E9e"]);
  });

  it("refuses a damaged state rather than starting over silently", () => {
    const p = join(dir, "bad.json");
    writeFileSync(p, JSON.stringify({ stakedCursor: "x", stakers: [], sweep: 0, pokesSince: 0 }));
    expect(() => loadState(p, 0n)).toThrow(/damaged/);
  });
});
