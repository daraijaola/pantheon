import { describe, expect, it } from "vitest";
import { actorsOf, clusters, findHubs, groupsOf, linksWithin, payeesOf, peopleOf } from "../src/graph.ts";
import type { Link } from "../src/types.ts";
import { addr, FAUCET, hash, ROUTER, scenario, VAULT } from "./scenario.ts";

const F = addr(0xf0);

describe("peopleOf", () => {
  it("counts linked wallets once, and wallets the faucet funded one by one", () => {
    const s = scenario();
    // One farmer: a private funder pays gas for four wallets. Three independent faucet users.
    [0x200, 0x201, 0x202, 0x203].forEach((n, i) => s.fund(addr(n), F).buy(addr(n), 1, 60 + i));
    [0x300, 0x301, 0x302].forEach((n, i) => s.fund(addr(n), FAUCET).buy(addr(n), 1, 600 + i));
    expect(peopleOf(s.build())).toEqual({ wallets: 7, people: 4 });
  });
});

describe("findHubs", () => {
  it("always includes the known faucet, plus anything very busy", () => {
    const hubs = findHubs(new Map([[addr(1), 5_000], [addr(2), 4_999]]));
    expect(hubs).toEqual(new Set([FAUCET.toLowerCase(), addr(1)]));
  });
});

describe("findHubs on testnet (v0.3)", () => {
  const payees = new Map([
    [addr(1), { wallets: 20, coins: 1 }], // paid many wallets: a distribution bot
    [addr(2), { wallets: 19, coins: 4 }],
    [addr(3), { wallets: 5, coins: 5 }], // a few wallets, spread over many coins: a farm
    [addr(4), { wallets: 4, coins: 9 }],
  ]);

  it("adds wallets that paid many tracked wallets, or wallets trading many coins", () => {
    expect(findHubs(new Map(), { network: "testnet", payees })).toEqual(new Set([FAUCET.toLowerCase(), addr(1), addr(3)]));
  });

  it("does nothing of the kind on mainnet", () => {
    expect(findHubs(new Map(), { network: "mainnet", payees })).toEqual(new Set([FAUCET.toLowerCase()]));
  });
});

describe("payeesOf", () => {
  it("counts each funder's wallets and the coins they traded, leaving out self-payments and its own launches", () => {
    const fund = (wallet: number, funder: number) => ({ wallet: addr(wallet), funder: addr(funder), value: 1n, tx: hash(wallet), time: 0 });
    const traded = new Map([
      [addr(0x200), new Set(["c1", "c2"])],
      [addr(0x201), new Set(["c2", "c3"])],
    ]);
    const launched = new Map([[addr(0xf0), new Set(["c3"])]]);
    const p = payeesOf([fund(0x200, 0xf0), fund(0x201, 0xf0), fund(0x201, 0xf0), fund(0xf0, 0xf0)], traded, launched);
    expect(p.get(addr(0xf0))).toEqual({ wallets: 2, coins: 2 });
  });
});

describe("groupsOf and clusters (v0.3)", () => {
  const link = (a: number, b: number, extra: Partial<Link> = {}): Link => ({ a: addr(a), b: addr(b), reason: "shared-funder", evidence: [hash(a)], ...extra });

  it("keeps two funders' stars apart even when one wallet got HYPE from both", () => {
    const links = [link(0x200, 0x201, { via: addr(0xf1) }), link(0x200, 0x300, { via: addr(0xf1) }), link(0x210, 0x211, { via: addr(0xf2) }), link(0x210, 0x300, { via: addr(0xf2) })];
    const groups = groupsOf(links).map((g) => [g.anchor, [...g.members].sort()]);
    expect(groups).toEqual([
      [addr(0xf1), [addr(0x200), addr(0x201), addr(0x300)]],
      [addr(0xf2), [addr(0x210), addr(0x211), addr(0x300)]],
    ]);
    // Every wallet still has exactly one cluster: the shared wallet goes to one star, the stars stay apart.
    const cl = clusters(links);
    expect(cl.get(addr(0x300))).toBe(addr(0x200));
    expect(cl.get(addr(0x210))).toBe(addr(0x210));
  });

  it("widens a star with the wallets its members passed tokens to", () => {
    const links = [link(0x200, 0x201, { via: addr(0xf1) }), link(0x201, 0x400, { reason: "token-pass" }), link(0x400, 0x401, { reason: "token-pass" })];
    const star = groupsOf(links).find((g) => g.anchor === addr(0xf1))!;
    expect([...star.members].sort()).toEqual([addr(0x200), addr(0x201), addr(0x400), addr(0x401)]);
    expect(star.secondHand).toBe(false);
  });

  it("marks a group second-hand when a member is in only through a contract payout", () => {
    const links = [link(0x200, 0x201, { via: addr(0xf1) }), link(0x200, 0x202, { via: addr(0xf1), secondHand: true })];
    const groups = groupsOf(links);
    expect(groups.map((g) => [g.secondHand, g.members.size])).toEqual([
      [false, 2],
      [true, 3],
    ]);
    expect(new Set(clusters(links).values()).size).toBe(2);
  });
});

describe("buildLinks", () => {
  it("links nobody through a lone contract payout (a sale, a game win)", () => {
    const S = addr(0x5e);
    const [a, b] = [addr(0x200), addr(0x201)];
    const s = scenario().fund(a, S, -3_600, "contract").fund(b, S, -1_800, "contract").buy(a, 1, 99).buy(b, 1, 99);
    expect(s.build().links).toEqual([]);
  });

  it("links wallets one transaction paid together through a contract, as second-hand", () => {
    const [a, b] = [addr(0x200), addr(0x201)];
    const s = scenario().payout([a, b], addr(0x5e)).buy(a, 1, 99).buy(b, 1, 99);
    expect(s.build().links).toMatchObject([{ a, b, reason: "shared-funder", via: addr(0x5e), secondHand: true }]);
  });

  it("keeps one link per funder and wallet, preferring a plain transfer", () => {
    const [a, b] = [addr(0x200), addr(0x201)];
    const s = scenario().payout([b, addr(0x202)], a, -7_200).fund(b, a).fund(b, a).buy(a, 1, 99).buy(b, 1, 99);
    expect(s.build().links).toEqual([{ a, b, reason: "funded-by", evidence: [s.fundings[2]!.tx] }]);
  });

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
