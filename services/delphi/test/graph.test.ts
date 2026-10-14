import { describe, expect, it } from "vitest";
import { actorsOf, clusters, findHubs, linksWithin } from "../src/graph.ts";
import type { Link } from "../src/types.ts";
import { addr, FAUCET, hash, ROUTER, scenario, VAULT } from "./scenario.ts";

const F = addr(0xf0);

describe("findHubs", () => {
  it("always includes the known faucet, plus anything very busy", () => {
    const hubs = findHubs(new Map([[addr(1), 5_000], [addr(2), 4_999]]));
    expect(hubs).toEqual(new Set([FAUCET.toLowerCase(), addr(1)]));
  });
});

describe("buildLinks", () => {
  it("links wallets with the same private funder, citing both funding transactions", () => {
    const s = scenario();
    const [a, b, c] = [addr(0x200), addr(0x201), addr(0x202)];
    s.fund(a, F).fund(b, F).fund(c, F).buy(a, 1, 99).buy(b, 1, 99).buy(c, 1, 99);
    const links = s.build().links;
    expect(links).toHaveLength(2);
    expect(links[0]).toMatchObject({ a, b, reason: "shared-funder", via: F });
    expect(links[0]!.evidence).toEqual([s.fundings[0]!.tx, s.fundings[1]!.tx]);
    expect(new Set(clusters(links).values()).size).toBe(1);
  });

  it("ignores funding from hubs and from system contracts", () => {
    const s = scenario();
    for (const w of [addr(0x200), addr(0x201)]) s.fund(w, FAUCET).fund(w, VAULT).buy(w, 1, 99);
    expect(s.build().links).toEqual([]);
  });

  it("links an actor that funded another actor", () => {
    const [a, b] = [addr(0x200), addr(0x201)];
    const s = scenario().fund(b, a).buy(a, 1, 99).buy(b, 1, 99);
    expect(s.build().links).toEqual([{ a, b, reason: "funded-by", evidence: [s.fundings[0]!.tx] }]);
  });

  it("ignores funders that never touched the coin, unless they fund two actors", () => {
    const s = scenario().fund(addr(0x200), F).buy(addr(0x200), 1, 99);
    expect(s.build().links).toEqual([]);
  });

  it("links direct token passes, but not pool or router transfers", () => {
    const [a, b] = [addr(0x200), addr(0x201)];
    const s = scenario().buy(a, 2, 99).pass(a, b, 1, 120).pass(a, ROUTER, 1, 130);
    expect(s.build().links.map((l) => [l.reason, l.a, l.b])).toEqual([["token-pass", a, b]]);
  });

  it("links a payer to the wallet its buy was sent to", () => {
    const [payer, w] = [addr(0x300), addr(0x200)];
    const s = scenario().buy(w, 1, 99, payer);
    expect(s.build().links).toMatchObject([{ a: payer, b: w, reason: "bought-for" }]);
  });

  it("links the launcher to the creator role when they differ", () => {
    const s = scenario({ creator: addr(0xc0), launcher: addr(0xc1) });
    expect(s.build().links).toEqual([{ a: addr(0xc1), b: addr(0xc0), reason: "is-creator", evidence: [s.coin.launchTx] }]);
  });
});

describe("actorsOf", () => {
  it("collects traders, recipients and holders, never system contracts", () => {
    const s = scenario().buy(addr(0x200), 1, 9, addr(0x300)).pass(addr(0x200), addr(0x201), 1, 10);
    const system = new Set([VAULT.toLowerCase(), addr(0).toLowerCase()]);
    expect(actorsOf(s.trades, s.transfers, system)).toEqual(new Set([addr(0x300), addr(0x200), addr(0x201)]));
  });
});

describe("clusters", () => {
  const link = (a: number, b: number): Link => ({ a: addr(a), b: addr(b), reason: "token-pass", evidence: [hash(1)] });

  it("joins links transitively and names each cluster after its smallest address", () => {
    const cl = clusters([link(5, 3), link(3, 9), link(20, 21)], [addr(40)]);
    expect(cl.get(addr(9))).toBe(addr(3));
    expect(cl.get(addr(5))).toBe(addr(3));
    expect(cl.get(addr(21))).toBe(addr(20));
    expect(cl.get(addr(40))).toBe(addr(40));
  });

  it("is case-insensitive", () => {
    const upper = { ...link(0xab, 0xcd), a: addr(0xab).toUpperCase().replace("0X", "0x") as `0x${string}` };
    expect(clusters([upper]).get(addr(0xcd))).toBe(addr(0xab));
  });

  it("keeps report evidence short", () => {
    const links = Array.from({ length: 10 }, (_, i) => link(1, 2 + i));
    const members = new Set(Array.from({ length: 11 }, (_, i) => addr(1 + i)));
    expect(linksWithin(links, members)).toHaveLength(6);
    expect(linksWithin(links, new Set([addr(1)]))).toHaveLength(0);
  });
});
