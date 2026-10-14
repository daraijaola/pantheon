import { describe, expect, it } from "vitest";
import { RULES } from "../src/config.ts";
import { analyze, mdText, toIndexMarkdown, toMarkdown, verdictOf } from "../src/report.ts";
import type { Finding } from "../src/types.ts";
import { addr, scenario } from "./scenario.ts";

const WEB = "https://explorer.test/testnet-explorer/";
const f = (severity: Finding["severity"]): Finding => ({ detector: "wash", severity, summary: "", metrics: {}, evidence: [] });

/** Two linked wallets buying 18% at launch, plus six honest holders. */
function bundled() {
  const s = scenario();
  for (const [i, w] of [addr(0x200), addr(0x201)].entries()) s.fund(w, addr(0xf0)).buy(w, 90, 1 + i);
  for (let i = 0; i < 6; i++) s.buy(addr(0x100 + i), 5, 3_600 * (i + 1));
  return s;
}

describe("verdictOf", () => {
  it("is the worst finding, and CLEAN only when every check had data", () => {
    expect(verdictOf([{ enough: true, finding: f("watch") }, { enough: false, finding: f("flag") }])).toBe("FLAG");
    expect(verdictOf([{ enough: false, finding: null }, { enough: true, finding: f("watch") }])).toBe("WATCH");
    expect(verdictOf([{ enough: true, finding: null }, { enough: true, finding: null }])).toBe("CLEAN");
    expect(verdictOf([{ enough: true, finding: null }, { enough: false, finding: null }])).toBe("NOT_ENOUGH_DATA");
  });
});

describe("analyze", () => {
  it("links every claim to the explorer and records the rules version", () => {
    const s = bundled();
    const r = analyze(s.build(), { explorerWeb: WEB, now: new Date("2026-10-14T00:00:00Z") });
    expect(r.rules).toBe(RULES.version);
    expect(r.verdict).toBe("FLAG");
    expect(r.coin.url).toBe(`https://explorer.test/testnet-explorer/token/${s.coin.token}`);
    expect(r.coin.launchUrl).toBe(`https://explorer.test/testnet-explorer/tx/${s.coin.launchTx}`);
    const ev = r.findings[0]!.evidence;
    expect(ev.length).toBeGreaterThan(0);
    for (const e of ev) expect(e.url).toBe(`https://explorer.test/testnet-explorer/tx/${e.tx}`);
    expect(r.stats).toEqual({ trades: 8, outsideTrades: 0, traders: 8, holders: 8, links: 1, fundingMissing: 0 });
    expect(r.notes).toEqual([]);
  });

  it("is plain JSON (no bigints), so it can be saved and served as is", () => {
    const r = analyze(bundled().build(), { explorerWeb: WEB });
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  });
});

describe("missing funding data", () => {
  it("never calls a coin CLEAN while part of its funding history is unknown", () => {
    const s = scenario();
    for (let i = 0; i < 8; i++) s.buy(addr(0x100 + i), 5, 3_600 * (i + 1));
    expect(analyze(s.build(), { explorerWeb: WEB }).verdict).toBe("CLEAN");
    const r = analyze({ ...s.build(), fundingMissing: 3 }, { explorerWeb: WEB });
    expect(r.verdict).toBe("NOT_ENOUGH_DATA");
    expect(r.notes[0]).toMatch(/missing for 3 wallet/);
    expect(toMarkdown(r)).toContain("> Funding history missing for 3 wallet(s)");
  });

  it("still reports what it did find", () => {
    const r = analyze({ ...bundled().build(), fundingMissing: 2 }, { explorerWeb: WEB });
    expect(r.verdict).toBe("FLAG");
  });
});

describe("mdText", () => {
  it("neutralises hostile coin names", () => {
    expect(mdText("<img src=x onerror=alert(1)>")).not.toMatch(/(^|[^\\])[<>]/);
    expect(mdText("[claim](https://evil.example)")).toBe("\\[claim\\]\\(https://evil\\.example\\)");
    expect(mdText("a|b")).toBe("a\\|b");
    expect(mdText("safe\u202Egnp.exe\u0000")).toBe("safegnp\\.exe");
  });

  it("caps the length and handles missing names", () => {
    expect(mdText("x".repeat(500))).toHaveLength(40);
    expect(mdText(null)).toBe("?");
    expect(mdText("\u0007")).toBe("?");
  });
});

describe("markdown", () => {
  it("writes the verdict, the checks and evidence links", () => {
    const md = toMarkdown(analyze(bundled().build(), { explorerWeb: WEB }));
    expect(md).toMatch(/^# TEST: FLAG/);
    expect(md).toContain("| Launch bundle | found |");
    expect(md).toContain("(https://explorer.test/testnet-explorer/tx/0x");
    expect(md).toContain("patterns, not intent");
  });

  it("escapes a hostile name in the heading", () => {
    const s = bundled();
    s.coin.symbol = "# <b>RUG</b>";
    const md = toMarkdown(analyze(s.build(), { explorerWeb: WEB }));
    expect(md.split("\n")[0]).toBe("# \\# \\<b\\>RUG\\</b\\>: FLAG");
  });

  it("lists the worst coins first in the index", () => {
    const quiet = scenario().buy(addr(0x100), 1, 60);
    quiet.coin.symbol = "QUIET";
    const reports = [analyze(quiet.build(), { explorerWeb: WEB }), analyze(bundled().build(), { explorerWeb: WEB })];
    const md = toIndexMarkdown(reports, (r) => `${r.coin.symbol}.md`);
    expect(md).toContain("2 coins · 1 flagged · 0 to watch · 0 clean · 1 without enough data");
    expect(md.indexOf("TEST")).toBeLessThan(md.indexOf("QUIET"));
  });
});
