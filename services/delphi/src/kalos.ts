// Kalos (Elysium's biggest DEX, a Uniswap V3 fork) read into DELPHI's shape, so the same three checks run
// on every coin traded there. A coin is any token in a Kalos pool that isn't a base currency (WHYPE,
// USDC, mUSDC). Its "launch" is the first liquidity added to any of its pools, and its creator is whoever
// deployed the token contract. Everything here is pure (tested with recorded fixtures); kalos-collect.ts
// does the fetching.
import { decodeEventLog, getAddress, parseAbiItem, toEventSelector, type Address, type Hex } from "viem";
import { LAUNCHED, TRANSFER, type AddressKind } from "./chain.ts";
import { holderOf, type CoinTransfer, type Skeleton } from "./ingest.ts";
import type { RawLog } from "./store.ts";
import type { Coin, TokenTransfer, Trade } from "./types.ts";

const lc = (a: string) => a.toLowerCase();

/** Kalos's contracts, checked live 2026-10-31 (api.kalos.fun/v2/dex/config). The API's list adds to these. */
export const KALOS = {
  api: "https://api.kalos.fun",
  factory: "0x520bF060F58ceE054f725877279328F5f73A7893",
  /** The factory's deployment block: no Kalos pool is older. */
  factoryBlock: 7_645_302n,
  positionManager: "0x28580f9baeDDBc88D3Daca542aF12271E52B5765",
  whype: "0xCD57F65c2B0e5881CFC2E609F7CD53b746E1F234",
  contracts: [
    "0x520bF060F58ceE054f725877279328F5f73A7893", // factory
    "0x28580f9baeDDBc88D3Daca542aF12271E52B5765", // positionManager (NFT positions)
    "0x752f6816Bc514e1Eeff852b2eAdcd96f6c0F9f3f", // swapRouter
    "0x8F09c090B202990F4Fb533539FFCaAc2b6eA72a7", // quoter
    "0x2b555398ac8BAf5d4B541EF12E565eF312739149", // quoterV2
    "0xe26eb915E3b9A17CF33214ca561fa71a13fA3eA7", // tickLens
    "0x8Ca3dAF82089F8B0D2A777EB1484A05132c3CF1f", // v3Migrator
    "0x82e90402e67a0375Fc29BE01CBF2D585D5f525dF", // nftDescriptor
    "0x30033EC300f2d9830f824B0Eedc3709e4a79d39d", // positionDescriptor
    "0xD60f87B1E97F0564aeb229b1AC11D0F03fAEC3Aa", // KalosSettler (swaps for the app)
    "0xF9bE56EF245De6061b23cb23a729D5623953A102", // KalosAllowanceHolder
    "0xCD57F65c2B0e5881CFC2E609F7CD53b746E1F234", // WHYPE
    "0xcA11bde05977b3631167028862bE2a173976CA11", // multicall3
  ] as Address[],
} as const;

/**
 * Currencies coins are priced in, never coins themselves. Confirmed on the live lists (Oct 31): WHYPE is
 * Kalos's wrapped native HYPE, USDC is its approved stablecoin (6 decimals), mUSDC is "Mock USDC
 * (Elysium testnet)" (6 decimals), and every pool's other side is one of these or another coin.
 */
export const BASE_TOKENS: readonly Address[] = [
  "0xCD57F65c2B0e5881CFC2E609F7CD53b746E1F234", // WHYPE
  "0x7D29d8047B905000459c0E80c34a26CeedcB47b2", // USDC
  "0x306eB30576814505df6cb0B35e4F4bfbACEeD54c", // mUSDC
  "0x757a34dd7b411546C6dd8f510B52e4381102f9B0", // PerpMe's own WHYPE: a Kalos pool holding it doesn't make it a coin
];

/** Addresses whose tokens or positions are gone for good. */
export const BURN: ReadonlySet<string> = new Set(["0x0000000000000000000000000000000000000000", "0x000000000000000000000000000000000000dead", "0xc889ac2f59a88afb3b2fb3f2c452dba336fe5f0f"]);

/**
 * How much of a coin's history to read. Elysium makes a block about every 0.11 s.
 *
 * Busy tokens: a token whose whole life would hold more than `fullMaxTransfers` Transfer events is read
 * in two windows only: its launch (from up to `preLaunchBlocks` before its first liquidity, to
 * `launchBlocks` after it) and the last `recentBlocks`. Its life is estimated from `probes` samples of
 * `probeBlocks` spread over it, once, and a full read stops at three times the limit if the samples were
 * wrong. Why 100,000: the node answers about 2,000 to 5,000 logs a second, and every trade also needs its
 * sender (100 per call), so 100,000 transfers is a few minutes on the first run; KALOS alone would be about
 * 2 million (Oct 31: 114,660 in its last 24 h).
 */
export const KALOS_READ = {
  recentBlocks: 785_000n, // ≈ 24 h
  launchBlocks: 6_000n, // ≈ 11 min after the first liquidity: the 30 s bundle window with plenty of room
  preLaunchBlocks: 785_000n, // ≈ 24 h before it: the deployer handing out tokens before trading opens
  probeBlocks: 20_000n, // ≈ 37 min each
  probes: 5,
  fullMaxTransfers: 100_000,
  /** A liquidity removal at least this share of the pool's liquidity is listed (the classic rug). */
  removalPct: 20,
} as const;

// Uniswap V3 events, as Kalos emits them.
export const POOL_CREATED = parseAbiItem("event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)");
/** V3 Swap. Amounts are the POOL's side: positive = the pool received it (the opposite of Ascend's). Checked live. */
export const V3_SWAP = parseAbiItem("event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)");
export const V3_MINT = parseAbiItem("event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)");
export const V3_BURN = parseAbiItem("event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)");
export const INCREASE = parseAbiItem("event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)");
export const DECREASE = parseAbiItem("event DecreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)");
/** ERC-721 Transfer: the same topic as an ERC-20 Transfer, with the token id as a fourth topic. */
export const NFT_TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)");
export const TOPIC = {
  poolCreated: toEventSelector(POOL_CREATED),
  swap: toEventSelector(V3_SWAP),
  mint: toEventSelector(V3_MINT),
  burn: toEventSelector(V3_BURN),
  increase: toEventSelector(INCREASE),
  decrease: toEventSelector(DECREASE),
  transfer: toEventSelector(TRANSFER),
  launched: toEventSelector(LAUNCHED),
};

export type KPool = { pool: Address; token0: Address; token1: Address; fee: number; tickSpacing: number; block: bigint; tx: Hex };
export type KSwap = { pool: Address; sender: Address; recipient: Address; amount0: bigint; amount1: bigint; sqrtPriceX96: bigint; tx: Hex; block: bigint; logIndex: number };
/** A pool Mint or Burn: liquidity added to or removed from one owner's price range. */
export type KLiq = {
  kind: "mint" | "burn";
  pool: Address;
  owner: Address;
  tickLower: number;
  tickUpper: number;
  amount: bigint;
  amount0: bigint;
  amount1: bigint;
  tx: Hex;
  block: bigint;
  logIndex: number;
};
/** The position manager's own events: liquidity per NFT position, and who holds each NFT. */
export type NpmEvent = { tx: Hex; block: bigint; logIndex: number } & (
  | { kind: "increase" | "decrease"; tokenId: bigint; liquidity: bigint; amount0: bigint; amount1: bigint }
  | { kind: "transfer"; tokenId: bigint; from: Address; to: Address }
);

const topicsOf = (l: RawLog) => l.topics as [Hex, ...Hex[]];

export function decodePoolCreated(l: RawLog): KPool {
  const { args } = decodeEventLog({ abi: [POOL_CREATED], topics: topicsOf(l), data: l.data });
  return { pool: args.pool, token0: args.token0, token1: args.token1, fee: args.fee, tickSpacing: args.tickSpacing, block: l.block, tx: l.tx };
}
export function decodeV3Swap(l: RawLog): KSwap {
  const { args } = decodeEventLog({ abi: [V3_SWAP], topics: topicsOf(l), data: l.data });
  return { pool: getAddress(l.address), sender: args.sender, recipient: args.recipient, amount0: args.amount0, amount1: args.amount1, sqrtPriceX96: args.sqrtPriceX96, tx: l.tx, block: l.block, logIndex: l.logIndex };
}
export function decodeLiq(l: RawLog): KLiq {
  const at = { pool: getAddress(l.address), tx: l.tx, block: l.block, logIndex: l.logIndex };
  if (l.topics[0] === TOPIC.mint) {
    const { args } = decodeEventLog({ abi: [V3_MINT], topics: topicsOf(l), data: l.data });
    return { kind: "mint", ...at, owner: args.owner, tickLower: args.tickLower, tickUpper: args.tickUpper, amount: args.amount, amount0: args.amount0, amount1: args.amount1 };
  }
  const { args } = decodeEventLog({ abi: [V3_BURN], topics: topicsOf(l), data: l.data });
  return { kind: "burn", ...at, owner: args.owner, tickLower: args.tickLower, tickUpper: args.tickUpper, amount: args.amount, amount0: args.amount0, amount1: args.amount1 };
}
export function decodeNpm(l: RawLog): NpmEvent {
  const at = { tx: l.tx, block: l.block, logIndex: l.logIndex };
  if (l.topics[0] === TOPIC.transfer) {
    const { args } = decodeEventLog({ abi: [NFT_TRANSFER], topics: topicsOf(l), data: l.data });
    return { kind: "transfer", ...at, tokenId: args.tokenId, from: args.from, to: args.to };
  }
  const increase = l.topics[0] === TOPIC.increase;
  const { args } = decodeEventLog({ abi: [increase ? INCREASE : DECREASE], topics: topicsOf(l), data: l.data });
  return { kind: increase ? "increase" : "decrease", ...at, tokenId: args.tokenId, liquidity: args.liquidity, amount0: args.amount0, amount1: args.amount1 };
}

/**
 * Buy or sell, from the trader's side. Kalos reports the pool's own deltas: a positive token amount means
 * the pool received tokens, so the trader sold. That is the opposite of Ascend's pool manager. Checked
 * live against the Transfer logs in the same transaction (pinned by test/kalos.test.ts).
 */
export function sideOf(tokenDelta: bigint, quoteDelta: bigint): "buy" | "sell" {
  return tokenDelta < 0n || (tokenDelta === 0n && quoteDelta > 0n) ? "buy" : "sell";
}

/** Block ranges read for a busy coin, both ends included. */
export type Window = readonly [from: bigint, to: bigint];
export const inWindows = (block: bigint, windows: readonly Window[] | undefined) => !windows || windows.some(([a, b]) => block >= a && block <= b);
const chain = (a: { block: bigint; logIndex: number }, b: { block: bigint; logIndex: number }) => (a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1);

/** The pools that hold a token. */
export const poolsOf = (token: string, pools: readonly KPool[]) => pools.filter((p) => lc(p.token0) === lc(token) || lc(p.token1) === lc(token));

/**
 * Which tokens in Kalos pools are coins: every token that isn't a base currency. Ascend coins are kept
 * apart (`ascend`): they are checked as Ascend coins, with their Kalos trades added as outside trades.
 */
export function coinsOf(pools: readonly KPool[], ascendTokens: ReadonlySet<string>, base: readonly string[] = BASE_TOKENS): { kalos: Address[]; ascend: Address[] } {
  const skip = new Set(base.map(lc));
  const tokens = [...new Map(pools.flatMap((p) => [p.token0, p.token1]).filter((t) => !skip.has(lc(t))).map((t) => [lc(t), t])).values()];
  return { kalos: tokens.filter((t) => !ascendTokens.has(lc(t))), ascend: tokens.filter((t) => ascendTokens.has(lc(t))) };
}

/** A coin's launch on Kalos: the first liquidity added to any of its pools. */
export function launchOf(token: string, pools: readonly KPool[], liq: readonly KLiq[]): KLiq | null {
  const own = new Set(poolsOf(token, pools).map((p) => lc(p.pool)));
  return liq.filter((l) => l.kind === "mint" && l.amount > 0n && own.has(lc(l.pool))).sort(chain)[0] ?? null;
}

const need = <V>(m: ReadonlyMap<string, V>, k: string, what: string): V => {
  const v = m.get(k);
  if (v === undefined) throw new Error(`missing ${what} for ${k}`);
  return v;
};

/** One token's trades in the given pools, oldest first (`outside`: marks them as trades outside its home market). */
function tradesOf(
  token: Address,
  pools: readonly KPool[],
  swaps: readonly KSwap[],
  byTx: ReadonlyMap<string, TokenTransfer[]>,
  input: { txFrom: ReadonlyMap<string, Address>; blockTime: ReadonlyMap<string, number>; system: ReadonlySet<string> },
  windows: readonly Window[] | undefined,
  outside: boolean,
): Trade[] {
  const is0 = new Map(pools.map((p) => [lc(p.pool), lc(p.token0) === lc(token)]));
  return swaps
    .filter((s) => is0.has(lc(s.pool)) && inWindows(s.block, windows))
    .sort(chain)
    .map((s): Trade => {
      const token0 = is0.get(lc(s.pool))!;
      const tokenDelta = token0 ? s.amount0 : s.amount1;
      const quoteDelta = token0 ? s.amount1 : s.amount0;
      const side = sideOf(tokenDelta, quoteDelta);
      const trader = need(input.txFrom, lc(s.tx), "swap sender");
      return {
        tx: s.tx,
        block: s.block,
        logIndex: s.logIndex,
        time: need(input.blockTime, s.block.toString(), "block time"),
        side,
        trader,
        holder: holderOf(side, byTx.get(lc(s.tx)) ?? [], input.system, trader),
        tokens: tokenDelta < 0n ? -tokenDelta : tokenDelta,
        quote: quoteDelta < 0n ? -quoteDelta : quoteDelta,
        pool: s.pool,
        outside,
      };
    });
}

/** A token to read as a Kalos coin, with what collect learned about it. */
export type KalosToken = {
  token: Address;
  /** Who deployed the token contract. Null if unknown: the first liquidity's sender stands in as creator. */
  deployer: Address | null;
  name: string | null;
  symbol: string | null;
  /** totalSupply() at the head. */
  supply: bigint;
  /** Block ranges read (launch and recent), for a busy coin; unset = its whole history. */
  windows?: readonly Window[];
  /** The first block of the recent window, for a busy coin. */
  windowFrom?: bigint;
  /** Balances read from the token, for a busy coin (see CoinData.holdings). */
  holdings?: ReadonlyMap<string, bigint>;
};

export type KalosInput = {
  tokens: readonly KalosToken[];
  pools: readonly KPool[];
  swaps: readonly KSwap[];
  /** Pool Mints and Burns (the launch is the first Mint). */
  liquidity: readonly KLiq[];
  transfers: readonly CoinTransfer[];
  txFrom: ReadonlyMap<string, Address>;
  blockTime: ReadonlyMap<string, number>;
  system: ReadonlySet<string>;
  contracts?: ReadonlySet<string>;
  /** Each pool's balance of a token at the head, keyed `pool:token` (lowercase): picks the main pool. */
  reserves?: ReadonlyMap<string, bigint>;
};

/**
 * The pool a coin mostly trades in: priced in a base currency if any is (a KALOS/stKALOS pool holds the
 * most KALOS, but its price is in another coin), then the one holding the most of the coin (amounts of the
 * same token, so pools priced in different currencies compare fairly), then the most traded, the oldest.
 */
export function mainPool(token: Address, pools: readonly KPool[], trades: readonly Trade[], reserves?: ReadonlyMap<string, bigint>, base: readonly string[] = BASE_TOKENS): KPool {
  const traded = new Map<string, bigint>();
  for (const t of trades) traded.set(lc(t.pool), (traded.get(lc(t.pool)) ?? 0n) + t.tokens);
  const isBase = new Set(base.map(lc));
  const priced = (p: KPool) => isBase.has(lc(lc(p.token0) === lc(token) ? p.token1 : p.token0));
  const key = (p: KPool) => [reserves?.get(`${lc(p.pool)}:${lc(token)}`) ?? 0n, traded.get(lc(p.pool)) ?? 0n] as const;
  return [...pools].sort((a, b) => {
    if (priced(a) !== priced(b)) return priced(a) ? -1 : 1;
    const [ra, va] = key(a);
    const [rb, vb] = key(b);
    if (ra !== rb) return rb > ra ? 1 : -1;
    if (va !== vb) return vb > va ? 1 : -1;
    return chain({ block: a.block, logIndex: 0 }, { block: b.block, logIndex: 0 });
  })[0]!;
}

/**
 * One coin per Kalos token with liquidity: its trades in every Kalos pool that holds it (`outside: false`,
 * each with its own `pool`), its transfers, and for a busy coin only what falls in its windows, with
 * balances read from the token. A token whose pools never got liquidity has no launch and is left out.
 */
export function assembleKalos(input: KalosInput): Skeleton[] {
  const transfersByToken = Map.groupBy(input.transfers, (t) => lc(t.token));
  const out: Skeleton[] = [];
  for (const k of input.tokens) {
    const pools = poolsOf(k.token, input.pools);
    const launch = launchOf(k.token, input.pools, input.liquidity);
    if (!pools.length || !launch) continue;
    const transfers: TokenTransfer[] = (transfersByToken.get(lc(k.token)) ?? [])
      .filter((t) => inWindows(t.block, k.windows))
      .sort(chain)
      .map(({ token: _token, ...t }) => t);
    const byTx = Map.groupBy(transfers, (t) => lc(t.tx));
    const trades = tradesOf(k.token, pools, input.swaps, byTx, input, k.windows, false);
    const main = mainPool(k.token, pools, trades, input.reserves);
    const launcher = need(input.txFrom, lc(launch.tx), "launch sender");
    const coin: Coin = {
      token: k.token,
      poolId: lc(main.pool) as Hex,
      tokenIs0: lc(main.token0) === lc(k.token),
      creator: k.deployer ?? launcher,
      launcher,
      launchTx: launch.tx,
      launchBlock: launch.block,
      launchTime: need(input.blockTime, launch.block.toString(), "block time"),
      devBuyTokens: 0n,
      name: k.name,
      symbol: k.symbol,
      market: "kalos",
      supply: k.supply,
      ...(k.windowFrom !== undefined ? { windowFrom: k.windowFrom } : {}),
    };
    out.push({
      coin,
      trades,
      transfers,
      system: input.system,
      ...(input.contracts ? { contracts: input.contracts } : {}),
      ...(k.holdings ? { holdings: k.holdings } : {}),
    });
  }
  return out;
}

/**
 * Trades of Ascend coins in Kalos pools (token, lowercase → trades), marked `outside` with the Kalos pool
 * as `pool`, so they can join the Ascend coin's own trades. `transfers`: the coin's transfers in those
 * transactions, to find whose balance each trade changed.
 */
export function ascendTradesOnKalos(input: {
  tokens: readonly Address[];
  pools: readonly KPool[];
  swaps: readonly KSwap[];
  transfers: readonly CoinTransfer[];
  txFrom: ReadonlyMap<string, Address>;
  blockTime: ReadonlyMap<string, number>;
  system: ReadonlySet<string>;
}): Map<string, Trade[]> {
  const out = new Map<string, Trade[]>();
  for (const token of input.tokens) {
    const pools = poolsOf(token, input.pools);
    const byTx = Map.groupBy(
      input.transfers.filter((t) => lc(t.token) === lc(token)).map(({ token: _t, ...t }) => t),
      (t) => lc(t.tx),
    );
    const trades = tradesOf(token, pools, input.swaps, byTx, input, undefined, true);
    if (trades.length) out.set(lc(token), trades);
  }
  return out;
}

/** A liquidity position: an NFT from the position manager, or a range minted straight on the pool. */
export type Position = {
  /** "nft:<tokenId>", or "<pool>:<owner>:<tickLower>:<tickUpper>" for a direct one (lowercase). */
  id: string;
  pool: Address;
  /** Who holds it now: the NFT's holder, or the direct position's owner. */
  owner: Address;
  via: "nft" | "direct";
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
};

/** Liquidity added (delta > 0) or removed (< 0), with the pool's total just before. */
export type LiquidityChange = {
  pool: Address;
  position: string;
  /** Who held the position at that moment. */
  owner: Address;
  tx: Hex;
  block: bigint;
  logIndex: number;
  delta: bigint;
  amount0: bigint;
  amount1: bigint;
  /** The pool's total position liquidity just before this change. */
  before: bigint;
};

/**
 * Every position's liquidity and holder, replayed from the pools' Mints and Burns and the position
 * manager's events. An NFT's liquidity change is tied to its pool by the pool event the manager caused
 * in the same transaction (the same amount, just before it). `unmatched`: manager events with no such
 * pool event (their pool is unknown, so they are left out).
 */
export function positionsOf(liq: readonly KLiq[], npm: readonly NpmEvent[], positionManager: Address): { positions: Map<string, Position>; changes: LiquidityChange[]; unmatched: number } {
  const pm = lc(positionManager);
  // The manager's own pool events, by transaction, to match against its IncreaseLiquidity/DecreaseLiquidity.
  const viaPm = Map.groupBy(liq.filter((l) => lc(l.owner) === pm && l.amount > 0n), (l) => lc(l.tx));
  const used = new Set<KLiq>();
  const events = [...liq.map((l) => ({ src: "pool" as const, e: l })), ...npm.map((e) => ({ src: "npm" as const, e }))].sort((a, b) => chain(a.e, b.e));

  const positions = new Map<string, Position>();
  const nftOwner = new Map<string, Address>();
  const nftPool = new Map<string, KLiq>();
  const total = new Map<string, bigint>();
  const changes: LiquidityChange[] = [];
  let unmatched = 0;
  const apply = (p: Omit<Position, "liquidity" | "owner">, owner: Address, delta: bigint, ev: { tx: Hex; block: bigint; logIndex: number; amount0: bigint; amount1: bigint }) => {
    const cur = positions.get(p.id) ?? { ...p, owner, liquidity: 0n };
    const before = total.get(lc(p.pool)) ?? 0n;
    positions.set(p.id, { ...cur, owner, liquidity: cur.liquidity + delta });
    total.set(lc(p.pool), before + delta);
    changes.push({ pool: p.pool, position: p.id, owner, tx: ev.tx, block: ev.block, logIndex: ev.logIndex, delta, amount0: ev.amount0, amount1: ev.amount1, before });
  };

  for (const { src, e } of events) {
    if (src === "pool") {
      if (lc(e.owner) === pm || e.amount === 0n) continue;
      const id = `${lc(e.pool)}:${lc(e.owner)}:${e.tickLower}:${e.tickUpper}`;
      apply({ id, pool: e.pool, via: "direct", tickLower: e.tickLower, tickUpper: e.tickUpper }, e.owner, e.kind === "mint" ? e.amount : -e.amount, e);
      continue;
    }
    const id = `nft:${e.tokenId}`;
    if (e.kind === "transfer") {
      nftOwner.set(id, e.to);
      const p = positions.get(id);
      if (p) positions.set(id, { ...p, owner: e.to });
      continue;
    }
    if (e.liquidity === 0n) continue;
    const kind = e.kind === "increase" ? "mint" : "burn";
    const match = (viaPm.get(lc(e.tx)) ?? [])
      .filter((l) => l.kind === kind && l.amount === e.liquidity && l.logIndex < e.logIndex && !used.has(l))
      .sort((a, b) => b.logIndex - a.logIndex)[0];
    if (match) used.add(match);
    const range = match ?? nftPool.get(id);
    if (!range) {
      unmatched++;
      continue;
    }
    nftPool.set(id, range);
    const owner = nftOwner.get(id) ?? getAddress(positionManager);
    apply({ id, pool: range.pool, via: "nft", tickLower: range.tickLower, tickUpper: range.tickUpper }, owner, kind === "mint" ? e.liquidity : -e.liquidity, e);
  }
  return { positions, changes, unmatched };
}

/**
 * sqrt(1.0001^tick) × 2^96, exactly as Uniswap V3's TickMath.getSqrtRatioAtTick (pinned by tests at the
 * tick limits and against live Kalos pools' slot0).
 */
export function sqrtRatioAtTick(tick: number): bigint {
  const abs = BigInt(Math.abs(tick));
  if (abs > 887_272n) throw new RangeError(`tick ${tick} out of range`);
  const steps: Array<[bigint, bigint]> = [
    [0x2n, 0xfff97272373d413259a46990580e213an],
    [0x4n, 0xfff2e50f5f656932ef12357cf3c7fdccn],
    [0x8n, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
    [0x10n, 0xffcb9843d60f6159c9db58835c926644n],
    [0x20n, 0xff973b41fa98c081472e6896dfb254c0n],
    [0x40n, 0xff2ea16466c96a3843ec78b326b52861n],
    [0x80n, 0xfe5dee046a99a2a811c461f1969c3053n],
    [0x100n, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
    [0x200n, 0xf987a7253ac413176f2b074cf7815e54n],
    [0x400n, 0xf3392b0822b70005940c7a398e4b70f3n],
    [0x800n, 0xe7159475a2c29b7443b29c7fa6e889d9n],
    [0x1000n, 0xd097f3bdfd2022b8845ad8f792aa5825n],
    [0x2000n, 0xa9f746462d870fdf8a65dc1f90e061e5n],
    [0x4000n, 0x70d869a156d2a1b890bb3df62baf32f7n],
    [0x8000n, 0x31be135f97d08fd981231505542fcfa6n],
    [0x10000n, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
    [0x20000n, 0x5d6af8dedb81196699c329225ee604n],
    [0x40000n, 0x2216e584f5fa1ea926041bedfe98n],
    [0x80000n, 0x48a170391f7dc42444e8fa2n],
  ];
  let ratio = abs & 0x1n ? 0xfffcb933bd6fad37aa2d162d1a594001n : 1n << 128n;
  for (const [bit, factor] of steps) if (abs & bit) ratio = (ratio * factor) >> 128n;
  if (tick > 0) ratio = ((1n << 256n) - 1n) / ratio;
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

const Q96 = 1n << 96n;

/** The tokens a position holds at a price (Uniswap V3's LiquidityAmounts.getAmountsForLiquidity, rounded down). */
export function amountsOf(liquidity: bigint, tickLower: number, tickUpper: number, sqrtP: bigint): [amount0: bigint, amount1: bigint] {
  const a = sqrtRatioAtTick(tickLower);
  const b = sqrtRatioAtTick(tickUpper);
  const in0 = (lo: bigint, hi: bigint) => (((liquidity * Q96) * (hi - lo)) / hi) / lo;
  const in1 = (lo: bigint, hi: bigint) => (liquidity * (hi - lo)) / Q96;
  if (sqrtP <= a) return [in0(a, b), 0n];
  if (sqrtP >= b) return [0n, in1(a, b)];
  return [in0(sqrtP, b), in1(a, sqrtP)];
}

/** a / b as a percentage with 2 decimals. */
const pct = (a: bigint, b: bigint) => (b === 0n ? 0 : Number((a * 10_000n) / b) / 100);
const Q192 = 1n << 192n;

/** Who an LP owner is to the coin. */
export type LpRole = "creator" | "deployer" | "launcher";
export type LpOwnerKind = "wallet" | "contract" | "pool" | "burn" | "unknown";
export type LpPosition = {
  owner: Address;
  position: string;
  liquidity: bigint;
  /** Share of the pool, by value at the current price (see PoolLiquidity.shareBy). */
  sharePct: number;
  /** What the position holds at the current price, of the coin and of the other currency (null: no price). */
  tokens: bigint | null;
  quote: bigint | null;
  tickLower: number;
  tickUpper: number;
  fullRange: boolean;
  roles: LpRole[];
  ownerKind: LpOwnerKind;
};
/** One owner's positions in a pool, together. */
export type LpOwner = { owner: Address; positions: number; sharePct: number; roles: LpRole[]; ownerKind: LpOwnerKind };
/**
 * Liquidity taken out. `sharePct` is of the pool's liquidity units just before (exact for positions over
 * the same range; on Oct 31, 16,087 of 16,772 open Kalos positions were full range). `tokens` and `quote`
 * are what came out, from the event itself.
 */
export type Removal = { tx: Hex; block: bigint; time: number | null; owner: Address; position: string; liquidity: bigint; sharePct: number; tokens: bigint; quote: bigint };

/** One pool of a coin. */
export type PoolLiquidity = {
  pool: Address;
  fee: number;
  quote: Address;
  quoteSymbol: string | null;
  tokenIs0: boolean;
  createdBlock: bigint;
  /** balanceOf the pool at the head (includes fees not yet collected). */
  tokenReserve: bigint | null;
  quoteReserve: bigint | null;
  /** Total value locked in HYPE (wei), when the quote is WHYPE: the WHYPE plus the coin at the pool's price. */
  tvlHype: bigint | null;
  /**
   * How shares are measured: "value" = what each position holds at the current price, in the quote
   * currency (V3 tick maths, checked live: the positions add up to 97-99.99% of most pools' balances, the
   * rest being uncollected fees); "liquidity" = liquidity units, when the pool has no price.
   */
  shareBy: "value" | "liquidity";
  /** Sum of every open position's liquidity. */
  totalLiquidity: bigint;
  openPositions: number;
  /** The biggest open positions and owners, first 10 of each. */
  top: LpPosition[];
  topOwners: LpOwner[];
  owners: number;
  adds: number;
  removes: number;
  firstAdd: { tx: Hex; block: bigint; time: number | null } | null;
  lastRemove: { tx: Hex; block: bigint; time: number | null } | null;
  /** Removals of at least KALOS_READ.removalPct of the pool's liquidity, oldest first. */
  bigRemovals: Removal[];
};

export type LiquidityReport = {
  token: Address;
  symbol: string | null;
  decimals: number | null;
  supply: bigint;
  /** totalSupply() at the launch block, when it differs from now (minted or burned since). */
  supplyAtLaunch: bigint | null;
  /** How the coin was read: its whole history, or two windows (inclusive blocks). */
  read: { full: true } | { full: false; launch: Window; recent: Window };
  pools: PoolLiquidity[];
  /** Different owners of open positions across all the coin's pools. */
  lpOwners: number;
  /** Plain-English notes about this coin's data. */
  notes: string[];
};

/** A coin's pools with their reserves, value, LP positions and the liquidity added and removed. */
export function liquidityReport(input: {
  token: Address;
  symbol: string | null;
  decimals: number | null;
  supply: bigint;
  supplyAtLaunch: bigint | null;
  read: LiquidityReport["read"];
  pools: readonly KPool[];
  positions: ReadonlyMap<string, Position>;
  changes: readonly LiquidityChange[];
  /** `pool:token` (lowercase) → balanceOf at the head. */
  reserves: ReadonlyMap<string, bigint>;
  /** pool (lowercase) → sqrtPriceX96 at the head. */
  prices: ReadonlyMap<string, bigint>;
  roles: Partial<Record<LpRole, Address>>;
  kinds: ReadonlyMap<string, AddressKind>;
  symbols: ReadonlyMap<string, string | null>;
  blockTime: ReadonlyMap<string, number>;
  whype?: Address;
  notes?: string[];
}): LiquidityReport {
  const whype = lc(input.whype ?? KALOS.whype);
  const at = (c: { tx: Hex; block: bigint }) => ({ tx: c.tx, block: c.block, time: input.blockTime.get(c.block.toString()) ?? null });
  const kindOf = (a: string): LpOwnerKind => (BURN.has(lc(a)) ? "burn" : (input.kinds.get(lc(a)) ?? "unknown"));
  const rolesOf = (a: string) => (Object.entries(input.roles) as Array<[LpRole, Address | undefined]>).filter(([, w]) => w && lc(w) === lc(a)).map(([r]) => r);
  const pools = poolsOf(input.token, input.pools).map((p): PoolLiquidity => {
    const tokenIs0 = lc(p.token0) === lc(input.token);
    const quote = tokenIs0 ? p.token1 : p.token0;
    const tokenReserve = input.reserves.get(`${lc(p.pool)}:${lc(input.token)}`) ?? null;
    const quoteReserve = input.reserves.get(`${lc(p.pool)}:${lc(quote)}`) ?? null;
    const sqrtP = input.prices.get(lc(p.pool));
    let tvlHype: bigint | null = null;
    if (lc(quote) === whype && sqrtP && tokenReserve !== null && quoteReserve !== null) {
      const tokenInQuote = tokenIs0 ? (tokenReserve * sqrtP * sqrtP) / Q192 : (tokenReserve * Q192) / (sqrtP * sqrtP);
      tvlHype = quoteReserve + tokenInQuote;
    }
    // Each open position's tokens at the current price, and their value in the quote currency.
    const held = [...input.positions.values()]
      .filter((x) => lc(x.pool) === lc(p.pool) && x.liquidity > 0n)
      .map((x) => {
        if (!sqrtP) return { x, tokens: null, quote: null, weight: x.liquidity };
        const [a0, a1] = amountsOf(x.liquidity, x.tickLower, x.tickUpper, sqrtP);
        const [tokens, quote] = tokenIs0 ? [a0, a1] : [a1, a0];
        const tokenInQuote = tokenIs0 ? (tokens * sqrtP * sqrtP) / Q192 : (tokens * Q192) / (sqrtP * sqrtP);
        return { x, tokens, quote, weight: quote + tokenInQuote };
      })
      .sort((a, b) => (b.weight > a.weight ? 1 : b.weight < a.weight ? -1 : 0));
    const totalWeight = held.reduce((s, h) => s + h.weight, 0n);
    const totalLiquidity = held.reduce((s, h) => s + h.x.liquidity, 0n);
    const full = (x: Position) => x.tickLower - p.tickSpacing < -887_272 && x.tickUpper + p.tickSpacing > 887_272;
    const byOwner = new Map<string, { owner: Address; positions: number; weight: bigint }>();
    for (const h of held) {
      const o = byOwner.get(lc(h.x.owner)) ?? { owner: h.x.owner, positions: 0, weight: 0n };
      byOwner.set(lc(h.x.owner), { ...o, positions: o.positions + 1, weight: o.weight + h.weight });
    }
    const changes = input.changes.filter((c) => lc(c.pool) === lc(p.pool));
    const adds = changes.filter((c) => c.delta > 0n);
    const removes = changes.filter((c) => c.delta < 0n);
    const bigRemovals = removes
      .filter((c) => c.before > 0n && pct(-c.delta, c.before) >= KALOS_READ.removalPct)
      .map((c): Removal => ({
        ...at(c),
        owner: c.owner,
        position: c.position,
        liquidity: -c.delta,
        sharePct: pct(-c.delta, c.before),
        tokens: tokenIs0 ? c.amount0 : c.amount1,
        quote: tokenIs0 ? c.amount1 : c.amount0,
      }));
    return {
      pool: p.pool,
      fee: p.fee,
      quote,
      quoteSymbol: input.symbols.get(lc(quote)) ?? null,
      tokenIs0,
      createdBlock: p.block,
      tokenReserve,
      quoteReserve,
      tvlHype,
      shareBy: sqrtP ? "value" : "liquidity",
      totalLiquidity,
      openPositions: held.length,
      top: held.slice(0, 10).map(({ x, tokens, quote, weight }) => ({
        owner: x.owner,
        position: x.id,
        liquidity: x.liquidity,
        sharePct: pct(weight, totalWeight),
        tokens,
        quote,
        tickLower: x.tickLower,
        tickUpper: x.tickUpper,
        fullRange: full(x),
        roles: rolesOf(x.owner),
        ownerKind: kindOf(x.owner),
      })),
      topOwners: [...byOwner.values()]
        .sort((a, b) => (b.weight > a.weight ? 1 : b.weight < a.weight ? -1 : 0))
        .slice(0, 10)
        .map((o) => ({ owner: o.owner, positions: o.positions, sharePct: pct(o.weight, totalWeight), roles: rolesOf(o.owner), ownerKind: kindOf(o.owner) })),
      owners: byOwner.size,
      adds: adds.length,
      removes: removes.length,
      firstAdd: adds[0] ? at(adds[0]) : null,
      lastRemove: removes.length ? at(removes.at(-1)!) : null,
      bigRemovals,
    };
  });
  return {
    token: input.token,
    symbol: input.symbol,
    decimals: input.decimals,
    supply: input.supply,
    supplyAtLaunch: input.supplyAtLaunch,
    read: input.read,
    pools,
    lpOwners: new Set([...input.positions.values()].filter((x) => x.liquidity > 0n && pools.some((p) => lc(p.pool) === lc(x.pool))).map((x) => lc(x.owner))).size,
    notes: input.notes ?? [],
  };
}
