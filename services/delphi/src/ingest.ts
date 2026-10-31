// Turns raw chain and explorer data into one CoinData per Ascend coin. `assemble` is pure (tested
// with fixtures); `collect` does the fetching, with everything cached so reruns are cheap.
import { decodeEventLog, getAddress, parseAbi, type Address, type Hex, type PublicClient } from "viem";
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
  txCalls,
  txSenders,
} from "./chain.ts";
import { KNOWN_HUBS, RULES, STATIC_SYSTEM, supplyOf, type Config } from "./config.ts";
import { ExplorerBudgetError, type RawFunding } from "./explorer.ts";
import type { FundingSource } from "./funding.ts";
import { collectKalos, type KalosCollected } from "./kalos-collect.ts";
import type { LiquidityReport } from "./kalos.ts";
import type { BatchRpc } from "./rpc.ts";
import { balances } from "./detect.ts";
import { actorsOf, buildLinks, findHubs, fundingKind, payeesOf, sinksOf } from "./graph.ts";
import { KALOS } from "./kalos.ts";
import type { RawLog, Store } from "./store.ts";
import type { Coin, CoinData, Funding, TokenTransfer, Trade, WalletRole } from "./types.ts";

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
export function holderOf(side: "buy" | "sell", txTransfers: TokenTransfer[], system: ReadonlySet<string>, fallback: Address): Address {
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
/**
 * Funding already read is kept for good: a first funding never changes, and what the explorer
 * returned before its checkpoint is still true. Only "never funded" is asked again, after 12 h.
 */
const EMPTY_FUNDING_MAX_AGE = 12 * 3_600;
const TXCOUNT_MAX_AGE = 7 * 86_400;
const toStored = (f: RawFunding): StoredFunding => ({ from: f.from, via: f.via, value: f.value.toString(), tx: f.tx, time: f.time });

/** `hubs`: the funders treated as public this run (they link no one). `liquidity`: Kalos coins' pools. */
export type Collected = { coins: CoinData[]; head: bigint; notes: string[]; hubs: ReadonlySet<string>; liquidity: ReadonlyMap<string, LiquidityReport>; kalos: KalosCollected | null };

/**
 * Kalos coins can have tens of thousands of traders (KALOS: 28,000 in its windows). Funding is read for
 * the wallets the checks turn on: everyone who bought in the launch window, the biggest holders and the
 * biggest traders. Everyone else counts as their own person.
 */
export const KALOS_FUNDING = { holders: 300, traders: 300 } as const;

/** The wallets of one Kalos coin whose funding matters to its checks (see KALOS_FUNDING). */
export function kalosFundingTargets(s: Skeleton, system: ReadonlySet<string>, windowSec: number): Set<string> {
  const wallet = (a: string) => !system.has(lc(a));
  const out = new Set<string>();
  const end = s.coin.launchTime + windowSec;
  for (const t of s.trades) if (t.side === "buy" && t.time <= end && wallet(t.holder)) out.add(lc(t.holder));
  const bal = new Map<string, bigint>(s.holdings ? [...s.holdings].map(([a, v]) => [lc(a), v]) : []);
  if (!s.holdings) {
    for (const t of s.transfers) {
      bal.set(lc(t.from), (bal.get(lc(t.from)) ?? 0n) - t.value);
      bal.set(lc(t.to), (bal.get(lc(t.to)) ?? 0n) + t.value);
    }
  }
  const top = <K>(m: Map<string, K>, n: number, v: (k: K) => bigint) =>
    [...m].filter(([a]) => wallet(a)).sort((a, b) => (v(b[1]) > v(a[1]) ? 1 : v(b[1]) < v(a[1]) ? -1 : 0)).slice(0, n).map(([a]) => a);
  for (const a of top(bal, KALOS_FUNDING.holders, (x) => x)) out.add(a);
  const volume = new Map<string, bigint>();
  for (const t of s.trades) volume.set(lc(t.holder), (volume.get(lc(t.holder)) ?? 0n) + t.tokens);
  for (const a of top(volume, KALOS_FUNDING.traders, (x) => x)) out.add(a);
  if (wallet(s.coin.creator)) out.add(lc(s.coin.creator));
  return out;
}

/**
 * Everything, end to end. `explorer` is where funding comes from: ChainFunding (the chain itself)
 * or the old explorer client. With `explorer: null` it uses only what the cache already holds, and
 * says so in the notes.
 */
export async function collect(deps: {
  client: PublicClient;
  store: Store;
  cfg: Config;
  explorer: FundingSource | null;
  /**
   * Also read every coin on Kalos (Elysium's Uniswap-V3-style DEX): over this batched node, or reuse
   * an earlier read (the X bot re-reads Kalos less often than Ascend). Unset: Ascend coins only.
   */
  kalos?: { rpc: BatchRpc; recentBlocks?: bigint } | { reuse: KalosCollected } | null;
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

  const ascend = assemble({ launches, pools, swaps, transfers, txFrom, blockTime, system, meta });

  // Kalos: its coins join the same infrastructure set, linking and hub rules as Ascend's.
  let kalos: KalosCollected | null = null;
  if (deps.kalos && "reuse" in deps.kalos) kalos = deps.kalos.reuse;
  else if (deps.kalos) {
    kalos = await collectKalos({ client, rpc: deps.kalos.rpc, store, log: (m) => log(`kalos: ${m}`), launchpad: cfg.launchpad, launchFrom: cfg.fromBlock, ...(deps.kalos.recentBlocks !== undefined ? { recentBlocks: deps.kalos.recentBlocks } : {}) });
  }
  const kalosWallets = new Set<string>();
  if (kalos) {
    for (const a of kalos.system) system.add(lc(a));
    for (const a of kalos.contracts) {
      system.add(lc(a));
      contracts.add(lc(a));
    }
    // Notes about one coin stay with that coin's report (scan.ts adds them); the rest are the run's.
    const perCoin = new Set([...kalos.liquidity.values()].flatMap((r) => r.notes.map((n) => `${r.symbol}: ${n}`)));
    notes.push(...kalos.notes.filter((n) => !perCoin.has(n)));
    // Ascend coins also traded in Kalos pools: those trades are theirs, outside Ascend.
    for (const s of ascend) {
      const extra = kalos.ascendExtras.get(lc(s.coin.token));
      if (extra?.length) s.trades = [...s.trades, ...extra].sort((a, b) => Number(a.block - b.block) || a.logIndex - b.logIndex);
    }
  }
  const kalosCoins: Skeleton[] = (kalos?.skeletons ?? []).map((s) => {
    const decimals = kalos!.liquidity.get(lc(s.coin.token))?.decimals;
    return { ...s, coin: { ...s.coin, ...(decimals != null && decimals !== 18 ? { decimals } : {}) }, system };
  });
  const skeletons = [...ascend, ...kalosCoins];
  const coinActors = skeletons.map((s) => actorsOf(s.trades, s.transfers, system));
  const targets = skeletons.map((s, i) => (s.coin.market === "kalos" ? kalosFundingTargets(s, system, RULES.bundle.windowSec) : new Set([...coinActors[i]!].map(lc))));
  for (const [i, s] of skeletons.entries()) if (s.coin.market === "kalos") for (const w of targets[i]!) kalosWallets.add(w);
  const isWallet = (a: string) => kinds.get(a) === "wallet" || (kinds.get(a) === undefined && kalosWallets.has(a) && !system.has(a));
  const wallets = [...new Set(targets.flatMap((t) => [...t]))].filter(isWallet);

  // Funding per wallet: kept from earlier runs, looked up only for wallets not read yet.
  const fundings = new Map<string, StoredFunding[]>();
  let stopped: string | null = null;
  const todo: string[] = [];
  for (const w of wallets) {
    const cached = store.recall<StoredFunding[]>("funding", w);
    const stale = cached !== undefined && cached.length === 0 && store.recall("funding", w, EMPTY_FUNDING_MAX_AGE) === undefined;
    if (cached && !(stale && explorer)) fundings.set(w, cached);
    else todo.push(w);
  }
  if (explorer && todo.length) {
    log(`looking up funding for ${todo.length} wallets…`);
    if (explorer.fundingsMany) {
      try {
        for (const [w, got] of await explorer.fundingsMany(todo.map((w) => getAddress(w)))) {
          store.remember("funding", w, got.map(toStored));
          fundings.set(w, got.map(toStored));
        }
      } catch (err) {
        stopped = `funding lookup stopped: ${(err as Error).message}`;
      }
    } else {
      await mapLimit(todo, 4, async (w) => {
        if (stopped) return;
        try {
          const got = (await explorer.fundings(getAddress(w))).map(toStored);
          store.remember("funding", w, got);
          fundings.set(w, got);
        } catch (err) {
          if (!(err instanceof ExplorerBudgetError)) throw err;
          stopped = err.message;
        }
      });
    }
  }
  // A wallet asked again but not answered keeps what it had before.
  for (const w of todo) {
    const old = fundings.has(w) ? undefined : store.recall<StoredFunding[]>("funding", w);
    if (old) fundings.set(w, old);
  }
  if (stopped) notes.push(stopped);
  log(`funding history for ${fundings.size}/${wallets.length} wallets${explorer?.remaining != null ? ` (explorer allowance left: ${explorer.remaining})` : ""}`);

  // A payment made inside a contract call is credited to whoever sent that transaction.
  const internalTxs = [...fundings.values()].flat().filter((f) => f.via === "internal").map((f) => lc(f.tx) as Hex);
  const parentFrom = await txSenders(client, store, internalTxs);
  // What those transactions called: only a multi-send makes a contract's payout the sender's own funding.
  const paidByOthers = [...fundings].flatMap(([w, fs]) =>
    fs.filter((f) => f.via === "internal" && lc(parentFrom.get(lc(f.tx) as Hex) ?? w) !== w).map((f) => lc(f.tx) as Hex),
  );
  const calls = await txCalls(client, store, paidByOthers);
  const flat: Funding[] = [...fundings].flatMap(([w, fs]) =>
    fs.map((f) => ({
      wallet: getAddress(w),
      funder: f.via === "internal" ? parentFrom.get(lc(f.tx) as Hex)! : f.from,
      value: BigInt(f.value),
      tx: f.tx,
      time: f.time,
      kind: fundingKind(f.via, f.from, calls.get(lc(f.tx) as Hex)),
    })),
  );

  // How busy each funder is: public hubs (faucets, bridges) never link anyone.
  const known = new Set(KNOWN_HUBS.map(lc));
  const funders = [...new Set(flat.map((f) => lc(f.funder)))].filter((f) => !system.has(f) && !known.has(f));
  const txCounts = new Map<string, number>();
  const unknownFunders = new Set<string>();
  const countTodo: string[] = [];
  for (const f of funders) {
    const cached = store.recall<number>("txcount", f, explorer ? TXCOUNT_MAX_AGE : Infinity);
    if (cached !== undefined) txCounts.set(f, cached);
    else countTodo.push(f);
  }
  if (explorer && countTodo.length && explorer.txCounts) {
    try {
      for (const [f, n] of await explorer.txCounts(countTodo.map((f) => getAddress(f)))) {
        store.remember("txcount", f, n);
        txCounts.set(f, n);
      }
    } catch (err) {
      stopped ??= `transaction counts stopped: ${(err as Error).message}`;
    }
  } else if (explorer && countTodo.length) {
    await mapLimit(countTodo, 4, async (f) => {
      if (stopped) return;
      try {
        const n = await explorer.txCount(getAddress(f));
        store.remember("txcount", f, n);
        txCounts.set(f, n);
      } catch (err) {
        if (!(err instanceof ExplorerBudgetError)) throw err;
        stopped = err.message;
      }
    });
  }
  // An old count is better than none: a busy funder stays busy.
  for (const f of countTodo) {
    if (txCounts.has(f)) continue;
    const old = store.recall<number>("txcount", f);
    if (old !== undefined) txCounts.set(f, old);
    else unknownFunders.add(f);
  }
  if (stopped && !notes.includes(stopped)) notes.push(stopped);
  // On testnet, a wallet whose payees trade many different coins is a distribution bot or a farm (v0.3).
  // Counted over every coin, so one coin's ring still stands out. Contract payouts are no one's seeding.
  const traded = new Map<string, Set<string>>();
  for (const s of skeletons) {
    for (const t of s.trades) {
      for (const w of [lc(t.trader), lc(t.holder)]) {
        if (!traded.has(w)) traded.set(w, new Set());
        traded.get(w)!.add(lc(s.coin.token));
      }
    }
  }
  const launched = new Map<string, Set<string>>();
  for (const s of skeletons) {
    for (const who of new Set([lc(s.coin.creator), lc(s.coin.launcher)])) {
      if (!launched.has(who)) launched.set(who, new Set());
      launched.get(who)!.add(lc(s.coin.token));
    }
  }
  const hubs = findHubs(txCounts, { network: cfg.network, payees: payeesOf(flat.filter((f) => f.kind !== "payout"), traded, launched) });
  // A funder we could not size might be a public hub: leave it out rather than risk a false link.
  const usable = flat.filter((f) => !unknownFunders.has(lc(f.funder)));
  const blind = new Set(flat.filter((f) => unknownFunders.has(lc(f.funder))).map((f) => lc(f.wallet)));

  const coins = skeletons.map((s, i): CoinData => {
    const actors = coinActors[i]!;
    const links = buildLinks({
      actors,
      creator: s.coin.creator,
      // On Kalos, whoever added the first liquidity is not tied to the deployer by that alone.
      launcher: s.coin.market === "kalos" ? s.coin.creator : s.coin.launcher,
      launchTx: s.coin.launchTx,
      trades: s.trades,
      transfers: s.transfers,
      fundings: usable,
      hubs,
      system,
    });
    const fundingMissing = [...targets[i]!].filter((a) => isWallet(a) && (!fundings.has(a) || blind.has(a))).length;
    return { ...s, links, fundingMissing, contracts, network: cfg.network };
  });
  // Who the big wallets are, so a report can say it (v0.5).
  const projects = new Map<string, string>();
  if (kalos) {
    const owner = await client.readContract({ address: KALOS.factory, abi: OWNER_ABI, functionName: "owner" }).catch(() => null);
    if (owner) projects.set(lc(owner), "owns Kalos's factory: it is Kalos's own wallet");
  }
  const withRoles = assignRoles(coins, projects, system);
  if (!explorer) notes.push("explorer skipped: funding links use cached data only");
  return { coins: withRoles, head, notes, hubs, liquidity: kalos?.liquidity ?? new Map(), kalos };
}

const OWNER_ABI = parseAbi(["function owner() view returns (address)"]);

/**
 * What DELPHI knows each coin's big wallets are (v0.5), with the evidence in plain words:
 * - "project": a project's own wallet, known from the chain (Kalos's factory owner);
 * - "sink": it receives this coin from trades sent by many different wallets (fees or buybacks);
 * - "whale": it holds 5% or more of the supply of 3 or more coins it didn't create (an outside trader).
 */
export function assignRoles(coins: CoinData[], projects: ReadonlyMap<string, string>, system: ReadonlySet<string>): CoinData[] {
  const big = new Map<string, number>();
  const bals = coins.map((d) => balances(d));
  coins.forEach((d, i) => {
    const supply = supplyOf(d.coin);
    for (const [w, v] of bals[i]!) if (w !== lc(d.coin.creator) && v * 20n >= supply) big.set(w, (big.get(w) ?? 0) + 1);
  });
  return coins.map((d, i) => {
    const roles = new Map<string, WalletRole>();
    const supply = supplyOf(d.coin);
    for (const [w, says] of projects) roles.set(w, { kind: "project", says });
    for (const [w, n] of sinksOf(d.trades, (a) => system.has(lc(a)))) {
      if (!roles.has(w)) roles.set(w, { kind: "sink", says: `receives this coin from trades sent by ${n} different wallets (fees or buybacks)` });
    }
    for (const [w, v] of bals[i]!) {
      const others = (big.get(w) ?? 0) - (v * 20n >= supply && w !== lc(d.coin.creator) ? 1 : 0);
      if (!roles.has(w) && others >= 3) roles.set(w, { kind: "whale", says: `also holds 5% or more of ${others} other coins, so it trades across the market` });
    }
    return roles.size ? { ...d, roles } : d;
  });
}
