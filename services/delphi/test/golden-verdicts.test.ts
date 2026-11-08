import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { balances } from "../src/detect.ts";
import { groupsOf } from "../src/graph.ts";
import { analyze, verdictOf } from "../src/report.ts";
import { current, detectors, digest, fixture, inputHash, regressionMessage, version, type Baseline } from "./golden/baseline.ts";
import { inputs, NOW } from "./golden/inputs.ts";
import { acceptRules } from "./golden/rebaseline.ts";
import { addr, hash, scenario, ZERO, ROUTER, VAULT } from "./scenario.ts";

const options = { explorerWeb: "https://test-explorer.elysium.kinetiq.xyz", now: NOW };
const cases = inputs();
const approved = new URL(`${version()}.json`, fixture);
if (!existsSync(approved)) throw new Error(`No approved golden baseline for ${version()}. Review changes against the previous version, then run node test/golden/rebaseline.ts --accept-rules ${version()} --reason "reviewed explanation". Never overwrite an older version.`);
const baselineText = readFileSync(approved, "utf8");
const baseline = JSON.parse(baselineText) as Baseline;

describe("recorded raw-input verdict goldens", () => {
  it("pins input bytes and the immutable approved rules baseline", () => {
    const ledger = JSON.parse(readFileSync(new URL("ledger.json", fixture), "utf8")) as Record<string, string>;
    expect(baseline.rules).toBe(version());
    expect(digest(baselineText), "Approved baseline changed under the same rules version. Bump RULES.version, then use test/golden/rebaseline.ts; never edit old ledger entries.").toBe(ledger[version()]);
    expect(inputHash(), "Raw inputs changed: do not silently replace recorded evidence; review and version the new baseline.").toBe(baseline.inputHash);
    expect(new Set(cases.map(c => c.id)).size).toBe(cases.length);
  });

  it("keeps verdicts, each detector, shares and counts unchanged without a rules bump", () => {
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Golden suite must never use RPC or HTTP"); });
    try {
      expect(regressionMessage(baseline, current())).toBe("");
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });

  it("requires a new version to deliberately rebaseline, with an actionable changed-coin list", () => {
    expect(() => acceptRules(version(), "reviewed", true)).toThrow(/Refusing to overwrite.*bump RULES.version/);
    expect(() => acceptRules("wrong", "reviewed", false)).toThrow(/--accept-rules/);
    expect(() => acceptRules(version(), "", false)).toThrow(/--reason/);
    expect(() => acceptRules(version(), "reviewed", false)).not.toThrow();
    const id = Object.keys(baseline.coins)[0]!;
    const altered = structuredClone(baseline.coins);
    altered[id]!.verdict = altered[id]!.verdict === "FLAG" ? "CLEAN" : "FLAG";
    const message = regressionMessage(baseline, altered);
    expect(message).toContain(id);
    expect(message).toContain("verdict:");
    expect(message).toContain("bump RULES.version");
    expect(message).toContain("node test/golden/rebaseline.ts --accept-rules");
  });
});

describe("detector invariants (recorded inputs)", () => {
  for (const input of cases) {
    it(`${input.id}: funding gaps and insufficient observations never become CLEAN`, () => {
      expect(analyze({ ...input.data, fundingMissing: 1 }, options).verdict).not.toBe("CLEAN");
      expect(analyze({ ...input.data, trades: [], transfers: [], links: [], holdings: new Map() }, options).verdict).toBe("NOT_ENOUGH_DATA");
    });
    it(`${input.id}: FLAG dominates; system addresses are not holders or cluster members`, () => {
      const d = input.data;
      const results = Object.values(detectors).map(run => run(d));
      if (results.some(r => r.finding?.severity === "flag")) {
        expect(verdictOf(results)).toBe("FLAG");
        expect(analyze(d, options).verdict).toBe("FLAG");
      }
      for (const w of balances(d).keys()) expect(d.system.has(w), `system holder ${w}`).toBe(false);
      for (const g of groupsOf(d.links)) for (const w of g.members) expect(d.system.has(w), `system cluster member ${w}`).toBe(false);
    });
  }
});

describe("invariants (explicit synthetic scenarios, not recorded observations)", () => {
  it("every FLAG position dominates WATCH, missing and clear detectors", () => {
    for (let index = 0; index < 3; index++) {
      const results = Array.from({ length: 3 }, (_, i) => ({ enough: i !== 1, finding: i === index
        ? { detector: "bundle" as const, severity: "flag" as const, summary: "scenario", metrics: {}, evidence: [] }
        : i === 2 ? { detector: "wash" as const, severity: "watch" as const, summary: "scenario", metrics: {}, evidence: [] } : null }));
      expect(verdictOf(results)).toBe("FLAG");
    }
  });

  it("pools, routers, burns and contracts do not become holders or link innocent wallets", () => {
    const pool = addr(0x991), contract = addr(0x992), burn = addr(0xdead);
    const infrastructure = [pool, ROUTER, burn, ZERO, VAULT, contract];
    const s = scenario();
    for (const w of infrastructure) {
      s.buy(w, 30, 1).fund(w, addr(0xf00)).fund(addr(0x200), w).fund(addr(0x201), w);
      s.transfers.push({ tx: hash(999), block: 1001n, logIndex: 9, from: w, to: addr(0x200), value: 1n });
    }
    s.buy(addr(0x200), 1, 1000).buy(addr(0x201), 1, 2000);
    const d = s.build(new Map(), [pool, contract, burn]);
    for (const w of infrastructure) {
      expect(balances(d).has(w.toLowerCase())).toBe(false);
      expect([...groupsOf(d.links)].some(g => g.members.has(w.toLowerCase()))).toBe(false);
    }
    expect(d.links).toEqual([]);
    expect(analyze(d, options).verdict).not.toBe("FLAG");
  });

  it("a just-launched coin is not flagged for its age alone", () => {
    for (const age of [0, 1, 29, 30, 86400]) {
      const s = scenario();
      s.coin.launchTime = Math.floor(NOW.getTime() / 1000) - age;
      const d = s.build();
      expect(analyze(d, options).verdict).toBe("NOT_ENOUGH_DATA");
      expect(analyze(d, options).findings).toEqual([]);
    }
  });
});
