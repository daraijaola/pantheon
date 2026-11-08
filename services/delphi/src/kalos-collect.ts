// Fetches everything on Kalos for DELPHI: pools from the factory (the chain is the source of truth; Kalos's
// API is only cross-checked), every coin's trades and transfers (busy coins in two windows), LP positions,
// reserves, and the infrastructure set, all cached in the Store so reruns read only what is new. The
// shaping is done by the pure functions in kalos.ts. Read-only: chain reads over the explorer's node, the
// explorer's contract-creation lookup, and Kalos's public lists; no keys, no transactions.
import { encodeFunctionData, getAddress, numberToHex, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { z } from "zod";
import { tokenMeta } from "./chain.ts";
import { STATIC_SYSTEM, TOTAL_SUPPLY } from "./config.ts";
import { decodeLaunch, decodeTransfer, type CoinTransfer, type Skeleton } from "./ingest.ts";
import {
  ascendTradesOnKalos,
  assembleKalos,
  BASE_TOKENS,
  BURN,
  coinsOf,
  decodeLiq,
  decodeNpm,
  decodePoolCreated,
  decodeV3Swap,
  inWindows,
  KALOS,
  KALOS_READ,
  launchOf,
  liquidityReport,
  poolsOf,
  positionsOf,
  TOPIC,
  type KalosToken,
  type LiquidityReport,
  type Window,
} from "./kalos.ts";
import { blockTimesOf, creationsOf, hexAddress, kindsOf, scanStreams, sendersOf, viewsAt, type StreamSpec, type View } from "./reads.ts";
import type { BatchRpc } from "./rpc.ts";
import type { Store } from "./store.ts";
import type { Trade } from "./types.ts";

const lc = (a: string) => a.toLowerCase();
const VIEWS = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
]);

const ApiConfig = z.object({
  chainId: z.number(),
  contracts: z.record(z.string(), hexAddress),
  deployment: z.object({ contracts: z.record(z.string(), z.object({ address: hexAddress, deploymentBlock: z.number().nullable().optional() })) }).optional(),
  settlement: z
    .object({ settler: z.object({ address: hexAddress }).nullable().optional(), allowanceHolder: z.object({ address: hexAddress }).nullable().optional() })
    .nullable()
    .optional(),
});
const ApiPools = z.object({
  rows: z.array(z.object({ address: hexAddress, token0: z.object({ address: hexAddress }), token1: z.object({ address: hexAddress }), fee: z.number() })),
  next: z.string().nullable().optional(),
});
const ApiTokens = z.object({ rows: z.array(z.object({ address: hexAddress, symbol: z.string().nullable(), decimals: z.number() })) });

/** GET a Kalos API path as JSON, a few tries (it answered 502 now and then, seen live). Null if it never answers. */
async function kalosGet(fetchFn: typeof fetch, path: string): Promise<unknown> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetchFn(new URL(path, KALOS.api), {
        headers: { "user-agent": "delphi (read-only checks; pantheonindex.com)", accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
      if (res.ok) return await res.json();
    } catch {
      // try again
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, 1_000 * 2 ** attempt));
  }
  return null;
}

/** Kalos's own lists: its contracts (all infrastructure), pools and tokens. Each is null when unreachable. */
async function kalosLists(fetchFn: typeof fetch): Promise<{ contracts: Address[] | null; factory: Address | null; positionManager: Address | null; pools: z.infer<typeof ApiPools>["rows"] | null; tokens: z.infer<typeof ApiTokens>["rows"] | null }> {
  const cfg = ApiConfig.safeParse(await kalosGet(fetchFn, "/v2/dex/config"));
  const pools: z.infer<typeof ApiPools>["rows"] = [];
  let cursor: string | null | undefined = "";
  let poolsOk = true;
  for (let page = 0; cursor !== null && cursor !== undefined && page < 50; page++) {
    const got = ApiPools.safeParse(await kalosGet(fetchFn, `/v2/dex/pools${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`));
    if (!got.success) {
      poolsOk = false;
      break;
    }
    pools.push(...got.data.rows);
    cursor = got.data.next;
  }
  const tokens = ApiTokens.safeParse(await kalosGet(fetchFn, "/v2/dex/tokens"));
  const c = cfg.success ? cfg.data : null;
  return {
    contracts: c
      ? [...Object.values(c.contracts), ...Object.values(c.deployment?.contracts ?? {}).map((x) => x.address), ...[c.settlement?.settler?.address, c.settlement?.allowanceHolder?.address].filter((a): a is Address => !!a)]
      : null,
    factory: c?.contracts.factory ?? null,
    positionManager: c?.contracts.positionManager ?? null,
    pools: poolsOk ? pools : null,
    tokens: tokens.success ? tokens.data.rows : null,
  };
}

export type KalosCollected = {
  skeletons: Skeleton[];
  /** Ascend coins' trades in Kalos pools (token, lowercase → trades, `outside: true`), to add to the Ascend coin. */
  ascendExtras: Map<string, Trade[]>;
  system: Set<string>;
  contracts: Set<string>;
  /** token (lowercase) → its pools, LP positions and liquidity history. */
  liquidity: Map<string, LiquidityReport>;
  notes: string[];
  head: bigint;
};

type Mode = "full" | "window";
type Snapshot = { block: string; balances: Record<string, string> };
const DEFAULT_LAUNCHPAD: Address = "0xE2f6254508DEB93Da081837F545e0bAF7b00d8E9";
const DEFAULT_LAUNCH_FROM = 3_574_000n;
const balanceOf = (token: Address, who: Address): View => ({ to: token, data: encodeFunctionData({ abi: VIEWS, functionName: "balanceOf", args: [who] }) });
const read = (to: Address, functionName: "totalSupply" | "decimals" | "slot0", block?: bigint): View => ({
  to,
  data: encodeFunctionData({ abi: VIEWS, functionName }),
  ...(block !== undefined ? { block } : {}),
});
/** A busy stream's first range: about 4,000 KALOS transfers on Oct 31. */
const BUSY_STEP = 20_000n;
const word = (r: Hex | null) => (r && r.length >= 66 ? BigInt(r.slice(0, 66)) : null);
const fmtDate = (t: number | undefined) => (t ? new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "?");

/**
 * Everything on Kalos, end to end: pools from the factory (the chain is the source of truth; Kalos's
 * API is only cross-checked), every coin's trades and transfers (busy coins in two windows), LP
 * positions, reserves, and the infrastructure set. Ascend coins found in Kalos pools are not made into
 * Kalos coins: their Kalos trades come back in `ascendExtras`.
 */
export async function collectKalos(deps: {
  client: PublicClient;
  rpc: BatchRpc;
  store: Store;
  log?: (m: string) => void;
  fetch?: typeof fetch;
  recentBlocks?: bigint;
  /** Ascend's launchpad and its first block (defaults: the config's). */
  launchpad?: Address;
  launchFrom?: bigint;
}): Promise<KalosCollected> {
  const { client, rpc, store } = deps;
  const log = deps.log ?? (() => {});
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const recent = deps.recentBlocks ?? KALOS_READ.recentBlocks;
  const launchpad = deps.launchpad ?? DEFAULT_LAUNCHPAD;
  const notes: string[] = [];
  const started = rpc.requests;

  // Kalos's own lists answer slowly (and 502 now and then): read them while the chain is read.
  const lists = kalosLists(fetchFn);
  const npm = getAddress(KALOS.positionManager);
  const head = BigInt(await rpc.call<Hex>("eth_blockNumber", []));
  const windowFrom = head - recent + 1n;

  // Pools from the factory, and Ascend's launches (the same stream ingest.ts keeps).
  const streams = { pools: `kalos:pools:${lc(KALOS.factory)}`, launched: `launched:${lc(launchpad)}`, liq: `kalos:liq:${lc(KALOS.factory)}`, npm: `kalos:npm:${lc(npm)}` };
  await scanStreams(rpc, store, [
    { stream: streams.pools, address: KALOS.factory, topics: [TOPIC.poolCreated], from: KALOS.factoryBlock, to: head },
    { stream: streams.launched, address: launchpad, topics: [TOPIC.launched], from: deps.launchFrom ?? DEFAULT_LAUNCH_FROM, to: head },
  ]);
  const pools = store.logs(streams.pools).map(decodePoolCreated);
  const ascend = new Set(store.logs(streams.launched).map(decodeLaunch).map((l) => lc(l.token)));
  log(`${pools.length} Kalos pools up to block ${head}; ${ascend.size} Ascend launches`);

  // Liquidity, whole history: every pool's Mints and Burns, and the position manager's NFTs.
  await scanStreams(rpc, store, [
    ...(pools.length ? [{ stream: streams.liq, address: pools.map((p) => p.pool), topics: [[TOPIC.mint, TOPIC.burn]], from: KALOS.factoryBlock, to: head, times: true } satisfies StreamSpec] : []),
    { stream: streams.npm, address: npm, topics: [[TOPIC.increase, TOPIC.decrease, TOPIC.transfer]], from: KALOS.factoryBlock, to: head },
  ], (d, t, n) => log(`  liquidity events: ${n} new (${d}/${t} streams done)`));
  const liq = store.logs(streams.liq).map(decodeLiq);
  const npmEvents = store.logs(streams.npm).filter((l) => l.topics.length === 4 || l.topics[0] !== TOPIC.transfer).map(decodeNpm);
  log(`${liq.length} pool mints/burns, ${npmEvents.length} position-manager events`);

  // Kalos's own lists: cross-checked against the chain, never trusted over it.
  const api = await lists;
  if (!api.contracts) notes.push("Kalos API config unreachable: infrastructure is DELPHI's built-in Kalos list only.");
  if (api.factory && lc(api.factory) !== lc(KALOS.factory)) notes.push(`Kalos API names a different factory (${api.factory}); DELPHI reads ${KALOS.factory}.`);
  if (api.positionManager && lc(api.positionManager) !== lc(KALOS.positionManager)) notes.push(`Kalos API names a different position manager (${api.positionManager}).`);
  if (api.pools) {
    const onChain = new Set(pools.map((p) => lc(p.pool)));
    const listed = new Set(api.pools.map((p) => lc(p.address)));
    const missing = [...onChain].filter((p) => !listed.has(p));
    const extra = [...listed].filter((p) => !onChain.has(p));
    if (missing.length || extra.length) {
      notes.push(`Kalos API lists ${listed.size} pools, the factory created ${onChain.size}` + (missing.length ? `; not listed: ${missing.join(", ")}` : "") + (extra.length ? `; not from the factory: ${extra.join(", ")}` : "") + ".");
    }
  } else notes.push("Kalos API pool list unreachable: pools are not cross-checked.");

  // Coins: every non-base token in a pool. Ascend coins only lend their Kalos trades.
  const split = coinsOf(pools, ascend);
  const tokens = [...split.kalos, ...split.ascend];
  const ascendHere = split.ascend;
  const launches = new Map(tokens.map((t) => [lc(t), launchOf(t, pools, liq)] as const));
  const coins = split.kalos.filter((t) => launches.get(lc(t)));
  for (const t of split.kalos) if (!launches.get(lc(t))) notes.push(`${t}: in a Kalos pool that never got liquidity; not a coin.`);
  if (api.tokens) {
    const listed = new Set(api.tokens.map((t) => lc(t.address)));
    const unlisted = tokens.filter((t) => !listed.has(lc(t)));
    if (unlisted.length) notes.push(`Kalos API token list leaves out ${unlisted.join(", ")}.`);
  }
  log(`${coins.length} Kalos coins, ${ascendHere.length} Ascend coins in Kalos pools`);

  // Who deployed each coin (the creator), and when: a full read starts there.
  const created = await creationsOf(rpc, store, coins, fetchFn);
  const startOf = (t: string) => {
    const c = created.get(lc(t));
    return c ? c.block : null;
  };

  // Full history or two windows, decided once per coin from samples of its transfers.
  const modes = new Map<string, Mode>();
  const unsure: Address[] = [];
  for (const t of coins) {
    const remembered = store.recall<Mode>("kalos:mode", lc(t));
    const start = startOf(t);
    if (start === null) modes.set(lc(t), "window"); // no deployment block: balances can't be replayed
    else if (start >= windowFrom) modes.set(lc(t), "full");
    else if (remembered) modes.set(lc(t), remembered);
    else unsure.push(t);
  }
  // Samples spread over the coin's life, the last one ending at the head: a coin busy only in its early
  // days is caught too (ELYS: none in its last 37 min, 134,000+ transfers before Kalos existed).
  const samples = (t: string) => {
    const start = startOf(t)!;
    const n = BigInt(KALOS_READ.probes);
    return Array.from({ length: KALOS_READ.probes }, (_, i) => {
      const to = start + ((head - start) * (BigInt(i) + 1n)) / n;
      const from = to - KALOS_READ.probeBlocks + 1n > start ? to - KALOS_READ.probeBlocks + 1n : start;
      return [from, to] as const;
    });
  };
  for (let i = 0; i < unsure.length; i += 4) {
    const part = unsure.slice(i, i + 4);
    const ranges = part.map(samples);
    const answers = await rpc.many<unknown[]>(
      ranges.flat().map(([from, to], j) => ({ method: "eth_getLogs", params: [{ address: part[Math.floor(j / KALOS_READ.probes)]!, topics: [TOPIC.transfer], fromBlock: numberToHex(from), toBlock: numberToHex(to) }] })),
    );
    part.forEach((t, j) => {
      const mine = answers.slice(j * KALOS_READ.probes, (j + 1) * KALOS_READ.probes);
      const seen = mine.some((a) => a.error) ? Infinity : mine.reduce((s, a) => s + (a.result?.length ?? 0), 0);
      const sampled = ranges[j]!.reduce((s, [from, to]) => s + Number(to - from + 1n), 0);
      const estimate = (seen * Number(head - startOf(t)!)) / sampled;
      const mode: Mode = estimate > KALOS_READ.fullMaxTransfers ? "window" : "full";
      modes.set(lc(t), mode);
      store.remember("kalos:mode", lc(t), mode);
      log(`  ${t}: ${Number.isFinite(seen) ? seen : "10,000+"} transfers in ${KALOS_READ.probes} samples → about ${Number.isFinite(estimate) ? Math.round(estimate).toLocaleString("en-US") : "many"} in its life: ${mode === "full" ? "full history" : "windows"}`);
    });
  }
  const launchEnd = (t: string) => {
    const l = launches.get(lc(t))!;
    const end = l.block + KALOS_READ.launchBlocks;
    return end < head ? end : head;
  };

  /** A busy coin's launch window: from its deployment (at most a day before its first liquidity) to just after. */
  const launchStart = (t: string) => {
    const first = launches.get(lc(t))!.block;
    const start = startOf(t) ?? first;
    return start > first - KALOS_READ.preLaunchBlocks ? start : first - KALOS_READ.preLaunchBlocks;
  };
  const stream = (t: string, part: "full" | "launch" | "recent") => `kalos:transfer:${lc(t)}${part === "full" ? "" : `:${part}`}`;

  // Transfers. A full read stops at 3× the limit (counting what earlier runs read); that coin then switches to windows.
  const transferSpecs = (t: Address): StreamSpec[] => {
    if (modes.get(lc(t)) === "full") {
      const cap = 3 * KALOS_READ.fullMaxTransfers - store.countLogs(stream(t, "full"));
      return [{ stream: stream(t, "full"), address: t, topics: [TOPIC.transfer], from: startOf(t)!, to: head, maxLogs: cap > 0 ? cap : 0 }];
    }
    store.trimLogs(stream(t, "recent"), windowFrom);
    return [
      { stream: stream(t, "launch"), address: t, topics: [TOPIC.transfer], from: launchStart(t), to: launchEnd(t) },
      { stream: stream(t, "recent"), address: t, topics: [TOPIC.transfer], from: windowFrom, to: head, step: BUSY_STEP },
    ];
  };
  // Ascend coins: only their transfers since their first Kalos pool, to see whose balance each trade moved.
  const ascendSpecs = ascendHere.map((t): StreamSpec => ({ stream: stream(t, "full"), address: t, topics: [TOPIC.transfer], from: poolsOf(t, pools).map((p) => p.block).reduce((a, b) => (a < b ? a : b)), to: head }));
  const scanned = await scanStreams(rpc, store, [...coins.flatMap(transferSpecs), ...ascendSpecs], (d, t, n) => log(`  transfers: ${n} new (${d}/${t} streams done)`));
  const switched = coins.filter((t) => modes.get(lc(t)) === "full" && (scanned.get(stream(t, "full"))?.capped || store.countLogs(stream(t, "full")) > 3 * KALOS_READ.fullMaxTransfers));
  if (switched.length) {
    for (const t of switched) {
      modes.set(lc(t), "window");
      store.remember("kalos:mode", lc(t), "window");
      notes.push(`${t}: busier than its sample showed; read in windows from now on.`);
    }
    await scanStreams(rpc, store, switched.flatMap(transferSpecs), (d, t, n) => log(`  transfers: ${n} new (${d}/${t} streams done)`));
  }
  const windowsOf = (t: string): Window[] | undefined => (modes.get(lc(t)) === "full" ? undefined : [[launchStart(t), launchEnd(t)], [windowFrom, head]]);
  const readLogs = (stream: string) => store.logs(stream);
  const dedupe = <T extends { block: bigint; logIndex: number }>(xs: T[]) => [...new Map(xs.map((x) => [`${x.block}:${x.logIndex}`, x])).values()];
  const transfers: CoinTransfer[] = [...coins, ...ascendHere].flatMap((t) =>
    dedupe((modes.get(lc(t)) === "window" ? [...readLogs(stream(t, "launch")), ...readLogs(stream(t, "recent"))] : readLogs(stream(t, "full"))).filter((l) => l.topics.length === 3).map(decodeTransfer)),
  );
  log(`${transfers.length} token transfers`);

  // Swaps, per pool: in full when any coin in it is read in full, else in its coins' windows.
  const swapSpecs = pools.flatMap((p): StreamSpec[] => {
    const members = [p.token0, p.token1].filter((t) => coins.some((c) => lc(c) === lc(t)) || ascendHere.some((c) => lc(c) === lc(t)));
    if (!members.length) return [];
    const full = members.some((t) => ascend.has(lc(t)) || modes.get(lc(t)) === "full");
    const ends = members.filter((t) => modes.get(lc(t)) === "window").map(launchEnd).filter((e) => e >= p.block);
    const earlyEnd = full ? head : ends.length ? ends.reduce((a, b) => (a > b ? a : b)) : p.block - 1n;
    const specs: StreamSpec[] = [{ stream: `kalos:swap:${lc(p.pool)}`, address: p.pool, topics: [TOPIC.swap], from: p.block, to: earlyEnd, times: true }];
    if (!full) {
      store.trimLogs(`kalos:swap:${lc(p.pool)}:recent`, windowFrom);
      specs.push({ stream: `kalos:swap:${lc(p.pool)}:recent`, address: p.pool, topics: [TOPIC.swap], from: windowFrom, to: head, times: true, step: BUSY_STEP });
    }
    return specs;
  });
  await scanStreams(rpc, store, swapSpecs, (d, t, n) => log(`  swaps: ${n} new (${d}/${t} streams done)`));
  const swaps = dedupe(swapSpecs.flatMap((s) => readLogs(s.stream)).map(decodeV3Swap));
  log(`${swaps.length} swaps`);

  // Only what will be used: swaps inside some coin's windows, and every launch.
  const coinWindows = new Map([...coins, ...ascendHere].map((t) => [lc(t), windowsOf(t)] as const));
  const poolCoins = new Map(pools.map((p) => [lc(p.pool), [p.token0, p.token1].filter((t) => coinWindows.has(lc(t)))] as const));
  const used = swaps.filter((s) => (poolCoins.get(lc(s.pool)) ?? []).some((t) => ascend.has(lc(t)) || inWindows(s.block, coinWindows.get(lc(t)))));
  const launchList = coins.map((t) => launches.get(lc(t))!);
  const txFrom = await sendersOf(rpc, store, [...used, ...launchList].map((x) => x.tx), (done, total) => log(`  senders: ${done.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} new transactions`), new Map([...used, ...launchList].map((x) => [lc(x.tx), x.block])));
  const windowed = coins.filter((t) => modes.get(lc(t)) === "window");
  const edges = windowed.length ? [windowFrom, ...windowed.map(launchEnd)] : [];
  const blockTime = await blockTimesOf(rpc, store, [...[...used, ...launchList, ...liq].map((x) => x.block), ...edges].map(String));
  log(`senders of ${txFrom.size} transactions, ${blockTime.size} block times`);

  // Infrastructure: Kalos's contracts, every pool, every router seen swapping, the factories that made coins.
  const system = new Set(
    [
      ...STATIC_SYSTEM,
      ...KALOS.contracts,
      ...(api.contracts ?? []),
      ...pools.map((p) => p.pool),
      ...swaps.map((s) => s.sender),
      ...[...created.values()].flatMap((c) => (c?.factory ? [c.factory] : [])),
      ...BURN,
    ].map(lc),
  );
  const { positions, changes, unmatched } = positionsOf(liq, npmEvents, npm);
  if (unmatched) notes.push(`${unmatched} position-manager liquidity events could not be tied to a pool and are left out.`);
  const coinPools = new Set(pools.filter((p) => coinWindows.has(lc(p.token0)) || coinWindows.has(lc(p.token1))).map((p) => lc(p.pool)));
  const lpOwners = [...positions.values()].filter((p) => coinPools.has(lc(p.pool)) && p.liquidity > 0n).map((p) => p.owner);
  const deployers = [...created.values()].flatMap((c) => (c?.deployer ? [c.deployer] : []));
  const parties = new Set(
    [...transfers.flatMap((t) => [t.from, t.to]), ...[...txFrom.values()], ...lpOwners, ...deployers].map(lc).filter((a) => !system.has(a)),
  );
  const kinds = await kindsOf(rpc, store, parties);
  const contracts = new Set<string>();
  for (const [a, k] of kinds) {
    if (k === "wallet") continue;
    system.add(a);
    if (k === "contract") contracts.add(a);
  }
  log(`${parties.size} addresses checked: ${[...kinds.values()].filter((k) => k === "pool").length} other pools, ${contracts.size} other contracts`);

  // Reserves and prices of the coins' pools, each coin's supply and decimals, at the head and at launch.
  const reservePools = pools.filter((p) => coinPools.has(lc(p.pool)));
  const reserveCalls = reservePools.flatMap((p) => [balanceOf(p.token0, p.pool), balanceOf(p.token1, p.pool)]);
  const reserveAns = await viewsAt(rpc, [...reserveCalls, ...reservePools.map((p) => read(p.pool, "slot0"))], head);
  const reserves = new Map<string, bigint>();
  const prices = new Map<string, bigint>();
  reservePools.forEach((p, i) => {
    const [r0, r1, s0] = [reserveAns[2 * i], reserveAns[2 * i + 1], reserveAns[reserveCalls.length + i]];
    if (word(r0 ?? null) !== null) reserves.set(`${lc(p.pool)}:${lc(p.token0)}`, word(r0 ?? null)!);
    if (word(r1 ?? null) !== null) reserves.set(`${lc(p.pool)}:${lc(p.token1)}`, word(r1 ?? null)!);
    if (word(s0 ?? null)) prices.set(lc(p.pool), word(s0 ?? null)!);
  });
  const supplyNow = await viewsAt(rpc, coins.flatMap((t) => [read(t, "totalSupply"), read(t, "decimals")]), head);
  const supplyThen = (await viewsAt(rpc, coins.map((t) => read(t, "totalSupply", launches.get(lc(t))!.block)), head)).map((r) => word(r));
  const meta = await tokenMeta(client, store, [...coins, ...BASE_TOKENS]);
  const symbols = new Map([...meta].map(([k, v]) => [k, v.symbol]));

  // Busy coins: balances from the token for everyone seen in the windows, plus the creator, deployer
  // and LP owners. A remembered snapshot is reused for addresses that moved no tokens since it (a
  // balance only changes with a Transfer event: a rebasing token would break this).
  const kalosTokens: KalosToken[] = [];
  const perCoinNotes = new Map<string, string[]>();
  const transfersOf = Map.groupBy(transfers, (x) => lc(x.token));
  for (const [i, t] of coins.entries()) {
    const own: string[] = [];
    perCoinNotes.set(lc(t), own);
    const supply = word(supplyNow[2 * i] ?? null);
    if (supply === null) {
      notes.push(`${t}: totalSupply() can't be read, so shares of supply can't be measured; left out.`);
      continue;
    }
    const decimals = word(supplyNow[2 * i + 1] ?? null);
    if (decimals !== null && decimals !== 18n) own.push(`${decimals} decimals, not 18. DELPHI's checks use shares of the supply, so they are unaffected, but token amounts shown elsewhere assume 18.`);
    const then = supplyThen[i];
    if (then !== null && then !== undefined && then !== supply) own.push(`Supply changed since launch: ${then} then, ${supply} now (smallest units). Shares of supply use today's.`);
    const c = created.get(lc(t));
    if (!c) own.push("The explorer didn't say who deployed this token: the first liquidity's sender stands in as creator.");
    else if (!c.deployer) own.push("No deployer found in the creation block's traces: the first liquidity's sender stands in as creator.");
    const windows = windowsOf(t);
    const k: KalosToken = { token: t, deployer: c?.deployer ?? null, name: meta.get(lc(t))?.name ?? null, symbol: meta.get(lc(t))?.symbol ?? null, supply, windows };
    if (windows) {
      const mine = (transfersOf.get(lc(t)) ?? []).filter((x) => inWindows(x.block, windows));
      const launch = launches.get(lc(t))!;
      const span = (blockTime.get(launchEnd(t).toString()) ?? 0) - (blockTime.get(launch.block.toString()) ?? 0);
      if (span < 30) own.push(`The launch window read covers only ${span} s, less than the 30 s the bundle check looks at.`);
      const roleSet = [c?.deployer, txFrom.get(lc(launch.tx))].filter((a): a is Address => !!a);
      const lpHere = [...positions.values()].filter((p) => p.liquidity > 0n && poolsOf(t, pools).some((q) => lc(q.pool) === lc(p.pool))).map((p) => p.owner);
      const wanted = [...new Set([...mine.flatMap((x) => [x.from, x.to]), ...roleSet, ...lpHere].map(lc))].filter((a) => !BURN.has(a));
      const snap = store.recall<Snapshot>("kalos:holdings", lc(t));
      const since = snap ? BigInt(snap.block) : null;
      const touched = new Set(since === null ? [] : mine.filter((x) => x.block > since).flatMap((x) => [lc(x.from), lc(x.to)]));
      const reuse = since !== null && since >= windowFrom;
      const ask = wanted.filter((a) => !reuse || snap!.balances[a] === undefined || touched.has(a));
      const got = await viewsAt(rpc, ask.map((a) => balanceOf(t, getAddress(a))), head);
      const holdings = new Map<string, bigint>();
      for (const a of wanted) if (reuse && !touched.has(a) && snap!.balances[a] !== undefined) holdings.set(a, BigInt(snap!.balances[a]!));
      ask.forEach((a, j) => holdings.set(a, word(got[j] ?? null) ?? 0n));
      store.remember("kalos:holdings", lc(t), { block: head.toString(), balances: Object.fromEntries([...holdings].map(([a, v]) => [a, v.toString()])) } satisfies Snapshot);
      k.holdings = holdings;
      k.windowFrom = windowFrom;
      const from = blockTime.get(windowFrom.toString());
      own.push(
        `Too busy to read in full: trades and transfers are its launch (blocks ${windows[0]![0]}-${windows[0]![1]}) and the last ${recent} blocks (from block ${windowFrom}${from ? `, ${fmtDate(from)}` : ""}). ` +
          `Holders are the ${holdings.size.toLocaleString("en-US")} addresses seen moving tokens in those windows plus the creator, deployer and LP owners, with balances read from the token at block ${head}: wallets that never moved the token in those windows are not counted.`,
      );
      log(`  ${k.symbol ?? t}: ${ask.length} balances read (${holdings.size - ask.length} reused)`);
    } else {
      // Full history: the replayed balances must add up to the supply.
      const bal = new Map<string, bigint>();
      for (const x of transfersOf.get(lc(t)) ?? []) {
        bal.set(lc(x.from), (bal.get(lc(x.from)) ?? 0n) - x.value);
        bal.set(lc(x.to), (bal.get(lc(x.to)) ?? 0n) + x.value);
      }
      const held = [...bal].filter(([a, v]) => a !== "0x0000000000000000000000000000000000000000" && v > 0n).reduce((s, [, v]) => s + v, 0n);
      if (held !== supply) own.push(`Replayed balances add up to ${held}, not the supply ${supply}: some balance changes have no Transfer event, so holder shares may be off.`);
    }
    kalosTokens.push(k);
  }

  const skeletons = assembleKalos({ tokens: kalosTokens, pools, swaps: used, liquidity: liq, transfers, txFrom, blockTime, system, contracts, reserves });
  const ascendExtras = ascendTradesOnKalos({ tokens: ascendHere, pools, swaps: used, transfers, txFrom, blockTime, system });

  // LP owners that are infrastructure (a Kalos contract, a pool) are contracts too.
  const ownerKinds = new Map(kinds);
  for (const a of lpOwners.map(lc)) if (!ownerKinds.has(a) && system.has(a)) ownerKinds.set(a, "contract");
  const liquidity = new Map<string, LiquidityReport>();
  for (const s of skeletons) {
    const t = s.coin.token;
    const i = coins.findIndex((c) => lc(c) === lc(t));
    const w = windowsOf(t);
    const then = supplyThen[i];
    const own = perCoinNotes.get(lc(t)) ?? [];
    for (const n of own) notes.push(`${s.coin.symbol ?? t}: ${n}`);
    liquidity.set(
      lc(t),
      liquidityReport({
        token: t,
        symbol: s.coin.symbol,
        decimals: (() => {
          const d = word(supplyNow[2 * i + 1] ?? null);
          return d === null ? null : Number(d);
        })(),
        supply: s.coin.supply ?? TOTAL_SUPPLY,
        supplyAtLaunch: then !== null && then !== undefined && then !== s.coin.supply ? then : null,
        read: w ? { full: false, launch: w[0]!, recent: w[1]! } : { full: true },
        pools,
        positions,
        changes,
        reserves,
        prices,
        roles: { creator: s.coin.creator, launcher: s.coin.launcher, ...(created.get(lc(t))?.deployer ? { deployer: created.get(lc(t))!.deployer! } : {}) },
        kinds: ownerKinds,
        symbols,
        blockTime,
        notes: own,
      }),
    );
  }
  log(`done: ${rpc.requests - started} requests to the explorer's node`);
  return { skeletons, ascendExtras, system, contracts, liquidity, notes, head };
}

