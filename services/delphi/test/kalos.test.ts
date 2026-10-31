import { readFileSync } from "node:fs";
import { getAddress, toEventSelector, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { TRANSFER } from "../src/chain.ts";
import { STATIC_SYSTEM } from "../src/config.ts";
import { balances, contractHoldings, detectConcentration } from "../src/detect.ts";
import {
  amountsOf,
  ascendTradesOnKalos,
  coinsOf,
  assembleKalos,
  BASE_TOKENS,
  decodeLiq,
  decodeNpm,
  decodePoolCreated,
  decodeV3Swap,
  KALOS,
  liquidityReport,
  mainPool,
  positionsOf,
  sideOf,
  sqrtRatioAtTick,
  V3_SWAP,
  type KalosToken,
  type KPool,
  type NpmEvent,
} from "../src/kalos.ts";
import { decodeTransfer } from "../src/ingest.ts";
import type { RawLog } from "../src/store.ts";

type FxLog = { address: Hex; topics: Hex[]; data: Hex; logIndex: number };
type At = { blockNumber: number; tx: Hex };
const load = <T>(name: string) => JSON.parse(readFileSync(new URL(`./fixtures/kalos/${name}`, import.meta.url), "utf8")) as T;
const rawOf = (l: FxLog & At): RawLog => ({ block: BigInt(l.blockNumber), logIndex: l.logIndex, tx: l.tx, address: l.address, topics: l.topics, data: l.data });
const lc = (a: string) => a.toLowerCase();

// Two real KALOS trades in the KALOS/WHYPE 0.01% pool (Elysium testnet, Oct 31): a buy, then a sell.
type SignFx = {
  txs: Record<Hex, { from: Address; blockNumber: number; timestamp: number; logs: FxLog[] }>;
  poolCreated: Array<FxLog & At>;
  firstMint: FxLog & At & { from: Address; timestamp: number };
};
const sign = load<SignFx>("sign.json");
const KALOS_TOKEN = getAddress("0x8a2201953AF29e8BE7700bcB53dA3ce5caD18726");
const BUY_TX = "0x0189e261eae6933df278cbcb62fbad614431ebd3965e80af012e7f1e0dd4271c";
const SELL_TX = "0xb31a765c3e09ee1052205d398cc7b01bcce43d2e7c071a9de37877d07bbccfc2";
const signLogs = (topic: Hex) =>
  Object.entries(sign.txs).flatMap(([tx, t]) => t.logs.filter((l) => l.topics[0] === topic && (topic !== toEventSelector(TRANSFER) || l.topics.length === 3)).map((l) => rawOf({ ...l, tx: tx as Hex, blockNumber: t.blockNumber })));
const signPool = decodePoolCreated(rawOf(sign.poolCreated[0]!));
const signSwaps = signLogs(toEventSelector(V3_SWAP)).map(decodeV3Swap);
const signTransfers = signLogs(toEventSelector(TRANSFER)).map(decodeTransfer);
const signMint = decodeLiq(rawOf(sign.firstMint));
const signTxFrom = new Map([...Object.entries(sign.txs).map(([tx, t]) => [tx, getAddress(t.from)] as const), [lc(sign.firstMint.tx), getAddress(sign.firstMint.from)] as const]);
const signTimes = new Map([...Object.values(sign.txs).map((t) => [String(t.blockNumber), t.timestamp] as const), [String(sign.firstMint.blockNumber), sign.firstMint.timestamp] as const]);
const signSystem = new Set([...STATIC_SYSTEM, ...KALOS.contracts, signPool.pool, ...signSwaps.map((s) => s.sender)].map(lc));

describe("the Kalos (Uniswap V3) sign rule", () => {
  it("is the pool's side: a positive amount is what the pool received, checked against the coin's own transfers", () => {
    expect(signPool).toMatchObject({ token0: KALOS_TOKEN, token1: getAddress(KALOS.whype), fee: 100 });
    expect(signSwaps).toHaveLength(2);
    for (const s of signSwaps) {
      const moved = signTransfers.find((t) => t.tx === s.tx && lc(t.token) === lc(KALOS_TOKEN))!;
      if (s.amount0 < 0n) {
        // The pool paid KALOS out: the trader bought.
        expect(lc(moved.from)).toBe(lc(s.pool));
        expect(moved.value).toBe(-s.amount0);
        expect(sideOf(s.amount0, s.amount1)).toBe("buy");
      } else {
        // The pool took KALOS in: the trader sold.
        expect(lc(moved.to)).toBe(lc(s.pool));
        expect(moved.value).toBe(s.amount0);
        expect(sideOf(s.amount0, s.amount1)).toBe("sell");
      }
    }
    expect(signSwaps.map((s) => [s.tx, sideOf(s.amount0, s.amount1)])).toEqual([[BUY_TX, "buy"], [SELL_TX, "sell"]]);
  });

  it("reads a swap with no token amount by the quote that moved", () => {
    expect(sideOf(0n, 5n)).toBe("buy");
    expect(sideOf(0n, -5n)).toBe("sell");
  });

  it("makes trades with the wallet that sent each transaction, and the wallet whose tokens moved", () => {
    const [coin] = assembleKalos({
      tokens: [{ token: KALOS_TOKEN, deployer: getAddress("0x9332e35e87eac40a0810813a7a12c458e8043184"), name: "KALOS", symbol: "KALOS", supply: 10n ** 27n }],
      pools: [signPool],
      swaps: signSwaps,
      liquidity: [signMint],
      transfers: signTransfers,
      txFrom: signTxFrom,
      blockTime: signTimes,
      system: signSystem,
    });
    const [buy, sell] = coin!.trades;
    expect(buy).toMatchObject({ tx: BUY_TX, side: "buy", trader: getAddress(sign.txs[BUY_TX]!.from), holder: getAddress(sign.txs[BUY_TX]!.from), tokens: 1_392_740_399_651_859_859n, quote: 944_000_000_000_000n, outside: false });
    expect(sell).toMatchObject({ tx: SELL_TX, side: "sell", trader: getAddress(sign.txs[SELL_TX]!.from), holder: getAddress(sign.txs[SELL_TX]!.from), tokens: 606_672_922_659_899_121n });
    expect(lc(buy!.pool)).toBe(lc(signPool.pool));
    expect(coin!.coin).toMatchObject({ market: "kalos", poolId: lc(signPool.pool), tokenIs0: true, devBuyTokens: 0n, launchTx: sign.firstMint.tx, launchBlock: 8_348_978n, launcher: getAddress(sign.firstMint.from) });
  });
});

// A whole coin recorded from the dev cache: its pools, their Mints/Burns, the position manager's events
// for those positions, the token's transfers and swaps, the senders and block times.
type CoinFx = {
  token: Address;
  pools: Address[];
  creation: { block: string; deployer: Address };
  poolCreated: Array<FxLog & At>;
  liquidity: Array<FxLog & At>;
  npm: Array<FxLog & At>;
  transfers: Array<FxLog & At>;
  swaps: Array<FxLog & At>;
  txFrom: Record<string, Address>;
  blockTime: Record<string, number>;
  state?: Record<string, { sqrtPriceX96: string; tick: number; balance0: string; balance1: string }>;
};
function coinData(name: string) {
  const fx = load<CoinFx>(name);
  const pools = fx.poolCreated.map((l) => decodePoolCreated(rawOf(l)));
  const liq = fx.liquidity.map((l) => decodeLiq(rawOf(l)));
  const npm = fx.npm.map((l) => decodeNpm(rawOf(l)));
  const swaps = fx.swaps.map((l) => decodeV3Swap(rawOf(l)));
  const transfers = fx.transfers.map((l) => decodeTransfer(rawOf(l)));
  const system = new Set([...STATIC_SYSTEM, ...KALOS.contracts, ...pools.map((p) => p.pool), ...swaps.map((s) => s.sender)].map(lc));
  const token: KalosToken = { token: getAddress(fx.token), deployer: getAddress(fx.creation.deployer), name: null, symbol: null, supply: 0n };
  // Replayed supply: everything minted minus everything burned to the zero address.
  for (const t of transfers) {
    if (lc(t.from) === "0x0000000000000000000000000000000000000000") token.supply += t.value;
    if (lc(t.to) === "0x0000000000000000000000000000000000000000") token.supply -= t.value;
  }
  const txFrom = new Map(Object.entries(fx.txFrom).map(([k, v]) => [lc(k), getAddress(v)] as const));
  const blockTime = new Map(Object.entries(fx.blockTime));
  return { fx, pools, liq, npm, swaps, transfers, system, token, txFrom, blockTime };
}
const ZERO = "0x0000000000000000000000000000000000000000";

describe("which tokens are coins (all 39 Kalos pools, Oct 31)", () => {
  const pools = load<{ logs: Array<FxLog & At> }>("pools.json").logs.map((l) => decodePoolCreated(rawOf(l)));

  it("is every token in a pool except the base currencies", () => {
    const { kalos, ascend } = coinsOf(pools, new Set());
    expect(pools).toHaveLength(39);
    expect(kalos).toHaveLength(19);
    expect(ascend).toEqual([]);
    for (const b of BASE_TOKENS) expect(kalos.map(lc)).not.toContain(lc(b));
    expect(kalos).toContain(KALOS_TOKEN);
    // A pool of two base currencies (USDC/WHYPE) gives no coin; a pool of two coins (KALOS/stKALOS) gives both.
    const usdcWhype = pools.filter((p) => BASE_TOKENS.some((b) => lc(b) === lc(p.token0)) && BASE_TOKENS.some((b) => lc(b) === lc(p.token1)));
    expect(usdcWhype.length).toBeGreaterThan(0);
    expect(kalos.map(lc)).toContain(lc("0xa7531D7bE19f29B991d97eaA17b034715a835e35"));
  });

  it("keeps an Ascend coin out of the Kalos coins", () => {
    const { kalos, ascend } = coinsOf(pools, new Set([lc(KALOS_TOKEN)]));
    expect(ascend).toEqual([KALOS_TOKEN]);
    expect(kalos).toHaveLength(18);
    expect(kalos).not.toContain(KALOS_TOKEN);
  });
});

describe("assembleKalos: TA, a quiet coin read in full", () => {
  const c = coinData("ta.json");
  const input = { tokens: [c.token], pools: c.pools, swaps: c.swaps, liquidity: c.liq, transfers: c.transfers, txFrom: c.txFrom, blockTime: c.blockTime, system: c.system };
  const [coin] = assembleKalos(input);

  it("has every trade in either pool, each marked with its own pool and none 'outside'", () => {
    expect(c.pools).toHaveLength(2);
    expect(coin!.trades).toHaveLength(c.swaps.length);
    expect(new Set(coin!.trades.map((t) => lc(t.pool)))).toEqual(new Set(c.pools.map((p) => lc(p.pool))));
    expect(coin!.trades.every((t) => !t.outside)).toBe(true);
    const blocks = coin!.trades.map((t) => t.block);
    expect(blocks).toEqual([...blocks].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });

  it("launches at the first liquidity, with the deployer as creator", () => {
    const first = c.liq.filter((l) => l.kind === "mint").sort((a, b) => Number(a.block - b.block) || a.logIndex - b.logIndex)[0]!;
    expect(coin!.coin).toMatchObject({ market: "kalos", creator: c.token.deployer, launchTx: first.tx, launchBlock: first.block, devBuyTokens: 0n, supply: c.token.supply });
    expect(coin!.coin.launcher).toBe(c.txFrom.get(lc(first.tx)));
    expect(coin!.coin.windowFrom).toBeUndefined();
    expect(coin!.holdings).toBeUndefined();
  });

  it("picks as main pool the one holding the most of the coin, else the most traded", () => {
    const [a, b] = c.pools as [KPool, KPool];
    const reserves = new Map([[`${lc(a.pool)}:${lc(c.token.token)}`, 1n], [`${lc(b.pool)}:${lc(c.token.token)}`, 2n]]);
    const [withReserves] = assembleKalos({ ...input, reserves });
    expect(withReserves!.coin.poolId).toBe(lc(b.pool));
    expect(withReserves!.coin.tokenIs0).toBe(lc(b.token0) === lc(c.token.token));
    const traded = new Map<string, bigint>();
    for (const t of coin!.trades) traded.set(lc(t.pool), (traded.get(lc(t.pool)) ?? 0n) + t.tokens);
    const most = [...traded].sort((x, y) => (y[1] > x[1] ? 1 : -1))[0]![0];
    expect(coin!.coin.poolId).toBe(most);
  });

  it("replays balances that add up to the supply", () => {
    const held = [...balances({ ...coin!, links: [], fundingMissing: 0 }).values()].reduce((s, v) => s + v, 0n);
    const inSystem = [...new Set(c.transfers.flatMap((t) => [t.from, t.to]))].filter((a) => c.system.has(lc(a)) && lc(a) !== ZERO);
    const bal = (a: string) => c.transfers.reduce((s, t) => s + (lc(t.to) === lc(a) ? t.value : 0n) - (lc(t.from) === lc(a) ? t.value : 0n), 0n);
    expect(held + inSystem.reduce((s, a) => s + bal(a), 0n)).toBe(c.token.supply);
  });

  it("refuses to guess a trade's sender", () => {
    expect(() => assembleKalos({ ...input, txFrom: new Map() })).toThrow(/missing/);
  });
});

describe("an Ascend coin trading on Kalos", () => {
  const c = coinData("ta.json");
  it("comes back as outside trades for the Ascend coin, not as a Kalos coin", () => {
    const extras = ascendTradesOnKalos({ tokens: [c.token.token], pools: c.pools, swaps: c.swaps, transfers: c.transfers, txFrom: c.txFrom, blockTime: c.blockTime, system: c.system });
    const trades = extras.get(lc(c.token.token))!;
    expect(trades).toHaveLength(c.swaps.length);
    expect(trades.every((t) => t.outside && c.pools.some((p) => lc(p.pool) === lc(t.pool)))).toBe(true);
  });
});

describe("a busy coin read in windows", () => {
  const c = coinData("ta.json");
  const blocks = c.swaps.map((s) => s.block).sort((a, b) => (a < b ? -1 : 1));
  const first = c.liq.filter((l) => l.kind === "mint").map((l) => l.block).sort((a, b) => (a < b ? -1 : 1))[0]!;
  // The launch window (up to the first trade) and a recent window (the last trade only).
  const windows = [[first, blocks[0]!], [blocks.at(-1)!, blocks.at(-1)! + 10n]] as const;
  const someone = c.transfers.find((t) => !c.system.has(lc(t.to)) && lc(t.to) !== ZERO)!.to;
  const LOCKER = "0x00000000000000000000000000000000000000cc";
  const holdings = new Map<string, bigint>([[lc(someone), 7n], [LOCKER, 3n], [lc(c.pools[0]!.pool), 99n]]);
  const [coin] = assembleKalos({
    tokens: [{ ...c.token, windows, windowFrom: windows[1][0], holdings }],
    pools: c.pools,
    swaps: c.swaps,
    liquidity: c.liq,
    transfers: c.transfers,
    txFrom: c.txFrom,
    blockTime: c.blockTime,
    system: new Set([...c.system, LOCKER]),
    contracts: new Set([LOCKER]),
  });
  const d = { ...coin!, links: [], fundingMissing: 0 };

  it("keeps only the trades and transfers inside the windows, and says where the recent one starts", () => {
    const inside = (b: bigint) => windows.some(([x, y]) => b >= x && b <= y);
    expect(d.trades.length).toBeLessThan(c.swaps.length);
    expect(d.trades.length).toBe(c.swaps.filter((s) => inside(s.block)).length);
    expect(d.transfers.every((t) => inside(t.block))).toBe(true);
    expect(d.coin.windowFrom).toBe(windows[1][0]);
  });

  it("takes balances from the token, not from the partial transfers", () => {
    expect(Object.fromEntries(balances(d))).toEqual({ [lc(someone)]: 7n });
    // Contracts' holdings come from the same balances: 3 of the 10 tokens outside the pool.
    expect(contractHoldings(d)).toEqual({ share: 30, top: [{ contract: LOCKER, pct: 30 }] });
    expect(detectConcentration(d).enough).toBe(false);
  });
});

describe("LP positions and liquidity removals", () => {
  const e = coinData("elant.json");
  const { positions, changes, unmatched } = positionsOf(e.liq, e.npm, KALOS.positionManager);
  const nft = [...positions.values()].find((p) => p.via === "nft")!;
  const report = (pos = positions, ch = changes) =>
    liquidityReport({
      token: e.token.token,
      symbol: "ELANT",
      decimals: 18,
      supply: e.token.supply,
      supplyAtLaunch: null,
      read: { full: true },
      pools: e.pools,
      positions: pos,
      changes: ch,
      reserves: new Map(),
      prices: new Map(),
      roles: { creator: e.token.deployer! },
      kinds: new Map(),
      symbols: new Map([[lc(KALOS.whype), "WHYPE"]]),
      blockTime: e.blockTime,
    });

  it("ties each NFT's liquidity to its pool through the pool event in the same transaction", () => {
    expect(unmatched).toBe(0);
    expect(nft.pool).toBe(e.pools[0]!.pool);
    const mine = changes.filter((x) => x.position === nft.id);
    expect(mine.map((x) => x.delta > 0n)).toEqual([true, false]);
    expect(mine[0]!.delta).toBe(-mine[1]!.delta);
    expect(nft.liquidity).toBe(0n);
  });

  it("lists a removal of the pool's whole liquidity, with its transaction (the classic rug)", () => {
    const r = report();
    const [pool] = r.pools;
    expect(pool).toMatchObject({ openPositions: 0, totalLiquidity: 0n, adds: 1, removes: 1 });
    expect(pool!.bigRemovals).toHaveLength(1);
    const burn = e.liq.find((l) => l.kind === "burn")!;
    expect(pool!.bigRemovals[0]).toMatchObject({ tx: burn.tx, block: burn.block, sharePct: 100, owner: nft.owner, liquidity: burn.amount });
    expect(pool!.bigRemovals[0]!.time).toBe(e.blockTime.get(burn.block.toString()));
  });

  it("follows the NFT to its new holder: the position and its later removal are theirs", () => {
    // The live chain had no NFT hand-over on Kalos yet (Oct 31), so this one is added between the real
    // add and the real removal: the creator passes the position to another wallet.
    const NEW = getAddress("0x00000000000000000000000000000000000000ab");
    const inc = e.npm.find((x) => x.kind === "increase")!;
    const dec = e.npm.find((x) => x.kind === "decrease")!;
    const handOver: NpmEvent = { kind: "transfer", tokenId: (inc as { tokenId: bigint }).tokenId, from: nft.owner, to: NEW, tx: `0x${"cd".repeat(32)}`, block: inc.block + 1n, logIndex: 0 };
    const kept = positionsOf(e.liq.filter((l) => l.kind === "mint"), e.npm.filter((x) => x !== dec).concat(handOver), KALOS.positionManager);
    const open = report(kept.positions, kept.changes).pools[0]!;
    expect(open.openPositions).toBe(1);
    expect(open.top[0]).toMatchObject({ owner: NEW, sharePct: 100, roles: [], fullRange: nft.tickLower <= -887_000 && nft.tickUpper >= 887_000 });
    const before = report(positions, changes).pools[0]!.bigRemovals[0]!.owner;
    expect(before).not.toBe(NEW);
    const moved = positionsOf(e.liq, e.npm.concat(handOver), KALOS.positionManager);
    expect(report(moved.positions, moved.changes).pools[0]!.bigRemovals[0]!.owner).toBe(NEW);
  });

  it("marks the creator's own positions", () => {
    const own = new Map([...positions].map(([k, p]) => [k, { ...p, owner: e.token.deployer!, liquidity: 5n }]));
    expect(report(own, changes).pools[0]!.top[0]!.roles).toEqual(["creator"]);
  });
});

describe("V3 tick maths", () => {
  it("matches Uniswap's TickMath at the limits and at zero", () => {
    expect(sqrtRatioAtTick(-887_272)).toBe(4_295_128_739n);
    expect(sqrtRatioAtTick(887_272)).toBe(1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_342n);
    expect(sqrtRatioAtTick(0)).toBe(1n << 96n);
    expect(() => sqrtRatioAtTick(887_273)).toThrow(RangeError);
  });

  it("brackets live Kalos prices: slot0's tick and price at block 19,869,262 (Oct 31)", () => {
    const live: Array<[number, bigint]> = [
      [-75_518, 1_816_004_151_845_410_160_701_988_009n], // KALOS/WHYPE 2%
      [137_710, 77_460_663_670_859_272_130_085_685_994_889n], // KALOS/stKALOS
      [-213_403, 1_841_364_671_789_668_679_964_275n], // stKALOS/WHYPE
      [120, 79_704_993_017_803_043_439_899_207_331n], // ELYS/WHYPE
      [181_531, 692_782_732_125_293_195_240_639_130_639_780n], // USDC/WHYPE
      [887_271, 1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_341n], // an empty pool at the edge
    ];
    for (const [tick, sqrtP] of live) {
      expect(sqrtRatioAtTick(tick) <= sqrtP && sqrtP < sqrtRatioAtTick(tick + 1)).toBe(true);
    }
  });

  it("gives a position's tokens: TA's two one-position pools hold what the pools' balances say", () => {
    const c = coinData("ta.json");
    const { positions } = positionsOf(c.liq, c.npm, KALOS.positionManager);
    for (const p of c.pools) {
      const st = c.fx.state![lc(p.pool)]!;
      const [pos] = [...positions.values()].filter((x) => lc(x.pool) === lc(p.pool));
      const [a0, a1] = amountsOf(pos!.liquidity, pos!.tickLower, pos!.tickUpper, BigInt(st.sqrtPriceX96));
      // Within 0.1% of the balances (the rest is uncollected fees and rounding).
      for (const [got, bal] of [[a0, BigInt(st.balance0)], [a1, BigInt(st.balance1)]] as const) {
        expect(got <= bal).toBe(true);
        expect(got * 1000n >= bal * 999n).toBe(true);
      }
    }
  });
});

describe("LP shares by value", () => {
  // Two positions in one real pool's price: a full-range one and a narrow one with 10x the liquidity.
  const c = coinData("ta.json");
  const pool = c.pools[0]!;
  const st = c.fx.state![lc(pool.pool)]!;
  const sqrtP = BigInt(st.sqrtPriceX96);
  const WIDE = getAddress("0x00000000000000000000000000000000000000a1");
  const NARROW = getAddress("0x00000000000000000000000000000000000000a2");
  const positions = new Map([
    ["w", { id: "w", pool: pool.pool, owner: WIDE, via: "direct" as const, tickLower: -887_270, tickUpper: 887_270, liquidity: 10n ** 12n }],
    ["n", { id: "n", pool: pool.pool, owner: NARROW, via: "direct" as const, tickLower: st.tick - 10, tickUpper: st.tick + 10, liquidity: 10n ** 13n }],
  ]);
  const report = (prices: Map<string, bigint>) =>
    liquidityReport({ token: c.token.token, symbol: "TA", decimals: 18, supply: 1n, supplyAtLaunch: null, read: { full: true }, pools: [pool], positions, changes: [], reserves: new Map(), prices, roles: { creator: NARROW }, kinds: new Map([[lc(WIDE), "contract"]]), symbols: new Map(), blockTime: new Map() }).pools[0]!;

  it("weighs positions by what they hold at the current price, not by liquidity units", () => {
    const r = report(new Map([[lc(pool.pool), sqrtP]]));
    expect(r.shareBy).toBe("value");
    const wide = r.top.find((x) => x.owner === WIDE)!;
    const narrow = r.top.find((x) => x.owner === NARROW)!;
    // 10x the liquidity, but over a sliver of the price range: far fewer tokens.
    expect(narrow.liquidity).toBe(10n * wide.liquidity);
    expect(wide.sharePct).toBeGreaterThan(95);
    expect(r.top[0]!.owner).toBe(WIDE);
    expect(r.topOwners.map((o) => [o.owner, o.roles, o.ownerKind])).toEqual([[WIDE, [], "contract"], [NARROW, ["creator"], "unknown"]]);
    expect(wide.fullRange).toBe(true);
    expect(narrow.fullRange).toBe(false);
  });

  it("falls back to liquidity units when the pool has no price", () => {
    const r = report(new Map());
    expect(r.shareBy).toBe("liquidity");
    expect(r.top[0]).toMatchObject({ owner: NARROW, sharePct: 90.9, tokens: null });
  });
});

describe("main pool", () => {
  const coin = getAddress("0x00000000000000000000000000000000000000c0");
  const other = getAddress("0x00000000000000000000000000000000000000c1");
  const pool = (n: number, quote: Address): KPool => ({ pool: getAddress(`0x${n.toString(16).padStart(40, "0")}`), token0: coin, token1: quote, fee: 3000, tickSpacing: 60, block: BigInt(n), tx: `0x${"00".repeat(32)}` });
  it("is priced in a base currency when one exists, even if a coin-to-coin pool holds more", () => {
    const [coinPair, hype] = [pool(1, other), pool(2, getAddress(KALOS.whype))];
    const reserves = new Map([[`${lc(coinPair.pool)}:${lc(coin)}`, 100n], [`${lc(hype.pool)}:${lc(coin)}`, 1n]]);
    expect(mainPool(coin, [coinPair, hype], [], reserves)).toBe(hype);
    expect(mainPool(coin, [coinPair], [], reserves)).toBe(coinPair);
  });
});
