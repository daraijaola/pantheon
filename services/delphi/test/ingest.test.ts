import { readFileSync } from "node:fs";
import { getAddress, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { toEventSelector } from "viem";
import { LAUNCHED, SWAP, TRANSFER } from "../src/chain.ts";
import { STATIC_SYSTEM } from "../src/config.ts";
import { assemble, decodeLaunch, decodePool, decodeSwap, decodeTransfer, type Pool } from "../src/ingest.ts";
import type { RawLog } from "../src/store.ts";

// Two real transactions from Elysium testnet: a launch with a dev-buy (coin 0x2e92…), and a later
// coin-to-coin trade through Ascend's router that sells another coin and buys 0x2e92 in one go.
type FxLog = { address: Hex; topics: Hex[]; data: Hex; logIndex: number };
type Fx = {
  txs: Record<Hex, { from: Address; blockNumber: number; timestamp: number; logs: FxLog[] }>;
  initialize: Array<FxLog & { blockNumber: number; tx: Hex }>;
};
const fx = JSON.parse(readFileSync(new URL("./fixtures/live-trades.json", import.meta.url), "utf8")) as Fx;
const LAUNCH_TX = "0xf5688a6a9e28a1a4eac1aabee1a316fa555a3d06501a85e852788039efc9819e";
const TRADE_TX = "0x40388c92e97cff2205293816f69b4c7d54106287229f6886af61dc07d3029fa8";
const TRADER = getAddress("0x797DD8B5dA7a10BF6e6534D549A9c256F8F4f0AB");
const LAUNCHPAD = "0xE2f6254508DEB93Da081837F545e0bAF7b00d8E9";
const VAULT = "0x2B738A9A69b7a45C9dA6B519f6bE6efBfb912aec";

const raw = (topic: Hex): RawLog[] =>
  Object.entries(fx.txs).flatMap(([tx, t]) =>
    t.logs
      .filter((l) => l.topics[0] === topic)
      .map((l) => ({ block: BigInt(t.blockNumber), logIndex: l.logIndex, tx: tx as Hex, address: l.address, topics: l.topics, data: l.data })),
  );

const launches = raw(toEventSelector(LAUNCHED)).map(decodeLaunch);
const swaps = raw(toEventSelector(SWAP)).map(decodeSwap);
const transfers = raw(toEventSelector(TRANSFER)).map(decodeTransfer);
const routers = swaps.map((s) => s.sender);
const system = new Set([...STATIC_SYSTEM, LAUNCHPAD, VAULT, ...routers].map((a) => a.toLowerCase()));

describe("decoding real Ascend events", () => {
  it("reads the launch", () => {
    expect(launches).toHaveLength(1);
    expect(launches[0]).toMatchObject({
      token: getAddress("0x2e920ca9bae146d4e3b75e70798e7ff85f913dc5"),
      quote: "0x4b4fb5C5794F0c821464956374cC5872D5F0f140",
      devBuyTokens: 12_361_870_231_740_386_597_400_926n,
    });
  });

  it("sees three swaps in two pools, sent by the launchpad (dev-buy) and the router", () => {
    expect(swaps).toHaveLength(3);
    expect(new Set(swaps.map((s) => s.poolId)).size).toBe(2);
    expect(new Set(routers)).toEqual(new Set([LAUNCHPAD, "0x90332B0ECbb2c9517F405627b0Dd5D5265246563"]));
  });
});

describe("assemble", () => {
  const [coin] = assemble({
    launches,
    pools: [],
    swaps,
    transfers,
    txFrom: new Map(Object.entries(fx.txs).map(([tx, t]) => [tx, getAddress(t.from)])),
    blockTime: new Map(Object.values(fx.txs).map((t) => [String(t.blockNumber), t.timestamp])),
    system,
    meta: new Map(),
  });

  it("keeps only the coin's own pool, and reads the dev-buy exactly as the launch event reports it", () => {
    const c = coin!;
    expect(c.trades).toHaveLength(2);
    const [dev, later] = c.trades;
    expect(dev).toMatchObject({ tx: LAUNCH_TX, side: "buy", trader: TRADER, holder: c.coin.creator });
    expect(dev!.tokens).toBe(launches[0]!.devBuyTokens);
    expect(later).toMatchObject({
      tx: TRADE_TX,
      side: "buy",
      trader: TRADER,
      holder: TRADER,
      tokens: 51_346_021_915_738_560_314_784_874n,
      quote: 494_410_990n, // 494.41 USDC, routed through USDC from another coin
      outside: false,
    });
  });

  it("fills the coin from the launch transaction", () => {
    expect(coin!.coin).toMatchObject({ launcher: TRADER, launchBlock: 6_965_388n, launchTime: fx.txs[LAUNCH_TX]!.timestamp, tokenIs0: true });
  });

  it("refuses to guess when a sender or a block time is missing", () => {
    expect(() => assemble({ launches, pools: [], swaps, transfers, txFrom: new Map(), blockTime: new Map(), system, meta: new Map() })).toThrow(/missing/);
  });
});

describe("holder of a trade", () => {
  const base = { launches, pools: [] as Pool[], swaps: [] as typeof swaps, system, meta: new Map() };
  const L = launches[0]!;
  const t = (from: string, to: string, value: bigint, logIndex: number) => ({
    token: L.token, tx: TRADE_TX as Hex, block: 1n, logIndex, from: getAddress(from), to: getAddress(to), value,
  });
  const swap = (amount: bigint) => ({ poolId: L.poolId, sender: getAddress(routers[1]!), amount0: amount, amount1: -amount, tx: TRADE_TX as Hex, block: 1n, logIndex: 0 });
  const run = (amount: bigint, ts: ReturnType<typeof t>[]) =>
    assemble({
      ...base,
      swaps: [swap(amount)],
      transfers: ts,
      txFrom: new Map([[LAUNCH_TX, TRADER], [TRADE_TX, TRADER]]),
      blockTime: new Map([["6965388", 1], ["1", 2]]),
    })[0]!.trades[0]!;
  const OTHER = "0x00000000000000000000000000000000000000b0";

  it("is where a buy's tokens ended up, even when that is not the sender", () => {
    expect(run(5n, [t(VAULT, routers[1]!, 5n, 1), t(routers[1]!, OTHER, 5n, 2)])).toMatchObject({ side: "buy", holder: getAddress(OTHER) });
  });

  it("is the sender when tokens only pass through contracts", () => {
    expect(run(5n, [t(VAULT, routers[1]!, 5n, 1)])).toMatchObject({ side: "buy", holder: TRADER });
  });

  it("is whoever gave up the tokens on a sell", () => {
    expect(run(-5n, [t(OTHER, VAULT, 5n, 1)])).toMatchObject({ side: "sell", holder: getAddress(OTHER), trader: TRADER });
  });
});

describe("trades outside Ascend's pools", () => {
  // Coin 0xb158… is an Ascend coin, but the router sold it in a hookless pool someone else opened.
  const init = fx.initialize[0]!;
  const pool = decodePool({ block: BigInt(init.blockNumber), logIndex: init.logIndex, tx: init.tx, address: init.address, topics: init.topics, data: init.data });
  const OUTSIDE_COIN = getAddress("0xb1581a8cea80989d7dae554ec48ae365907f964c");

  it("reads who opened the pool and with which currencies", () => {
    expect(pool).toMatchObject({ currency0: "0x4b4fb5C5794F0c821464956374cC5872D5F0f140", currency1: OUTSIDE_COIN, hooks: "0x0000000000000000000000000000000000000000" });
  });

  it("counts the trade for the coin, marked as outside", () => {
    const trade = fx.txs[TRADE_TX]!;
    const launch = { poolId: `0x${"11".repeat(32)}` as Hex, token: OUTSIDE_COIN, creator: TRADER, quote: pool.currency0, devBuyTokens: 0n, tx: TRADE_TX as Hex, block: BigInt(trade.blockNumber) };
    const [c] = assemble({
      launches: [launch],
      pools: [pool],
      swaps,
      transfers,
      txFrom: new Map([[TRADE_TX, TRADER]]),
      blockTime: new Map([[String(trade.blockNumber), trade.timestamp]]),
      system,
      meta: new Map(),
    });
    expect(c!.trades).toHaveLength(1);
    expect(c!.trades[0]).toMatchObject({ side: "sell", trader: TRADER, holder: TRADER, tokens: 80_430_908_921_066_935_913_323_865n, quote: 494_410_990n, outside: true });
  });
});
