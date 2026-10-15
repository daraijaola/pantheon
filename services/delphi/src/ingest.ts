// Turns raw chain and explorer data into one CoinData per Ascend coin. `assemble` is pure (tested
// with fixtures); `collect` does the fetching, with everything cached so reruns are cheap.
import { decodeEventLog, getAddress, type Address, type Hex, type PublicClient } from "viem";
import {
  addressKinds,
  blockTimes,
  INITIALIZE,
  LAUNCHED,
  launchpadAddresses,
  mapLimit,
  scanLogs,
  SWAP,
  tokenMeta,
  TRANSFER,
  txSenders,
} from "./chain.ts";
import { KNOWN_HUBS, STATIC_SYSTEM, type Config } from "./config.ts";
import { ExplorerBudgetError, type Explorer, type RawFunding } from "./explorer.ts";
import { actorsOf, buildLinks, findHubs } from "./graph.ts";
import type { RawLog, Store } from "./store.ts";
import type { Coin, CoinData, Funding, TokenTransfer, Trade } from "./types.ts";

const lc = (a: string) => a.toLowerCase();

export type Launch = { poolId: Hex; token: Address; creator: Address; quote: Address; devBuyTokens: bigint; tx: Hex; block: bigint };
export type Swap = { poolId: Hex; sender: Address; amount0: bigint; amount1: bigint; tx: Hex; block: bigint; logIndex: number };
export type CoinTransfer = TokenTransfer & { token: Address };
export type Pool = { poolId: Hex; currency0: Address; currency1: Address; hooks: Address };

export function decodeLaunch(l: RawLog): Launch {
  const { args } = decodeEventLog({ abi: [LAUNCHED], topics: l.topics as [Hex, ...Hex[]], data: l.data });
  return { poolId: args.poolId, token: args.token, creator: args.creator, quote: args.quote, devBuyTokens: args.devBuyTokens, tx: l.tx, block: l.block };
}
export function decodeSwap(l: RawLog): Swap {
  const { args } = decodeEventLog({ abi: [SWAP], topics: l.topics as [Hex, ...Hex[]], data: l.data });
  return { poolId: args.id, sender: args.sender, amount0: args.amount0, amount1: args.amount1, tx: l.tx, block: l.block, logIndex: l.logIndex };
}
export function decodePool(l: RawLog): Pool {
  const { args } = decodeEventLog({ abi: [INITIALIZE], topics: l.topics as [Hex, ...Hex[]], data: l.data });
  return { poolId: args.id, currency0: args.currency0, currency1: args.currency1, hooks: args.hooks };
}
export function decodeTransfer(l: RawLog): CoinTransfer {
  const { args } = decodeEventLog({ abi: [TRANSFER], topics: l.topics as [Hex, ...Hex[]], data: l.data });
  return { token: getAddress(l.address), tx: l.tx, block: l.block, logIndex: l.logIndex, from: args.from, to: args.to, value: args.value };
}

/**
 * The wallet whose balance a trade changed: for a buy, the non-system address that ended up with
 * the most tokens in that transaction; for a sell, the one that gave up the most. Falls back to the
 * sender (e.g. an arbitrage bot whose tokens only pass through contracts).
 */
function holderOf(side: "buy" | "sell", txTransfers: TokenTransfer[], system: ReadonlySet<string>, fallback: Address): Address {
  const net = new Map<string, { a: Address; v: bigint }>();
  for (const t of txTransfers) {
    for (const [a, v] of [[t.from, -t.value], [t.to, t.value]] as const) {
      if (system.has(lc(a))) continue;
      const cur = net.get(lc(a)) ?? { a, v: 0n };
      net.set(lc(a), { a, v: cur.v + v });
    }
  }
  let best: { a: Address; v: bigint } | null = null;
  for (const n of net.values()) {
    const v = side === "buy" ? n.v : -n.v;
    if (v > 0n && (!best || v > best.v)) best = { a: n.a, v };
  }
  return best?.a ?? fallback;
}

export type Skeleton = Omit<CoinData, "links" | "fundingMissing">;

/**
 * One coin per launch, with its token's transfers and its trades: in its Ascend pool, and in any
 * other pool on the same pool manager that holds the coin (anyone can open one, and Ascend's own
 * router routes through them).
 */
export function assemble(input: {
  launches: Launch[];
  pools: Pool[];
  swaps: Swap[];
  transfers: CoinTransfer[];
  txFrom: ReadonlyMap<string, Address>;
  blockTime: ReadonlyMap<string, number>;
  system: ReadonlySet<string>;
  meta: ReadonlyMap<string, { name: string | null; symbol: string | null }>;
}): Skeleton[] {
  const need = <V>(m: ReadonlyMap<string, V>, k: string, what: string): V => {
    const v = m.get(k);
    if (v === undefined) throw new Error(`missing ${what} for ${k}`);
    return v;
  };
  const swapsByPool = Map.groupBy(input.swaps, (s) => lc(s.poolId));
  const poolsByCoin = new Map<string, Pool[]>();
  for (const p of input.pools) {
    for (const c of [p.currency0, p.currency1]) {
      if (!poolsByCoin.has(lc(c))) poolsByCoin.set(lc(c), []);
      poolsByCoin.get(lc(c))!.push(p);
    }
  }
  const transfersByToken = Map.groupBy(input.transfers, (t) => lc(t.token));

  return input.launches.map((l) => {
    const tokenIs0 = BigInt(l.token) < BigInt(l.quote);
    const meta = input.meta.get(lc(l.token));
    const coin: Coin = {
      token: l.token,
      poolId: l.poolId,
      tokenIs0,
      creator: l.creator,
      launcher: need(input.txFrom, lc(l.tx), "launch sender"),
      launchTx: l.tx,
      launchBlock: l.block,
      launchTime: need(input.blockTime, l.block.toString(), "block time"),
      devBuyTokens: l.devBuyTokens,
      name: meta?.name ?? null,
      symbol: meta?.symbol ?? null,
    };
    const transfers: TokenTransfer[] = (transfersByToken.get(lc(l.token)) ?? []).map(({ token: _token, ...t }) => t);
    const byTx = Map.groupBy(transfers, (t) => lc(t.tx));
    // The Ascend pool is always included, even if its Initialize event was not seen.
    const own = new Set([lc(l.poolId), ...(poolsByCoin.get(lc(l.token)) ?? []).map((p) => lc(p.poolId))]);
    const isToken0 = new Map((poolsByCoin.get(lc(l.token)) ?? []).map((p) => [lc(p.poolId), lc(p.currency0) === lc(l.token)]));
    isToken0.set(lc(l.poolId), tokenIs0);
    const trades: Trade[] = [...own].flatMap((pid) => swapsByPool.get(pid) ?? []).sort((a, b) => Number(a.block - b.block) || a.logIndex - b.logIndex).map((s) => {
      const is0 = isToken0.get(lc(s.poolId))!;
      const tokenDelta = is0 ? s.amount0 : s.amount1;
      const quoteDelta = is0 ? s.amount1 : s.amount0;
      const side = tokenDelta > 0n ? "buy" : "sell";
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
        pool: s.poolId,
        outside: lc(s.poolId) !== lc(l.poolId),
      };
    });
    return { coin, trades, transfers, system: input.system };
  });
}

type StoredFunding = { from: Address; via: RawFunding["via"]; value: string; tx: Hex; time: number };
const FUNDING_MAX_AGE = 12 * 3_600;
const TXCOUNT_MAX_AGE = 7 * 86_400;

export type Collected = { coins: CoinData[]; head: bigint; notes: string[] };

/**
 * Everything, end to end. With `explorer: null` it uses only what the cache already holds
 * (e.g. when the explorer allowance is used up), and says so in the notes.
 */
export async function collect(deps: {
  client: PublicClient;
  store: Store;
  cfg: Config;
  explorer: Explorer | null;
  log?: (msg: string) => void;
}): Promise<Collected> {
  const { client, store, cfg, explorer } = deps;
  const log = deps.log ?? (() => {});
  const notes: string[] = [];

  const lp = await launchpadAddresses(client, cfg.launchpad);
  const head = await client.getBlockNumber();
  const pm = lc(lp.poolManager);
  const streams = { launched: `launched:${lc(cfg.launchpad)}`, pools: `pools:${pm}`, swap: `swap:${pm}`, transfer: `transfer:${lc(cfg.launchpad)}` };

  // Launches first, then swaps and transfers up to the same block, so no new coin's transfers are skipped.
  await scanLogs(client, store, streams.launched, { address: cfg.launchpad, event: LAUNCHED, from: cfg.fromBlock, to: head });
  const launches = store.logs(streams.launched).map(decodeLaunch);
  log(`${launches.length} launches up to block ${head}`);
  await scanLogs(client, store, streams.pools, { address: lp.poolManager, event: INITIALIZE, from: cfg.fromBlock, to: head });
  await scanLogs(client, store, streams.swap, { address: lp.poolManager, event: SWAP, from: cfg.fromBlock, to: head });
  if (launches.length) {
    const tokens = launches.map((l) => l.token);
    await scanLogs(client, store, streams.transfer, { address: tokens, event: TRANSFER, from: cfg.fromBlock, to: head }, (at, n) =>
      log(`  transfers: block ${at}, ${n} new`),
    );
  }

  // Only pools that hold an Ascend coin: other projects' pools share the same pool manager.
  const coinSet = new Set(launches.map((l) => lc(l.token)));
  const pools = store.logs(streams.pools).map(decodePool).filter((p) => coinSet.has(lc(p.currency0)) || coinSet.has(lc(p.currency1)));
  const poolIds = new Set([...launches.map((l) => lc(l.poolId)), ...pools.map((p) => lc(p.poolId))]);
  const swaps = store.logs(streams.swap).map(decodeSwap).filter((s) => poolIds.has(lc(s.poolId)));
  const transfers = store.logs(streams.transfer).map(decodeTransfer);
  const outsidePools = pools.filter((p) => lc(p.hooks) !== lc(cfg.launchpad)).length;
  log(`${swaps.length} swaps in ${poolIds.size} pools (${outsidePools} outside Ascend), ${transfers.length} token transfers`);

  const txFrom = await txSenders(client, store, [...launches, ...swaps].map((x) => lc(x.tx) as Hex));
  const blockTime = await blockTimes(client, store, [...launches, ...swaps].map((x) => x.block.toString()));
  const meta = await tokenMeta(client, store, launches.map((l) => l.token));

  // Infrastructure: fixed addresses, the launchpad's own, every router seen swapping, outside pools.
  const system = new Set([...STATIC_SYSTEM, cfg.launchpad, ...Object.values(lp), ...swaps.map((s) => s.sender)].map(lc));
  const parties = new Set([...transfers.flatMap((t) => [t.from, t.to]), ...txFrom.values()].map(lc).filter((a) => !system.has(a)));
  const kinds = await addressKinds(client, store, parties);
  // Pools and other contracts (staking, lockers, faucets) are not wallets. Tokens deposited into the
  // same staking contract don't make the depositors one actor, and what a contract holds is nobody's
  // wallet balance. Reports still say how much the non-pool contracts hold.
  const contracts = new Set<string>();
  for (const [a, k] of kinds) {
    if (k === "wallet") continue;
    system.add(a);
    if (k === "contract") contracts.add(a);
  }
  log(`${parties.size} addresses checked: ${[...kinds.values()].filter((k) => k === "pool").length} outside pools, ${contracts.size} other contracts`);

  const skeletons = assemble({ launches, pools, swaps, transfers, txFrom, blockTime, system, meta });
  const coinActors = skeletons.map((s) => actorsOf(s.trades, s.transfers, system));
  const wallets = [...new Set(coinActors.flatMap((a) => [...a].map(lc)))].filter((a) => kinds.get(a) === "wallet");

  // Funding history per wallet, from the explorer (cached for 12 h).
  const fundings = new Map<string, StoredFunding[]>();
  let stopped: string | null = null;
  await mapLimit(wallets, 4, async (w) => {
    const cached = store.recall<StoredFunding[]>("funding", w, explorer ? FUNDING_MAX_AGE : Infinity);
    if (cached) return void fundings.set(w, cached);
    if (!explorer || stopped) return;
    try {
      const got = (await explorer.fundings(getAddress(w))).map((f) => ({ from: f.from, via: f.via, value: f.value.toString(), tx: f.tx, time: f.time }));
      store.remember("funding", w, got);
      fundings.set(w, got);
    } catch (err) {
      if (!(err instanceof ExplorerBudgetError)) throw err;
      stopped = err.message;
    }
  });
  if (stopped) notes.push(stopped);
  log(`funding history for ${fundings.size}/${wallets.length} wallets${explorer?.remaining != null ? ` (explorer allowance left: ${explorer.remaining})` : ""}`);

  // A payment made inside a contract call is credited to whoever sent that transaction.
  const internalTxs = [...fundings.values()].flat().filter((f) => f.via === "internal").map((f) => lc(f.tx) as Hex);
  const parentFrom = await txSenders(client, store, internalTxs);
  const flat: Funding[] = [...fundings].flatMap(([w, fs]) =>
    fs.map((f) => ({
      wallet: getAddress(w),
      funder: f.via === "internal" ? parentFrom.get(lc(f.tx) as Hex)! : f.from,
      value: BigInt(f.value),
      tx: f.tx,
      time: f.time,
    })),
  );

  // How busy each funder is: public hubs (faucets, bridges) never link anyone.
  const known = new Set(KNOWN_HUBS.map(lc));
  const funders = [...new Set(flat.map((f) => lc(f.funder)))].filter((f) => !system.has(f) && !known.has(f));
  const txCounts = new Map<string, number>();
  const unknownFunders = new Set<string>();
  await mapLimit(funders, 4, async (f) => {
    const cached = store.recall<number>("txcount", f, explorer ? TXCOUNT_MAX_AGE : Infinity);
    if (cached !== undefined) return void txCounts.set(f, cached);
    if (!explorer || stopped) return void unknownFunders.add(f);
    try {
      const n = await explorer.txCount(getAddress(f));
      store.remember("txcount", f, n);
      txCounts.set(f, n);
    } catch (err) {
      if (!(err instanceof ExplorerBudgetError)) throw err;
      stopped = err.message;
      unknownFunders.add(f);
    }
  });
  if (stopped && !notes.includes(stopped)) notes.push(stopped);
  const hubs = findHubs(txCounts);
  // A funder we could not size might be a public hub: leave it out rather than risk a false link.
  const usable = flat.filter((f) => !unknownFunders.has(lc(f.funder)));
  const blind = new Set(flat.filter((f) => unknownFunders.has(lc(f.funder))).map((f) => lc(f.wallet)));

  const coins = skeletons.map((s, i): CoinData => {
    const actors = coinActors[i]!;
    const links = buildLinks({
      actors,
      creator: s.coin.creator,
      launcher: s.coin.launcher,
      launchTx: s.coin.launchTx,
      trades: s.trades,
      transfers: s.transfers,
      fundings: usable,
      hubs,
      system,
    });
    const fundingMissing = [...actors].filter((a) => kinds.get(lc(a)) === "wallet" && (!fundings.has(lc(a)) || blind.has(lc(a)))).length;
    return { ...s, links, fundingMissing, contracts };
  });
  if (!explorer) notes.push("explorer skipped: funding links use cached data only");
  return { coins, head, notes };
}
