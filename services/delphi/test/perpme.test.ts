// PerpMe, replayed from real Elysium testnet data (test/fixtures/perpme/, made by scripts/perpme-fixtures.ts):
// launch logs, two launch receipts, one coin's whole history with its state and PerpMe's own numbers, buy
// and sell receipts, the launch window's edges, and every launch's name. No network.
import { readFileSync } from "node:fs";
import { getAddress, toEventSelector, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { TRANSFER } from "../src/chain.ts";
import { STATIC_SYSTEM } from "../src/config.ts";
import { balances } from "../src/detect.ts";
import { decodeTransfer } from "../src/ingest.ts";
import { BASE_TOKENS, BURN, coinsOf, decodeLiq, decodeNpm, decodePoolCreated, decodeV3Swap, positionsOf, sideOf, TOPIC, V3_SWAP } from "../src/kalos.ts";
import { PERPME_TESTNET } from "../src/live/types.ts";
import {
  assemblePerpme,
  busyCoins,
  coinIsToken0,
  creatorBuyOf,
  decodeDeployed,
  decodeLaunched,
  isXStock,
  launchesOf,
  PERPME,
  PERPME_BASE_TOKENS,
  PERPME_CONTRACTS,
  PERPME_QUOTES,
  PERPME_RULES,
  PERPME_TOPIC,
  perpmeLiquidity,
  restrictionAt,
  type PerpmeLaunch,
} from "../src/perpme.ts";
import type { RawLog } from "../src/store.ts";
import type { CoinData } from "../src/types.ts";

type FxLog = { address: Hex; topics: Hex[]; data: Hex; logIndex: number; blockNumber: number; tx: Hex };
const load = <T>(name: string) => JSON.parse(readFileSync(new URL(`./fixtures/perpme/${name}`, import.meta.url), "utf8")) as T;
const rawOf = (l: FxLog): RawLog => ({ block: BigInt(l.blockNumber), logIndex: l.logIndex, tx: l.tx, address: l.address, topics: l.topics, data: l.data });
const lc = (a: string) => a.toLowerCase();
const TRANSFER_TOPIC = toEventSelector(TRANSFER);
const coinTransfers = (logs: FxLog[]) => logs.filter((l) => l.topics[0] === TRANSFER_TOPIC && l.topics.length === 3).map((l) => decodeTransfer(rawOf(l)));

const WHYDOGE = getAddress("0x4ddd716f0627693d12f237e0c42692fe23da0999");
const BIG = getAddress("0x420bf11ef5e5de04001cfe0a55243587d0690999");
const FIRST = getAddress("0x0b56c35d8ca0d323f1f871a7e6ea1b607c1f0e4c");
const SIA = getAddress("0x9d4a3Be30D060542DfB3525d25e5583EFE4A0999");
const USDC = getAddress("0x7D29d8047B905000459c0E80c34a26CeedcB47b2");
const KALOS_TOKEN = getAddress("0x8a2201953AF29e8BE7700bcB53dA3ce5caD18726");

type LaunchesFx = {
  factory: Address;
  logs: FxLog[];
  poolCreated: FxLog[];
  headers: Record<string, { parent: number; time: number }>;
  receipts: Record<string, { from: Address; logs: FxLog[] }>;
};
const fx = load<LaunchesFx>("launches.json");
const { launches } = launchesOf(fx.logs.map(rawOf));
const launch = (t: string) => launches.find((l) => lc(l.token) === lc(t))!;

describe("PerpMe's launch events (11 real launches, Oct 22-31)", () => {
  it("decode with the event shapes in live/types.ts: one TokenDeployed and one TokenLaunched per launch, same transaction", () => {
    expect(PERPME_TOPIC.deployed).toBe("0x4c27a723e73ca0ea76ef533aa6dfb2c623e2d3592d518fed4636ac3116c8f1c4"); // perpme.fun/elysium/docs
    expect(PERPME_TOPIC.launched).toBe("0x235e34a4e0e6a401dae6851f6fab4a919a1fdd0ae0073ac2fc4d1d4a87e548e5");
    const deployed = fx.logs.filter((l) => l.topics[0] === PERPME_TOPIC.deployed).map((l) => decodeDeployed(rawOf(l)));
    const launched = fx.logs.filter((l) => l.topics[0] === PERPME_TOPIC.launched).map((l) => decodeLaunched(rawOf(l)));
    expect(deployed).toHaveLength(11);
    expect(launched).toHaveLength(11);
    for (const d of deployed) {
      const l = launched.find((x) => x.token === d.token)!;
      expect(l.tx).toBe(d.tx);
      expect(l.deployer).toBe(d.deployer);
      expect(l.pairToken).toBe(d.pairToken);
      expect(l.factory).toBe(getAddress(PERPME_TESTNET.launchFactory));
      expect(l.logIndex).toBeGreaterThan(d.logIndex);
    }
    expect(launchesOf(fx.logs.map(rawOf))).toMatchObject({ orphans: 0 });
  });

  it("reads the coin, its creator, pool, LP position, window and creator buy from TokenLaunched", () => {
    expect(launch(BIG)).toMatchObject({
      deployer: getAddress("0x94001d745043f2c27117e95c7e9fed2efd8deb73"),
      pool: getAddress("0x8765937d364e1d5b87f21c10a0f07990a84d55f5"),
      pairToken: USDC,
      dexId: 0n,
      positionId: 551n,
      restrictionEndBlock: 68_073_827n,
      initialBuyAmount: 25_000_000_000n, // 25,000 USDC (6 decimals)
      initialBuyTokens: 892_858_330_362_036_999_343_048_857n, // 89.29% of the supply
      tx: "0x6bc9595d1deecd55871e93d567407296e284b03ec528a5e4da94c260c1dfd906",
      block: 17_427_280n,
      xstock: false,
    });
    // PerpMe's first launch, by its own deployer, with no creator buy.
    expect(launch(FIRST)).toMatchObject({ name: "Header Check", symbol: "HDRCHK", deployer: getAddress("0xf8f8c2837bb6c8a0cfa71e441a0db00d244e1d24"), initialBuyAmount: 0n, initialBuyTokens: 0n, pairToken: getAddress(PERPME.whype) });
    expect(launches.map((l) => l.block)).toEqual([...launches.map((l) => l.block)].sort((a, b) => (a < b ? -1 : 1)));
  });

  it("names a pool PerpMe's own V3 factory created in the same transaction, at the fee its dexId says, ordered by address", () => {
    const pools = fx.poolCreated.map((l) => decodePoolCreated(rawOf(l)));
    expect(pools).toHaveLength(11);
    for (const l of launches) {
      const p = pools.find((x) => x.pool === l.pool)!;
      expect(lc(fx.poolCreated.find((x) => lc(x.tx) === lc(l.tx))!.address)).toBe(lc(PERPME.poolFactory));
      expect(p.tx).toBe(l.tx);
      expect(p.fee).toBe(PERPME_RULES.feeOfDex[Number(l.dexId)]);
      expect(p.token0 === l.token).toBe(coinIsToken0(l.token, l.pairToken));
      expect([p.token0, p.token1].sort()).toEqual([l.token, l.pairToken].sort());
    }
    expect(new Set(launches.map((l) => Number(l.dexId)))).toEqual(new Set([0, 1]));
  });
});

describe("the creator's buy, read from the launch transaction", () => {
  for (const [name, token] of [["WHY DOGE (HYPE)", WHYDOGE], ["the 89% buy (USDC)", BIG]] as const) {
    it(`equals TokenLaunched's initialBuyTokens exactly: ${name}`, () => {
      const l = launch(token);
      const receipt = fx.receipts[lc(l.tx)]!;
      const swaps = receipt.logs.filter((x) => x.topics[0] === TOPIC.swap).map((x) => decodeV3Swap(rawOf(x)));
      const transfers = coinTransfers(receipt.logs);
      expect(swaps).toHaveLength(1);
      expect(swaps[0]!.recipient).toBe(l.deployer);
      expect(swaps[0]!.sender).toBe(getAddress(PERPME.router));
      expect(receipt.from).toBe(l.deployer);
      expect(creatorBuyOf(l, swaps, transfers)).toEqual({ swap: l.initialBuyTokens, transfer: l.initialBuyTokens });
      // One transaction does everything: the coin is minted to the factory, put in the pool, the
      // position goes to the locker, then the creator buys.
      const mint = transfers.find((t) => t.from === "0x0000000000000000000000000000000000000000")!;
      expect(mint).toMatchObject({ to: getAddress(PERPME.launchFactory), value: PERPME_RULES.supply });
      const nft = receipt.logs.find((x) => lc(x.address) === lc(PERPME.positionManager) && x.topics[0] === TRANSFER_TOPIC)!;
      expect(lc(`0x${nft.topics[2]!.slice(26)}`)).toBe(lc(PERPME.locker));
      expect(BigInt(nft.topics[3]!)).toBe(l.positionId);
    });
  }

  it("is not capped by launch protection: the cap (2% of the supply) starts after it", () => {
    const l = launch(BIG);
    expect(l.initialBuyTokens).toBeGreaterThan((PERPME_RULES.supply * PERPME_RULES.maxWalletBps) / 10_000n);
  });
});

// Two buys and two sells, from their receipts: the coin as token0 (WHY DOGE) and as token1 (SIA).
type SignFx = { txs: Record<Hex, { from: Address; blockNumber: number; timestamp: number; pool: Address; token: Address; logs: FxLog[] }> };
const sign = load<SignFx>("sign.json");

describe("the PerpMe (Uniswap V3) sign rule", () => {
  it("is the pool's side, as on Kalos: a negative coin amount is what the pool paid out (a buy), checked against the coin's own transfers", () => {
    const seen = { buy: 0, sell: 0, token0: 0, token1: 0 };
    for (const t of Object.values(sign.txs)) {
      const s = t.logs.filter((l) => l.topics[0] === toEventSelector(V3_SWAP)).map((l) => decodeV3Swap(rawOf(l)))[0]!;
      const moved = coinTransfers(t.logs).find((x) => x.token === t.token)!;
      const is0 = coinIsToken0(t.token, PERPME.whype);
      seen[is0 ? "token0" : "token1"]++;
      const [coinDelta, quoteDelta] = is0 ? [s.amount0, s.amount1] : [s.amount1, s.amount0];
      const side = sideOf(coinDelta, quoteDelta);
      seen[side]++;
      if (side === "buy") {
        expect(moved.from).toBe(s.pool);
        expect(moved.value).toBe(-coinDelta);
        expect(quoteDelta).toBeGreaterThan(0n);
      } else {
        expect(moved.to).toBe(s.pool);
        expect(moved.value).toBe(coinDelta);
        expect(quoteDelta).toBeLessThan(0n);
      }
    }
    expect(seen).toEqual({ buy: 2, sell: 2, token0: 2, token1: 2 });
  });

  it("makes trades from the sender of each transaction, with coin amounts on the coin's side and the WHYPE on the other", () => {
    for (const token of [WHYDOGE, SIA]) {
      const txs = (Object.entries(sign.txs) as Array<[Hex, SignFx["txs"][Hex]]>).filter(([, t]) => t.token === token);
      const pool = txs[0]![1].pool;
      const coin = { launch: { ...launch(WHYDOGE), token, pool, pairToken: getAddress(PERPME.whype), tx: txs[0]![0], block: BigInt(txs[0]![1].blockNumber) }, supply: PERPME_RULES.supply, decimals: 18 };
      const logs = txs.flatMap(([tx, t]) => t.logs.map((l) => ({ ...l, tx, blockNumber: t.blockNumber })));
      const [s] = assemblePerpme({
        coins: [coin],
        swaps: logs.filter((l) => l.topics[0] === TOPIC.swap).map((l) => decodeV3Swap(rawOf(l))),
        transfers: coinTransfers(logs),
        txFrom: new Map(txs.map(([tx, t]) => [lc(tx), t.from] as const)),
        blockTime: new Map(txs.map(([, t]) => [String(t.blockNumber), t.timestamp] as const)),
        system: new Set([...STATIC_SYSTEM, ...PERPME_CONTRACTS, pool].map(lc)),
      });
      expect(s!.trades.map((t) => t.side).sort()).toEqual(["buy", "sell"]);
      for (const t of s!.trades) {
        const tx = sign.txs[t.tx as Hex]!;
        expect(t.trader).toBe(tx.from);
        expect(t.holder).toBe(tx.from);
        const coinMove = coinTransfers(tx.logs).find((x) => x.token === token)!;
        const whypeMove = coinTransfers(tx.logs).find((x) => x.token === getAddress(PERPME.whype))!;
        expect(t.tokens).toBe(coinMove.value);
        expect(t.quote).toBe(whypeMove.value);
      }
    }
  });
});

describe("xStock detection, as Kalos's Sniper does it", () => {
  const names = load<{ head: string; launches: Array<[string, string]> }>("names.json");

  it("finds 1,318 tokenized-stock coins in PerpMe's first 1,530 launches, the count Kalos's rule gives", () => {
    expect(names.launches).toHaveLength(1530);
    const xs = names.launches.filter(([, n]) => isXStock(n));
    expect(xs).toHaveLength(1318);
    expect(names.launches.length - xs.length).toBe(212);
  });

  it("knows real xStocks from real memes", () => {
    for (const n of ["Apple xStock", "3M xStock", "1-800-Flowers.com xStock", "abrdn Phys Platinum Shs xStock", "Zscaler xStock"]) expect(names.launches.some(([, x]) => x === n) && isXStock(n)).toBe(true);
    for (const n of ["WHY DOGE", "Chair", "Perpme Launchpad", "Header Check", "MURDERBUN", "Omnia"]) expect(names.launches.some(([, x]) => x === n) && !isXStock(n)).toBe(true);
    // The rule itself (kalos-perpme-feed.js perpmeHidden): the word "xStock" at the end, any case.
    expect([isXStock("Tesla XSTOCK "), isXStock("xStock"), isXStock("Not an xStocks"), isXStock("MyxStock"), isXStock("xStock Apple"), isXStock(null)]).toEqual([true, true, false, false, false, false]);
  });

  it("flags the launches whose names say so, and every one of them is priced in USDC", () => {
    const xs = launches.filter((l) => l.xstock);
    expect(xs).toHaveLength(5);
    for (const l of xs) {
      expect(isXStock(l.name)).toBe(true);
      expect(l.pairToken).toBe(USDC);
    }
  });
});

describe("launch protection (WHY DOGE's window, read from the coin)", () => {
  type Edge = { block: string; parent: string; active: Hex };
  const r = load<{ restrictionEndBlock: string; launch: Edge; before: Edge; after: Edge }>("restriction.json");
  const end = BigInt(r.restrictionEndBlock);

  it("lasts 366 parent-chain blocks from the launch, on every recorded launch", () => {
    for (const l of launches) expect(l.restrictionEndBlock - BigInt(fx.headers[l.block.toString()]!.parent)).toBe(PERPME_RULES.restrictionBlocks);
    expect(end - BigInt(r.launch.parent)).toBe(366n);
  });

  it("is on while the parent block is below restrictionEndBlock, and off from it on, as the coin's restrictionsActive() says", () => {
    for (const e of [r.launch, r.before, r.after]) expect(restrictionAt(end, BigInt(e.parent)).active).toBe(BigInt(e.active) === 1n);
    expect(restrictionAt(end, BigInt(r.launch.parent))).toEqual({ endBlock: end, parentBlock: 67_619_214n, active: true, blocksLeft: 366n });
    expect(restrictionAt(end, BigInt(r.before.parent))).toMatchObject({ active: true, blocksLeft: 15n });
    expect(restrictionAt(end, end)).toMatchObject({ active: false, blocksLeft: 0n });
    expect(restrictionAt(end, null)).toMatchObject({ active: null, blocksLeft: null });
  });
});

// WHY DOGE's whole history from the dev cache, its state at the head, and PerpMe's own numbers.
type CoinFx = {
  head: string;
  parentHead: string;
  launch: FxLog[];
  transfers: FxLog[];
  swaps: FxLog[];
  liquidity: FxLog[];
  npm: FxLog[];
  txFrom: Record<string, Address>;
  blockTime: Record<string, number>;
  state: { totalSupply: Hex; decimals: Hex; coinInPool: Hex; quoteInPool: Hex; slot0: Hex; positionOwner: Hex; balances: Record<string, string> };
  perpme: { holders: Array<[string, string]>; tradeCount: number; dexSyncTradeCount: number };
};
const coinFx = load<CoinFx>("coin.json");
const doge: PerpmeLaunch = launchesOf(coinFx.launch.map(rawOf)).launches[0]!;
const dogeSwaps = coinFx.swaps.map((l) => decodeV3Swap(rawOf(l)));
const dogeSystem = new Set([...STATIC_SYSTEM, ...PERPME_CONTRACTS, doge.pool, ...dogeSwaps.map((s) => s.sender), ...BURN].map(lc));
const [dogeCoin] = assemblePerpme({
  coins: [{ launch: doge, supply: BigInt(coinFx.state.totalSupply), decimals: Number(BigInt(coinFx.state.decimals)) }],
  swaps: dogeSwaps,
  transfers: coinFx.transfers.map((l) => decodeTransfer(rawOf(l))),
  txFrom: new Map(Object.entries(coinFx.txFrom).map(([k, v]) => [lc(k), getAddress(v)] as const)),
  blockTime: new Map(Object.entries(coinFx.blockTime)),
  system: dogeSystem,
});
const dogeData: CoinData = { ...dogeCoin!, links: [], fundingMissing: 0 };

describe("one PerpMe coin, whole (WHY DOGE, recorded live)", () => {
  it("is a perpme coin: its launch is the TokenLaunched transaction and its creator the deployer it names", () => {
    expect(dogeCoin!.coin).toEqual({
      token: WHYDOGE,
      poolId: lc(doge.pool),
      tokenIs0: true,
      creator: doge.deployer,
      launcher: doge.deployer,
      launchTx: doge.tx,
      launchBlock: doge.block,
      launchTime: coinFx.blockTime[doge.block.toString()],
      devBuyTokens: doge.initialBuyTokens,
      name: "WHY DOGE",
      symbol: "$WHY",
      market: "perpme",
      supply: PERPME_RULES.supply,
    });
  });

  it("has every swap in its pool as a trade, the creator's buy first: the same count as PerpMe's indexer and API", () => {
    expect(dogeCoin!.trades).toHaveLength(44);
    expect(coinFx.perpme.tradeCount).toBe(44);
    expect(coinFx.perpme.dexSyncTradeCount).toBe(44);
    expect(dogeCoin!.trades[0]).toMatchObject({ tx: doge.tx, side: "buy", trader: doge.deployer, holder: doge.deployer, tokens: doge.initialBuyTokens, outside: false });
  });

  it("has holders, replayed from its transfers, that match balanceOf at the head for every address, and PerpMe's own list", () => {
    const ours = balances(dogeData);
    const chain = new Map(Object.entries(coinFx.state.balances).filter(([a, v]) => BigInt(v) > 0n && !dogeSystem.has(a)).map(([a, v]) => [a, BigInt(v)] as const));
    expect(ours).toEqual(chain);
    const theirs = new Map(coinFx.perpme.holders.filter(([a, v]) => BigInt(v) > 0n && !dogeSystem.has(a)).map(([a, v]) => [a, BigInt(v)] as const));
    expect(ours).toEqual(theirs);
    expect(ours.size).toBe(6);
    // PerpMe counts the pool, its launch factory's leftover wei and the burn sink as holders; DELPHI doesn't.
    const left = coinFx.perpme.holders.filter(([a, v]) => BigInt(v) > 0n && dogeSystem.has(a)).map(([a]) => a).sort();
    expect(left).toEqual([BURN_SINK, lc(PERPME.launchFactory), lc(doge.pool)].sort());
  });

  it("checks decimals: an 18-decimal coin carries no `decimals`, any other does", () => {
    const [odd] = assemblePerpme({ coins: [{ launch: doge, supply: PERPME_RULES.supply, decimals: 6 }], swaps: [], transfers: [], txFrom: new Map([[lc(doge.tx), doge.deployer]]), blockTime: new Map([[doge.block.toString(), 1]]), system: dogeSystem });
    expect(odd!.coin.decimals).toBe(6);
    expect("decimals" in dogeCoin!.coin).toBe(false);
  });
});
const BURN_SINK = "0x000000000000000000000000000000000000dead";

describe("the locked LP (WHY DOGE)", () => {
  const liq = coinFx.liquidity.map((l) => decodeLiq(rawOf(l)));
  const npm = coinFx.npm.map((l) => decodeNpm(rawOf(l)));
  const { positions, unmatched } = positionsOf(liq, npm, getAddress(PERPME.positionManager));
  const word = (h: Hex, i = 0) => BigInt(`0x${h.slice(2 + 64 * i, 66 + 64 * i)}`);
  const ownerOf = getAddress(`0x${coinFx.state.positionOwner.slice(26)}`);
  const report = perpmeLiquidity({
    launch: doge,
    positions,
    tokenReserve: word(coinFx.state.coinInPool),
    quoteReserve: word(coinFx.state.quoteInPool),
    sqrtPriceX96: word(coinFx.state.slot0),
    positionOwner: ownerOf,
    parentBlock: BigInt(coinFx.parentHead),
  });

  it("is one position, the launch's, held by PerpMe's locker on chain and in the replayed events", () => {
    expect(unmatched).toBe(0);
    expect(ownerOf).toBe(getAddress(PERPME.locker));
    expect([...positions.keys()]).toEqual([`nft:${doge.positionId}`]);
    expect(positions.get(`nft:${doge.positionId}`)).toMatchObject({ owner: getAddress(PERPME.locker), pool: doge.pool, via: "nft" });
    expect(report).toMatchObject({ locked: true, lockedPct: 100, unlocked: [], positionOwner: getAddress(PERPME.locker), fee: 10_000, tokenIs0: true, notes: [] });
  });

  it("was single-sided at launch: the whole supply, no HYPE", () => {
    const mint = liq.find((l) => l.kind === "mint")!;
    expect(mint.tx).toBe(doge.tx);
    expect(mint.amount1).toBe(0n);
    expect(mint.amount0).toBe(PERPME_RULES.supply - 355n); // the factory keeps a few wei
  });

  it("values the pool in HYPE where the pair is PerpMe's WHYPE", () => {
    const sqrtP = word(coinFx.state.slot0);
    expect(report.hypeInPool).toBe(word(coinFx.state.quoteInPool));
    expect(report.priceHypeWei).toBe((10n ** 18n * sqrtP * sqrtP) >> 192n);
    expect(report.tvlHype).toBe(report.hypeInPool! + ((word(coinFx.state.coinInPool) * sqrtP * sqrtP) >> 192n));
    expect(report.restriction).toMatchObject({ endBlock: doge.restrictionEndBlock, active: false, blocksLeft: 0n });
  });

  it("says so when the launch position isn't in the locker, and lists positions anyone can pull", () => {
    const someone = getAddress("0x00000000000000000000000000000000000000a1");
    const moved = new Map([...positions].map(([k, p]) => [k, { ...p, owner: someone }] as const));
    const r = perpmeLiquidity({ launch: doge, positions: moved, tokenReserve: null, quoteReserve: null, sqrtPriceX96: word(coinFx.state.slot0), positionOwner: someone, parentBlock: null });
    expect(r).toMatchObject({ locked: false, lockedPct: 0, unlocked: [{ owner: someone, position: `nft:${doge.positionId}`, sharePct: 100 }] });
    expect(r.notes[0]).toMatch(/not PerpMe's locker: it can be withdrawn/);
    // A pool not priced in PerpMe's WHYPE has no HYPE value.
    const usdc = perpmeLiquidity({ launch: { ...doge, pairToken: USDC }, positions, tokenReserve: 1n, quoteReserve: 1n, sqrtPriceX96: word(coinFx.state.slot0), parentBlock: null });
    expect(usdc).toMatchObject({ hypeInPool: null, tvlHype: null, priceHypeWei: null });
  });
});

describe("base tokens are never PerpMe coins", () => {
  const pools = fx.poolCreated.map((l) => decodePoolCreated(rawOf(l)));

  it("takes coins from launches only: the pair tokens in the same pools are not coins", () => {
    const pairTokens = new Set(launches.map((l) => l.pairToken));
    expect(pairTokens).toEqual(new Set([getAddress(PERPME.whype), USDC, KALOS_TOKEN]));
    for (const t of pairTokens) expect(PERPME_QUOTES).toContain(t);
    expect(launches.filter((l) => pairTokens.has(l.token))).toEqual([]);
    // Kalos's rule (every non-base token in a pool) would make PerpMe's WHYPE a coin, so it is one of Kalos's bases too.
    expect(BASE_TOKENS).toContain(getAddress(PERPME.whype));
    expect(coinsOf(pools, new Set()).kalos).not.toContain(getAddress(PERPME.whype));
    const withBase = coinsOf(pools, new Set(), [...BASE_TOKENS, ...PERPME_BASE_TOKENS]).kalos;
    expect(withBase).not.toContain(getAddress(PERPME.whype));
    expect(withBase).toContain(KALOS_TOKEN); // KALOS is a currency on PerpMe, but a coin on Kalos
  });

  it("never counts the pool, PerpMe's contracts, its WHYPE or the burn sink as holders", () => {
    const held = [...balances(dogeData).keys()];
    for (const a of [doge.pool, ...PERPME_CONTRACTS, PERPME.whype, BURN_SINK]) expect(held).not.toContain(lc(a));
  });
});

describe("busy coins", () => {
  it("are the ones with more transfers than a full read is meant for", () => {
    const t = (token: string) => ({ token: getAddress(token), tx: "0x01" as Hex, block: 1n, logIndex: 0, from: getAddress(PERPME.locker), to: getAddress(PERPME.locker), value: 1n });
    const transfers = [...Array.from({ length: 3 }, () => t(WHYDOGE)), t(SIA)];
    expect(busyCoins(transfers, 2)).toEqual(new Map([[lc(WHYDOGE), 3]]));
    expect(busyCoins(transfers)).toEqual(new Map());
  });
});
