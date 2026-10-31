import { describe, expect, it } from "vitest";
import { assignRoles } from "../src/ingest.ts";
import { addr, scenario } from "./scenario.ts";

describe("who a wallet is (rules v0.5)", () => {
  it("names a project's own wallet, a fee sink and an outside whale", () => {
    const whale = addr(0x900);
    const coins = [0, 1, 2, 3].map((i) => {
      const s = scenario({ creator: addr(0xc0 + i) }).buy(whale, 60, 600);
      for (let k = 0; k < 6; k++) s.buy(addr(0x100 + k), 5, 3_600 * (k + 1));
      return s.build();
    });
    // A sink: 100 different wallets' trades deliver this coin to it.
    const sink = addr(0x800);
    const s = scenario();
    for (let k = 0; k < 100; k++) s.buy(sink, 1, 3_600 + k, addr(0x1000 + k));
    const out = assignRoles([...coins, s.build()], new Map([[addr(0xaa).toLowerCase(), "owns Kalos's factory: it is Kalos's own wallet"]]), new Set());
    expect(out[0]!.roles?.get(whale.toLowerCase())).toEqual({ kind: "whale", says: "also holds 5% or more of 3 other coins, so it trades across the market" });
    expect(out[4]!.roles?.get(sink.toLowerCase())).toEqual({ kind: "sink", says: "receives this coin from trades sent by 100 different wallets (fees or buybacks)" });
    expect(out[4]!.roles?.get(addr(0xaa).toLowerCase())?.kind).toBe("project");
  });
});
