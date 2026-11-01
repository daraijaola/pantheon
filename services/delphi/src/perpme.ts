// PerpMe (perpme.fun), the launchpad whose coins fill Kalos's Sniper, read into DELPHI's shape so the same
// three checks run on its coins. One transaction makes everything: the token, its pool on PerpMe's own
// Uniswap V3 copy, a single-sided liquidity position sent to PerpMe's locker for good, and the creator's
// first buy. So a coin's launch is its TokenLaunched event, its creator is the deployer that event names,
// and its trades are the V3 Swaps in the one pool that event names. Everything here is pure (tested with
// recorded fixtures); perpme-collect.ts does the fetching.
import { decodeEventLog, getAddress, toEventSelector, type Address, type Hex } from "viem";
import { holderOf, type CoinTransfer, type Skeleton } from "./ingest.ts";
import { amountsOf, BURN, sideOf, type KSwap, type Position } from "./kalos.ts";
import { PERPME_TESTNET, TOKEN_DEPLOYED, TOKEN_LAUNCHED } from "./live/types.ts";
import type { RawLog } from "./store.ts";
import type { Coin, TokenTransfer, Trade } from "./types.ts";

const lc = (a: string) => a.toLowerCase();

/**
 * PerpMe's testnet contracts: the ones Kalos pins (live/types.ts PERPME_TESTNET) plus those its docs list
 * (perpme.fun/elysium/docs, read 2026-10-31) that Kalos doesn't need. Every address changes on mainnet.
 */
export const PERPME = {
  ...PERPME_TESTNET,
  /** Holds every coin's LP position forever ("no withdrawal function"; fee collection only). */
  locker: "0x9277340f050ea8523c9e6aa069182de8aed119c8",
  /** Performs the CREATE2 that makes each coin (every coin is its own contract, not a proxy). */
  coinDeployer: "0x2cef3b6ee12a96f1fbcd58c8937b27032da17399",
  /** PerpMe's Multicall3: its getBlockNumber() answers the parent chain's block, the one the window counts. */
  multicall3: "0x60f94a264779d5F957B36F54D90aFb53693b56D4",
  /**
   * The first launchpad and its locker ("superseded" in the docs, yet 269 launches up to Oct 31, the same
   * events). Not read as a coin source by default (Kalos's Sniper pins only `launchFactory`), but its
   * addresses are PerpMe infrastructure.
   */
  oldLaunchFactory: "0x5644D1043998E602f582e3b282f1185102A6499E",
  oldLocker: "0xc627cf00e4ac649db40348c515a500c534cfa187",
  /** PerpMe's free data API (cross-checks only: the chain is the source of truth). */
  api: "https://perpme.fun/elysium/dex-sync",
} as const;

/** Every PerpMe contract: infrastructure, never a holder or a trader. Every PerpMe pool is added on top. */
export const PERPME_CONTRACTS: readonly Address[] = [
  PERPME.launchFactory,
  PERPME.poolFactory,
  PERPME.positionManager,
  PERPME.router,
  PERPME.quoter,
  PERPME.whype,
  PERPME.locker,
  PERPME.coinDeployer,
  PERPME.multicall3,
  PERPME.oldLaunchFactory,
  PERPME.oldLocker,
].map((a) => getAddress(a));

/**
 * What PerpMe coins are priced in on the current factory (checked on all 1,530 launches): its own WHYPE,
 * Kalos's USDC, and KALOS. A coin is only ever a launched token, so these are never PerpMe coins. Of the
 * three, only PerpMe's WHYPE is a currency everywhere: it is not Kalos's WHYPE, so a Kalos pool holding it
 * must not make it a Kalos coin either (add PERPME_BASE_TOKENS to kalos.ts coinsOf's base list when merging).
 * KALOS stays a coin on Kalos.
 */
export const PERPME_QUOTES: readonly Address[] = [getAddress(PERPME.whype), "0x7D29d8047B905000459c0E80c34a26CeedcB47b2", "0x8a2201953AF29e8BE7700bcB53dA3ce5caD18726"];
export const PERPME_BASE_TOKENS: readonly Address[] = [getAddress(PERPME.whype)];

/**
 * What PerpMe's docs and contracts say about every launch, checked live (Oct 31):
 * - the supply is 1,000,000,000 coins (18 decimals), all of it put in the pool;
 * - dexId 0 is the 1% pool, dexId 1 the 2% one;
 * - launch protection: until `restrictionEndBlock`, 366 blocks of the parent chain (HyperEVM, about
 *   6 minutes) after the launch, no wallet may hold more than 2% of the supply. The coin answers
 *   restrictionsActive() and maxWalletAmount() (20,000,000 coins) itself. Inside an Elysium contract
 *   `block.number` is the parent chain's block, so the window is counted in parent blocks, which every
 *   Elysium block header carries as `l1BlockNumber`.
 * - The cap starts after the creator's own buy in the launch transaction, so that buy is not capped:
 *   30 of the 212 coins that aren't xStocks opened with a creator buy above 2% (up to 89%).
 */
export const PERPME_RULES = {
  supply: 1_000_000_000n * 10n ** 18n,
  decimals: 18,
  feeOfDex: { 0: 10_000, 1: 20_000 } as Readonly<Record<number, number>>,
  restrictionBlocks: 366n,
  maxWalletBps: 200n,
  /** A coin with more transfers than this would need the busy-coin windows Kalos uses (none is near it: see collect's note). */
  busyTransfers: 250_000,
} as const;

export const PERPME_TOPIC = { deployed: toEventSelector(TOKEN_DEPLOYED), launched: toEventSelector(TOKEN_LAUNCHED) };

const topicsOf = (l: RawLog) => l.topics as [Hex, ...Hex[]];

/** TokenDeployed: a coin exists, with the name, symbol and metadata link its creator chose (untrusted text). */
export type PerpmeDeployed = {
  factory: Address;
  token: Address;
  deployer: Address;
  pairToken: Address;
  dexId: bigint;
  launchConfigId: bigint;
  name: string;
  symbol: string;
  metadataURI: string;
  tx: Hex;
  block: bigint;
  logIndex: number;
};

/** TokenLaunched: its pool is open; where the pool, the LP position, the window and the creator's buy come from. */
export type PerpmeLaunched = {
  factory: Address;
  token: Address;
  deployer: Address;
  pool: Address;
  pairToken: Address;
  dexId: bigint;
  launchConfigId: bigint;
  positionId: bigint;
  /** A parent-chain (HyperEVM) block number, not an Elysium one. */
  restrictionEndBlock: bigint;
  /** What the creator paid, in the pair token's smallest unit (USDC has 6 decimals). */
  initialBuyAmount: bigint;
  /** What the creator got, in the coin's smallest unit. */
  initialBuyTokens: bigint;
  tx: Hex;
  block: bigint;
  logIndex: number;
};

export function decodeDeployed(l: RawLog): PerpmeDeployed {
  const { args } = decodeEventLog({ abi: [TOKEN_DEPLOYED], topics: topicsOf(l), data: l.data });
  return {
    factory: getAddress(l.address),
    token: args.token,
    deployer: args.deployer,
    pairToken: args.pairToken,
    dexId: args.dexId,
    launchConfigId: args.launchConfigId,
    name: args.name,
    symbol: args.symbol,
    metadataURI: args.metadataURI,
    tx: l.tx,
    block: l.block,
    logIndex: l.logIndex,
  };
}

export function decodeLaunched(l: RawLog): PerpmeLaunched {
  const { args } = decodeEventLog({ abi: [TOKEN_LAUNCHED], topics: topicsOf(l), data: l.data });
  return {
    factory: getAddress(l.address),
    token: args.token,
    deployer: args.deployer,
    pool: args.pool,
    pairToken: args.pairToken,
    dexId: args.dexId,
    launchConfigId: args.launchConfigId,
    positionId: args.positionId,
    restrictionEndBlock: args.restrictionEndBlock,
    initialBuyAmount: args.initialBuyAmount,
    initialBuyTokens: args.initialBuyTokens,
    tx: l.tx,
    block: l.block,
    logIndex: l.logIndex,
  };
}

/** One launch: its TokenLaunched, with the name and symbol from the TokenDeployed of the same transaction. */
export type PerpmeLaunch = PerpmeLaunched & {
  name: string | null;
  symbol: string | null;
  metadataURI: string | null;
  /** A tokenized-stock test coin, which Kalos's Sniper hides (see isXStock). */
  xstock: boolean;
};

/**
 * A tokenized-stock coin ("Apple xStock", "3M xStock"…), by Kalos's own rule (kalos-perpme-feed.js,
 * perpmeHidden: `/\bxstock\s*$/i` on the launch's name): "they arrive in bursts of hundreds and buried
 * every other launch". 1,318 of PerpMe's first 1,530 launches, every one paired with USDC.
 */
export const isXStock = (name: string | null | undefined): boolean => /\bxstock\s*$/i.test(String(name ?? ""));

/**
 * Every launch in a factory's logs (TokenDeployed and TokenLaunched mixed, any order), oldest first. A
 * TokenLaunched with no TokenDeployed for its token keeps a null name; `orphans` counts the other way
 * round (a coin deployed but never launched has no pool and is no coin).
 */
export function launchesOf(logs: readonly RawLog[]): { launches: PerpmeLaunch[]; orphans: number } {
  const deployed = new Map<string, PerpmeDeployed>();
  const launched: PerpmeLaunched[] = [];
  for (const l of logs) {
    if (l.topics[0] === PERPME_TOPIC.deployed) {
      const d = decodeDeployed(l);
      deployed.set(lc(d.token), d);
    } else if (l.topics[0] === PERPME_TOPIC.launched) launched.push(decodeLaunched(l));
  }
  // One launch per token, the first if a log was ever read twice.
  const seen = new Set<string>();
  const launches: PerpmeLaunch[] = [];
  for (const x of launched.sort((a, b) => (a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1))) {
    if (seen.has(lc(x.token))) continue;
    seen.add(lc(x.token));
    const d = deployed.get(lc(x.token));
    launches.push({ ...x, name: d?.name ?? null, symbol: d?.symbol ?? null, metadataURI: d?.metadataURI ?? null, xstock: isXStock(d?.name) });
  }
  return { launches, orphans: [...deployed.keys()].filter((t) => !seen.has(t)).length };
}

/** Uniswap V3 orders a pool's two tokens by address: the coin is token0 when its address is the smaller. */
export const coinIsToken0 = (token: string, pairToken: string) => BigInt(token) < BigInt(pairToken);

/** Where a moment stands in a coin's launch protection, counted in parent-chain blocks. */
export type Restriction = {
  endBlock: bigint;
  /** The parent chain's block at that moment (an Elysium header's l1BlockNumber), when known. */
  parentBlock: bigint | null;
  /** True while buys are capped; null when the parent block is unknown. */
  active: boolean | null;
  /** Parent blocks until it ends (0 once over); null when unknown. */
  blocksLeft: bigint | null;
};

/**
 * Launch protection at a parent block: on while the parent block is below `restrictionEndBlock` (the
 * coin's own restrictionsActive() answered true at end − 1 and false at end; pinned by a test).
 */
export function restrictionAt(endBlock: bigint, parentBlock: bigint | null): Restriction {
  if (parentBlock === null) return { endBlock, parentBlock, active: null, blocksLeft: null };
  const active = parentBlock < endBlock;
  return { endBlock, parentBlock, active, blocksLeft: active ? endBlock - parentBlock : 0n };
}

const chain = (a: { block: bigint; logIndex: number }, b: { block: bigint; logIndex: number }) => (a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1);
const need = <V>(m: ReadonlyMap<string, V>, k: string, what: string): V => {
  const v = m.get(k);
  if (v === undefined) throw new Error(`missing ${what} for ${k}`);
  return v;
};

/**
 * The creator's buy as the chain shows it: what the coin's pool paid out in the launch transaction's
 * swaps, by the V3 sign rule (a negative coin amount is what the pool paid), and the coin's own Transfer
 * out of the pool in that transaction. Both should equal TokenLaunched's initialBuyTokens.
 */
export function creatorBuyOf(launch: PerpmeLaunched, swaps: readonly KSwap[], transfers: readonly CoinTransfer[]): { swap: bigint; transfer: bigint } {
  const is0 = coinIsToken0(launch.token, launch.pairToken);
  const inTx = swaps.filter((s) => lc(s.tx) === lc(launch.tx) && lc(s.pool) === lc(launch.pool));
  const swap = inTx.reduce((sum, s) => {
    const d = is0 ? s.amount0 : s.amount1;
    return d < 0n ? sum - d : sum;
  }, 0n);
  const transfer = transfers
    .filter((t) => lc(t.tx) === lc(launch.tx) && lc(t.token) === lc(launch.token) && lc(t.from) === lc(launch.pool))
    .reduce((sum, t) => sum + t.value, 0n);
  return { swap, transfer };
}

/** A coin to read, with what collect learned about it from the token. */
export type PerpmeCoin = {
  launch: PerpmeLaunch;
  /** totalSupply() at the head. */
  supply: bigint;
  /** decimals(); null when it couldn't be read. */
  decimals: number | null;
};

export type PerpmeInput = {
  coins: readonly PerpmeCoin[];
  swaps: readonly KSwap[];
  transfers: readonly CoinTransfer[];
  txFrom: ReadonlyMap<string, Address>;
  blockTime: ReadonlyMap<string, number>;
  system: ReadonlySet<string>;
  contracts?: ReadonlySet<string>;
};

/**
 * One skeleton per PerpMe coin (`market: "perpme"`): its launch is the TokenLaunched transaction, its
 * creator the deployer that event names, its pool the one that event names, and its trades the V3 Swaps
 * in that pool (the creator's own buy is the first, inside the launch transaction). Holders come from
 * its whole transfer history.
 */
export function assemblePerpme(input: PerpmeInput): Skeleton[] {
  const transfersByToken = Map.groupBy(input.transfers, (t) => lc(t.token));
  const swapsByPool = Map.groupBy(input.swaps, (s) => lc(s.pool));
  return input.coins.map(({ launch: l, supply, decimals }): Skeleton => {
    const tokenIs0 = coinIsToken0(l.token, l.pairToken);
    const transfers: TokenTransfer[] = (transfersByToken.get(lc(l.token)) ?? []).sort(chain).map(({ token: _token, ...t }) => t);
    const byTx = Map.groupBy(transfers, (t) => lc(t.tx));
    const trades = (swapsByPool.get(lc(l.pool)) ?? []).sort(chain).map((s): Trade => {
      const tokenDelta = tokenIs0 ? s.amount0 : s.amount1;
      const quoteDelta = tokenIs0 ? s.amount1 : s.amount0;
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
        outside: false,
      };
    });
    const coin: Coin = {
      token: l.token,
      poolId: lc(l.pool) as Hex,
      tokenIs0,
      creator: l.deployer,
      launcher: need(input.txFrom, lc(l.tx), "launch sender"),
      launchTx: l.tx,
      launchBlock: l.block,
      launchTime: need(input.blockTime, l.block.toString(), "block time"),
      devBuyTokens: l.initialBuyTokens,
      name: l.name,
      symbol: l.symbol,
      market: "perpme",
      supply,
      ...(decimals !== null && decimals !== PERPME_RULES.decimals ? { decimals } : {}),
    };
    return { coin, trades, transfers, system: input.system, ...(input.contracts ? { contracts: input.contracts } : {}) };
  });
}

/** Coins whose history holds more transfers than PERPME_RULES.busyTransfers (token, lowercase → count). */
export function busyCoins(transfers: readonly CoinTransfer[], limit: number = PERPME_RULES.busyTransfers): Map<string, number> {
  const n = new Map<string, number>();
  for (const t of transfers) n.set(lc(t.token), (n.get(lc(t.token)) ?? 0) + 1);
  return new Map([...n].filter(([, c]) => c > limit));
}

/** One coin's pool: whether its liquidity is locked, what it holds, and its value in HYPE. */
export type PerpmeLiquidity = {
  token: Address;
  pool: Address;
  pairToken: Address;
  /** 10,000 = 1%, from dexId. Null for a dexId PerpMe's docs don't name. */
  fee: number | null;
  tokenIs0: boolean;
  /** The launch's LP position (an NFT of PerpMe's position manager). */
  positionId: bigint;
  /** Who holds that NFT now (read from the position manager at the head; null if it couldn't be read). */
  positionOwner: Address | null;
  /** The launch position sits in PerpMe's locker, which has no withdrawal function: it can never be pulled. */
  locked: boolean;
  /** Share of the pool's open positions held by the locker, by value at the current price (null: no price yet). */
  lockedPct: number | null;
  /** Open positions outside the locker: anyone can add liquidity to a V3 pool and take it back out. */
  unlocked: Array<{ owner: Address; position: string; liquidity: bigint; sharePct: number | null }>;
  /** balanceOf the pool at the head, of the coin and of the pair token (fees not yet collected included). */
  tokenReserve: bigint | null;
  quoteReserve: bigint | null;
  sqrtPriceX96: bigint | null;
  /** Pair is PerpMe's WHYPE: the HYPE in the pool (what every seller together could take out), in wei. */
  hypeInPool: bigint | null;
  /** Pair is PerpMe's WHYPE: the pool's whole value in HYPE wei (the HYPE plus the coins at the pool's price). */
  tvlHype: bigint | null;
  /** Pair is PerpMe's WHYPE: what one whole coin costs at the pool's price, in HYPE wei. */
  priceHypeWei: bigint | null;
  restriction: Restriction;
  notes: string[];
};

const Q192 = 1n << 192n;
const pctOf = (a: bigint, b: bigint) => (b === 0n ? 0 : Number((a * 10_000n) / b) / 100);

/**
 * A coin's liquidity summary, from the positions replayed from its pool's Mints and Burns and the
 * position manager's events (kalos.ts positionsOf), the reserves and price at the head, and who holds
 * the launch position's NFT.
 */
export function perpmeLiquidity(input: {
  launch: PerpmeLaunched;
  positions: ReadonlyMap<string, Position>;
  tokenReserve: bigint | null;
  quoteReserve: bigint | null;
  sqrtPriceX96: bigint | null;
  /** ownerOf(positionId) read at the head; undefined: use the replayed owner. */
  positionOwner?: Address | null;
  parentBlock: bigint | null;
  locker?: Address;
  whype?: Address;
  decimals?: number;
}): PerpmeLiquidity {
  const l = input.launch;
  const locker = lc(input.locker ?? PERPME.locker);
  const whype = lc(input.whype ?? PERPME.whype);
  const tokenIs0 = coinIsToken0(l.token, l.pairToken);
  const sqrtP = input.sqrtPriceX96 && input.sqrtPriceX96 > 0n ? input.sqrtPriceX96 : null;
  const notes: string[] = [];
  const open = [...input.positions.values()].filter((p) => lc(p.pool) === lc(l.pool) && p.liquidity > 0n);
  const valued = open.map((p) => {
    if (!sqrtP) return { p, value: null as bigint | null };
    const [a0, a1] = amountsOf(p.liquidity, p.tickLower, p.tickUpper, sqrtP);
    const [tokens, quote] = tokenIs0 ? [a0, a1] : [a1, a0];
    const tokenInQuote = tokenIs0 ? (tokens * sqrtP * sqrtP) / Q192 : (tokens * Q192) / (sqrtP * sqrtP);
    return { p, value: quote + tokenInQuote };
  });
  const total = valued.reduce((s, v) => s + (v.value ?? 0n), 0n);
  const share = (v: bigint | null) => (v === null || !sqrtP ? null : pctOf(v, total));
  const inLocker = valued.filter((v) => lc(v.p.owner) === locker);
  const replayed = input.positions.get(`nft:${l.positionId}`)?.owner ?? null;
  const positionOwner = input.positionOwner === undefined ? replayed : input.positionOwner;
  if (input.positionOwner !== undefined && input.positionOwner && replayed && lc(input.positionOwner) !== lc(replayed)) {
    notes.push(`The launch position's NFT is held by ${input.positionOwner} on chain, but the replayed events say ${replayed}.`);
  }
  const locked = !!positionOwner && lc(positionOwner) === locker;
  if (!locked) notes.push(positionOwner ? `The launch position (NFT ${l.positionId}) is held by ${positionOwner}, not PerpMe's locker: it can be withdrawn.` : `Who holds the launch position (NFT ${l.positionId}) couldn't be read.`);
  if (!input.positions.has(`nft:${l.positionId}`)) notes.push(`The launch position (NFT ${l.positionId}) was not found in the pool's liquidity events.`);
  const unlocked = valued
    .filter((v) => lc(v.p.owner) !== locker && !BURN.has(lc(v.p.owner)))
    .sort((a, b) => ((b.value ?? b.p.liquidity) > (a.value ?? a.p.liquidity) ? 1 : -1))
    .map((v) => ({ owner: v.p.owner, position: v.p.id, liquidity: v.p.liquidity, sharePct: share(v.value) }));
  const isHype = lc(l.pairToken) === whype;
  const unit = 10n ** BigInt(input.decimals ?? PERPME_RULES.decimals);
  const priceHypeWei = isHype && sqrtP ? (tokenIs0 ? (unit * sqrtP * sqrtP) / Q192 : (unit * Q192) / (sqrtP * sqrtP)) : null;
  const tvlHype =
    isHype && sqrtP && input.tokenReserve !== null && input.quoteReserve !== null
      ? input.quoteReserve + (tokenIs0 ? (input.tokenReserve * sqrtP * sqrtP) / Q192 : (input.tokenReserve * Q192) / (sqrtP * sqrtP))
      : null;
  return {
    token: l.token,
    pool: l.pool,
    pairToken: l.pairToken,
    fee: PERPME_RULES.feeOfDex[Number(l.dexId)] ?? null,
    tokenIs0,
    positionId: l.positionId,
    positionOwner,
    locked,
    lockedPct: sqrtP && total > 0n ? pctOf(inLocker.reduce((s, v) => s + (v.value ?? 0n), 0n), total) : null,
    unlocked,
    tokenReserve: input.tokenReserve,
    quoteReserve: input.quoteReserve,
    sqrtPriceX96: sqrtP,
    hypeInPool: isHype ? input.quoteReserve : null,
    tvlHype,
    priceHypeWei,
    restriction: restrictionAt(l.restrictionEndBlock, input.parentBlock),
    notes,
  };
}
