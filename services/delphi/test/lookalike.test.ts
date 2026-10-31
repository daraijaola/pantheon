import { describe, expect, it } from "vitest";
import { lookalikes, looksDisguised, plain, skeleton, visible, type KnownToken } from "../src/lookalike.ts";
import { impersonation, RESERVED_NAMES } from "../src/safety.ts";

const USDC: KnownToken = { address: "0x7D29d8047B905000459c0E80c34a26CeedcB47b2", symbol: "USDC", name: "USDC", source: "Kalos's approved list" };
const KALOS: KnownToken = { address: "0x8a2201953AF29e8BE7700bcB53dA3ce5caD18726", symbol: "KALOS", name: "KALOS", source: "KALOS's own contract" };
const STKALOS: KnownToken = { address: "0xa7531D7bE19f29B991d97eaA17b034715a835e35", symbol: "stKALOS", name: "Staked KALOS", source: "Kalos's staked-KALOS vault" };
const PNTH: KnownToken = { address: "0x048aCeb334cb1835dc897a749C5985e169EAb1C5", symbol: "PNTH", name: "PANTHEON", source: "PANTHEON's own coin on Ascend" };
const KNOWN = [USDC, KALOS, STKALOS, PNTH, ...RESERVED_NAMES];
const FAKE = "0x00000000000000000000000000000000000fa4e1";

describe("plain and skeleton", () => {
  it("undoes case, spaces, separators and a leading $", () => {
    for (const v of ["usdc", " USDC ", "$USDC", "$ usdc", "U.S.D.C", "U S D C", "ＵＳＤＣ"]) expect(plain(v)).toBe("usdc");
    expect(plain("Staked  KALOS")).toBe(plain("staked-kalos"));
  });

  it("undoes look-alike letters: Cyrillic, Greek, 0/O, 1/l/I, accents, invisible characters", () => {
    const k = skeleton("KALOS");
    for (const v of ["KAL0S", "ΚΑLOS" /* Greek Kappa, Alpha */, "КАLОS" /* Cyrillic */, "KALÖS", "K​ALOS", "KA⁠LOS", "𝐊𝐀𝐋𝐎𝐒"]) expect(skeleton(v)).toBe(k);
    expect(skeleton("PNTH")).toBe(skeleton("ΡΝΤΗ")); // all four Greek
    expect(skeleton("stKALOS")).toBe(skeleton("stKAL0S"));
    for (const v of ["l", "1", "I", "i"]) expect(skeleton(`WHYPE${v}`)).toBe(skeleton("WHYPEl"));
  });

  it("keeps different names apart", () => {
    for (const v of ["USDT", "USDC2", "USDCC", "KALOSX", "KAL", "PNTHX", "PANTHEONS"]) {
      expect(skeleton(v)).not.toBe(skeleton("USDC"));
      expect(lookalikes(FAKE, { symbol: v, name: v }, KNOWN)).toEqual([]);
    }
  });

  it("spots disguises and shows invisible characters instead of passing them on", () => {
    expect(looksDisguised("UЅDC")).toBe(true); // Cyrillic Ѕ among Latin letters
    expect(looksDisguised("US​DC")).toBe(true);
    expect(looksDisguised("USDC")).toBe(false);
    expect(looksDisguised("ΡΑΝΘΕΟΝ")).toBe(false); // all Greek: odd, but not mixed
    expect(visible("US​DC‮")).toBe("US<U+200B>DC<U+202E>");
  });
});

describe("lookalikes", () => {
  it("matches the same symbol at a different address, plainly or with look-alikes", () => {
    expect(lookalikes(FAKE, { symbol: "$usdc", name: "Real Dollar" }, KNOWN).map((m) => [m.field, m.known.symbol, m.how])).toEqual([["symbol", "USDC", "same"]]);
    expect(lookalikes(FAKE, { symbol: "UЅDС", name: "x" }, KNOWN).map((m) => [m.field, m.known.symbol, m.how])).toEqual([["symbol", "USDC", "lookalike"]]);
    expect(lookalikes(FAKE, { symbol: "XYZ", name: "Pantheon" }, KNOWN).map((m) => [m.field, m.knownField, m.known.symbol])).toEqual([["name", "name", "PNTH"]]);
    // A name that copies another token's symbol counts too.
    expect(lookalikes(FAKE, { symbol: "XYZ", name: "KAL0S" }, KNOWN).map((m) => [m.field, m.known.symbol, m.how])).toEqual([["name", "KALOS", "lookalike"]]);
  });

  it("never matches the real token with itself", () => {
    expect(lookalikes(KALOS.address!, { symbol: "KALOS", name: "KALOS" }, KNOWN)).toEqual([]);
  });

  it("treats native HYPE and KNTQ as names no token contract may use", () => {
    expect(lookalikes(FAKE, { symbol: "HYPE", name: "Hype Token" }, KNOWN).map((m) => m.known.source)).toEqual([RESERVED_NAMES[0]!.source]);
    expect(lookalikes(FAKE, { symbol: "KNTQ", name: "kinetiq" }, KNOWN)).toHaveLength(2);
  });
});

describe("impersonation (the check)", () => {
  it("flags a fake ticker, naming the real token and how it was copied", () => {
    const c = impersonation(FAKE, { symbol: "USDС", name: "USD Coin" }, KNOWN); // Cyrillic С
    expect(c.state).toBe("risk");
    expect(c.summary).toBe(`Its symbol "USDС" copies USDC using look-alike letters (the real one is 0x7D29d8…47b2, Kalos's approved list), but this is a different contract.`);
    expect(c.evidence).toEqual([{ what: "the real USDC (Kalos's approved list)", address: USDC.address }]);
    expect(c.facts.disguised).toBe(true);
  });

  it("is ok for the real token, even when another real token shares its name", () => {
    const ascendUsdc: KnownToken = { address: "0x4b4fb5C5794F0c821464956374cC5872D5F0f140", symbol: "USDC", name: "USDC", source: "the USDC Ascend prices its coins in" };
    const c = impersonation(USDC.address!, { symbol: "USDC", name: "USDC" }, [...KNOWN, ascendUsdc]);
    expect(c.state).toBe("ok");
    expect(c.summary).toBe("This is the real USDC (Kalos's approved list); the USDC Ascend prices its coins in (0x4b4fb5…f140) has the same name and is real too.");
  });

  it("is ok for an ordinary name, and unknown without one", () => {
    expect(impersonation(FAKE, { symbol: "KITTIQ", name: "Kittiq" }, KNOWN).state).toBe("ok");
    expect(impersonation(FAKE, { symbol: null, name: null }, KNOWN).state).toBe("unknown");
  });
});
