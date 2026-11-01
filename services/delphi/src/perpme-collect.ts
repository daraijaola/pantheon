// Fetches every PerpMe launch for DELPHI: the launch factory's TokenDeployed/TokenLaunched events (the
// chain is the source of truth; PerpMe's own API is only cross-checked), every coin's transfers, swaps and
// liquidity events in its pool, the LP positions and who holds them, reserves and prices, and the
// infrastructure set, all cached in the Store with a cursor per stream so reruns read only what is new. The
// shaping is done by the pure functions in perpme.ts. Read-only: chain reads over the explorer's node and
// PerpMe's public lists; no keys, no transactions.
//
// Coins are read in streams of up to CHUNK coins at once (one eth_getLogs names every token or pool in the
// chunk). A chunk only ever grows at its end, with coins launched after its cursor, so a resumed stream
// never misses an earlier coin's history: launches are read up to the head first, then everything else up
// to the same head.
import { encodeFunctionData, getAddress, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { z } from "zod";
import { tokenMeta } from "./chain.ts";
import { STATIC_SYSTEM } from "./config.ts";
import { decodeTransfer, type CoinTransfer, type Skeleton } from "./ingest.ts";
import { BURN, decodeLiq, decodeNpm, decodePoolCreated, decodeV3Swap, positionsOf, TOPIC } from "./kalos.ts";
import { PerpmeApi } from "./perpme-api.ts";
import {
  assemblePerpme,
  busyCoins,
  creatorBuyOf,
  launchesOf,
  PERPME,
  PERPME_CONTRACTS,
  PERPME_RULES,
  PERPME_TOPIC,
  perpmeLiquidity,
  type PerpmeCoin,
  type PerpmeLaunch,
  type PerpmeLiquidity,
} from "./perpme.ts";
import { blockTimesOf, kindsOf, scanStreams, sendersOf, viewsAt, type StreamSpec, type View } from "./reads.ts";
import type { BatchRpc } from "./rpc.ts";
import type { Store } from "./store.ts";

const lc = (a: string) => a.toLowerCase();
const VIEWS = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function ownerOf(uint256) view returns (address)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
]);
const view = (to: Address, data: Hex): View => ({ to, data });
const balanceOf = (token: Address, who: Address) => view(token, encodeFunctionData({ abi: VIEWS, functionName: "balanceOf", args: [who] }));
const word = (r: Hex | null | undefined) => (r && r.length >= 66 ? BigInt(r.slice(0, 66)) : null);
const wordAddress = (r: Hex | null | undefined) => (r && /^0x0{24}[0-9a-f]{40}/i.test(r) ? getAddress(`0x${r.slice(26, 66)}`) : null);
/** Coins per log stream: 250 addresses keep one eth_getLogs request around 11 KB. */
const CHUNK = 250;

export type PerpmeCollected = {
  skeletons: Skeleton[];
  system: Set<string>;
  contracts: Set<string>;
  /** token (lowercase) → its pool, lock and reserves. */
  liquidity: Map<string, PerpmeLiquidity>;
  notes: string[];
  head: bigint;
  /** The parent chain's block at the head (its l1BlockNumber): launch protection counts in these. */
  parentHead: bigint | null;
  /** Every launch read, xStocks included (`xstock: true`), oldest first. */
  launches: PerpmeLaunch[];
};

const Header = z.object({ l1BlockNumber: z.string().optional() });

/**
 * Every PerpMe coin, end to end. Tokenized-stock coins ("… xStock") are left out unless `xstocks` is set,
 * as Kalos's Sniper hides them; they still come back in `launches`.
 */
export async function collectPerpme(deps: {
  client: PublicClient;
  rpc: BatchRpc;
  store: Store;
  log?: (m: string) => void;
  fetch?: typeof fetch;
  /** Launch factories to read (default: the one Kalos's Sniper pins, PERPME.launchFactory). */
  factories?: readonly Address[];
  /** Also read the xStock coins (default false). */
  xstocks?: boolean;
}): Promise<PerpmeCollected> {
  const { rpc, store } = deps;
  const log = deps.log ?? (() => {});
  const factories = (deps.factories ?? [PERPME.launchFactory]).map((f) => getAddress(f));
  const notes: string[] = [];
  const started = rpc.requests;
  const api = new PerpmeApi(deps.fetch ? { fetch: deps.fetch } : {});
  // PerpMe's list answers in about 20 pages: read it while the chain is read.
  const listed = api.tokens().catch((err: unknown) => {
    notes.push(`PerpMe's token list could not be read (${(err as Error).message.slice(0, 160)}): launches are not cross-checked.`);
    return null;
  });

  const head = BigInt(await rpc.call<Hex>("eth_blockNumber", []));
  const header = Header.safeParse(await rpc.call("eth_getBlockByNumber", [`0x${head.toString(16)}`, false]));
  const parentHead = header.success && header.data.l1BlockNumber ? BigInt(header.data.l1BlockNumber) : null;

  // Launches, and every pool PerpMe's V3 factory ever made (all of them are infrastructure).
  const launchStream = (f: string) => `perpme:launch:${lc(f)}`;
  const poolStream = `perpme:pools:${lc(PERPME.poolFactory)}`;
  await scanStreams(rpc, store, [
    ...factories.map((f): StreamSpec => ({ stream: launchStream(f), address: f, topics: [[PERPME_TOPIC.deployed, PERPME_TOPIC.launched]], from: PERPME.fromBlock, to: head, times: true })),
    { stream: poolStream, address: getAddress(PERPME.poolFactory), topics: [TOPIC.poolCreated], from: 0n, to: head },
  ]);
  const pools = store.logs(poolStream).map(decodePoolCreated);
  const all: PerpmeLaunch[] = [];
  for (const f of factories) {
    const { launches, orphans } = launchesOf(store.logs(launchStream(f)));
    all.push(...launches);
    if (orphans) notes.push(`${orphans} coin(s) deployed by ${f} were never launched (no pool): not coins.`);
  }
  const launches = all.sort((a, b) => (a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1));
  const read = launches.filter((l) => deps.xstocks || !l.xstock);
  const hidden = launches.length - read.length;
  log(`${launches.length} PerpMe launches up to block ${head} (${hidden} xStocks left out), ${pools.length} pools on PerpMe's V3 factory`);
  if (hidden) notes.push(`${hidden} tokenized-stock launches ("… xStock") are left out, as Kalos's Sniper hides them.`);
  const poolSet = new Set(pools.map((p) => lc(p.pool)));
  const noPool = read.filter((l) => !poolSet.has(lc(l.pool)));
  if (noPool.length) notes.push(`${noPool.length} launch(es) name a pool PerpMe's V3 factory never created: ${noPool.map((l) => l.token).join(", ")}.`);

  // Each chunk's transfers, swaps, and Mints/Burns; the position manager's events.
  const npm = getAddress(PERPME.positionManager);
  const key = deps.xstocks ? "all" : "real";
  const chunks: PerpmeLaunch[][] = [];
  for (let i = 0; i < read.length; i += CHUNK) chunks.push(read.slice(i, i + CHUNK));
  const specs = chunks.flatMap((c, i): StreamSpec[] => {
    const from = c[0]!.block;
    const name = (what: string) => `perpme:${what}:${lc(factories.join(","))}:${key}:${i}`;
    return [
      { stream: name("transfer"), address: c.map((l) => l.token), topics: [TOPIC.transfer], from, to: head },
      { stream: name("swap"), address: c.map((l) => l.pool), topics: [TOPIC.swap], from, to: head, times: true },
      { stream: name("liq"), address: c.map((l) => l.pool), topics: [[TOPIC.mint, TOPIC.burn]], from, to: head, times: true },
    ];
  });
  const npmStream = `perpme:npm:${lc(npm)}`;
  await scanStreams(rpc, store, [...specs, { stream: npmStream, address: npm, topics: [[TOPIC.increase, TOPIC.decrease, TOPIC.transfer]], from: PERPME.fromBlock, to: head }], (d, t, n) =>
    log(`  coin events: ${n.toLocaleString("en-US")} new (${d}/${t} streams done)`),
  );
  const logsOf = (what: string) => specs.filter((s) => s.stream.startsWith(`perpme:${what}:`)).flatMap((s) => store.logs(s.stream));
  const transfers: CoinTransfer[] = logsOf("transfer").filter((l) => l.topics.length === 3).map(decodeTransfer);
  const swaps = logsOf("swap").map(decodeV3Swap);
  const liq = logsOf("liq").map(decodeLiq);
  // Only the position manager's events for these pools' positions: other PerpMe pools share it.
  const liqTxs = new Set(liq.map((l) => lc(l.tx)));
  const npmAll = store.logs(npmStream).filter((l) => l.topics.length === 4 || l.topics[0] !== TOPIC.transfer).map(decodeNpm);
  const ids = new Set(npmAll.filter((e) => e.kind !== "transfer" && liqTxs.has(lc(e.tx))).map((e) => e.tokenId));
  const npmEvents = npmAll.filter((e) => ids.has(e.tokenId) && (e.kind === "transfer" || liqTxs.has(lc(e.tx))));
  log(`${transfers.length.toLocaleString("en-US")} transfers, ${swaps.length.toLocaleString("en-US")} swaps, ${liq.length} mints/burns, ${npmEvents.length} position-manager events`);
  const busy = busyCoins(transfers);
  for (const [t, n] of busy) notes.push(`${t}: ${n.toLocaleString("en-US")} transfers, more than the ${PERPME_RULES.busyTransfers.toLocaleString("en-US")} a full read is meant for; it was still read in full.`);

  // Who sent each launch and trade, and when.
  const txFrom = await sendersOf(rpc, store, [...read.map((l) => l.tx), ...swaps.map((s) => s.tx)], (done, total) =>
    log(`  senders: ${done.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} new transactions`),
  );
  const blockTime = await blockTimesOf(rpc, store, [...read, ...swaps, ...liq].map((x) => x.block.toString()));

  // Each coin's supply and decimals (decimals never change: remembered), the pools' reserves and prices,
  // and who holds each launch position's NFT, all at the head.
  const knownDecimals = store.recallMany<number>("perpme:decimals", read.map((l) => lc(l.token)));
  const askDecimals = read.filter((l) => !knownDecimals.has(lc(l.token)));
  const supplyAns = await viewsAt(rpc, read.map((l) => view(l.token, encodeFunctionData({ abi: VIEWS, functionName: "totalSupply" }))), head);
  const decAns = await viewsAt(rpc, askDecimals.map((l) => view(l.token, encodeFunctionData({ abi: VIEWS, functionName: "decimals" }))), head);
  const got: Array<[string, number]> = [];
  askDecimals.forEach((l, i) => {
    const d = word(decAns[i]);
    if (d !== null) got.push([lc(l.token), Number(d)]);
  });
  store.rememberMany("perpme:decimals", got);
  for (const [t, d] of got) knownDecimals.set(t, d);
  const poolAns = await viewsAt(
    rpc,
    read.flatMap((l) => [
      balanceOf(l.token, l.pool),
      balanceOf(l.pairToken, l.pool),
      view(l.pool, encodeFunctionData({ abi: VIEWS, functionName: "slot0" })),
      view(npm, encodeFunctionData({ abi: VIEWS, functionName: "ownerOf", args: [l.positionId] })),
    ]),
    head,
  );

  // Infrastructure: PerpMe's contracts and every pool its factory made, the routers seen swapping, burn sinks.
  const system = new Set([...STATIC_SYSTEM, ...PERPME_CONTRACTS, ...factories, ...pools.map((p) => p.pool), ...read.map((l) => l.pool), ...swaps.map((s) => s.sender), ...BURN].map(lc));
  const parties = new Set([...transfers.flatMap((t) => [t.from, t.to]), ...txFrom.values(), ...read.map((l) => l.deployer)].map(lc).filter((a) => !system.has(a)));
  const kinds = await kindsOf(rpc, store, parties);
  const contracts = new Set<string>();
  for (const [a, k] of kinds) {
    if (k === "wallet") continue;
    system.add(a);
    if (k === "contract") contracts.add(a);
  }
  log(`${parties.size} addresses checked: ${[...kinds.values()].filter((k) => k === "pool").length} other pools, ${contracts.size} other contracts`);

  // A launch whose name never came with a TokenDeployed (not seen so far): read it from the token.
  const unnamed = read.filter((l) => l.name === null);
  if (unnamed.length) {
    const meta = await tokenMeta(deps.client, store, unnamed.map((l) => l.token));
    for (const l of unnamed) Object.assign(l, { name: meta.get(lc(l.token))?.name ?? null, symbol: meta.get(lc(l.token))?.symbol ?? null });
  }

  const coins: PerpmeCoin[] = [];
  const perCoin = new Map<string, string[]>();
  read.forEach((l, i) => {
    const own: string[] = [];
    perCoin.set(lc(l.token), own);
    const supply = word(supplyAns[i]);
    if (supply === null) {
      notes.push(`${l.token}: totalSupply() can't be read, so shares of supply can't be measured; left out.`);
      return;
    }
    if (supply !== PERPME_RULES.supply) own.push(`Supply is ${supply}, not PerpMe's 1,000,000,000 coins (smallest units). Shares of supply use it as read.`);
    const decimals = knownDecimals.get(lc(l.token)) ?? null;
    if (decimals === null) own.push("decimals() can't be read: amounts shown assume 18.");
    else if (decimals !== PERPME_RULES.decimals) own.push(`${decimals} decimals, not 18 (Kalos's Sniper won't enable Buy for it). DELPHI's checks use shares of the supply, so they are unaffected.`);
    coins.push({ launch: l, supply, decimals });
  });

  const skeletons = assemblePerpme({ coins, swaps, transfers, txFrom, blockTime, system, contracts });

  // The creator's buy, three ways: the event, the pool's swap (by the sign rule) and the coin's own Transfer.
  let buys = 0;
  let agree = 0;
  for (const { launch: l } of coins) {
    const seen = creatorBuyOf(l, swaps, transfers);
    if (l.initialBuyTokens === 0n && seen.swap === 0n) continue;
    buys++;
    if (seen.swap === l.initialBuyTokens && seen.transfer === l.initialBuyTokens) agree++;
    else perCoin.get(lc(l.token))!.push(`The creator's launch buy reads ${seen.swap} from the swap and ${seen.transfer} from the transfer, but TokenLaunched says ${l.initialBuyTokens}.`);
  }
  notes.push(`Creator buys: ${agree} of ${buys} launch transactions' swaps and transfers equal TokenLaunched's initialBuyTokens exactly.`);
  const relayed = coins.filter(({ launch: l }) => lc(txFrom.get(lc(l.tx)) ?? "") !== lc(l.deployer));
  if (relayed.length) notes.push(`${relayed.length} launch(es) were sent by a wallet other than the deployer they name (the deployer is the creator): ${relayed.map((c) => c.launch.token).join(", ")}.`);

  const { positions, unmatched } = positionsOf(liq, npmEvents, npm);
  if (unmatched) notes.push(`${unmatched} position-manager liquidity events could not be tied to a pool and are left out.`);
  const liquidity = new Map<string, PerpmeLiquidity>();
  const index = new Map(read.map((l, i) => [lc(l.token), i] as const));
  for (const { launch: l, decimals } of coins) {
    const i = index.get(lc(l.token))!;
    const [r0, r1, s0, owner] = poolAns.slice(4 * i, 4 * i + 4);
    const report = perpmeLiquidity({
      launch: l,
      positions,
      tokenReserve: word(r0),
      quoteReserve: word(r1),
      sqrtPriceX96: word(s0),
      positionOwner: wordAddress(owner),
      parentBlock: parentHead,
      ...(decimals !== null ? { decimals } : {}),
    });
    report.notes.unshift(...(perCoin.get(lc(l.token)) ?? []));
    for (const n of report.notes) notes.push(`${l.symbol ?? l.token}: ${n}`);
    liquidity.set(lc(l.token), report);
  }
  const locked = [...liquidity.values()].filter((r) => r.locked).length;
  notes.push(`LP lock: ${locked} of ${liquidity.size} coins' launch positions are held by PerpMe's locker (${PERPME.locker}).`);

  // PerpMe's own list: cross-checked against the chain, never trusted over it.
  const list = await listed;
  if (list) {
    const fromApi = new Set(list.filter((t) => factories.some((f) => f === t.curve)).map((t) => lc(t.id)));
    const onChain = new Set(launches.map((l) => lc(l.token)));
    const missing = [...onChain].filter((t) => !fromApi.has(t));
    const extra = [...fromApi].filter((t) => !onChain.has(t));
    const others = new Map<string, number>();
    for (const t of list) if (!factories.includes(t.curve)) others.set(`${t.curve} (${t.launchType})`, (others.get(`${t.curve} (${t.launchType})`) ?? 0) + 1);
    notes.push(
      `PerpMe's API lists ${fromApi.size} coins from ${factories.join(", ")}; the chain shows ${onChain.size}` +
        (missing.length ? `; not listed yet: ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? ` and ${missing.length - 10} more` : ""}` : "") +
        (extra.length ? `; listed but not seen on chain: ${extra.slice(0, 10).join(", ")}` : "") +
        `. It also lists ${[...others.values()].reduce((s, n) => s + n, 0)} coins from other PerpMe factories, not read here: ${[...others].map(([f, n]) => `${f} ${n}`).join(", ")}.`,
    );
  }
  log(`done: ${skeletons.length} coins, ${rpc.requests - started} requests to the explorer's node`);
  return { skeletons, system, contracts, liquidity, notes, head, parentHead, launches };
}
