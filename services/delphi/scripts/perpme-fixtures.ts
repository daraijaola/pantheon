// Re-records the PerpMe test fixtures in test/fixtures/perpme/ from the live chain (and the dev cache that
// scripts/perpme.ts fills). Read-only, like everything in DELPHI: chain reads and dry runs only. Live, so
// run it by hand, after scripts/perpme.ts:
//   node scripts/perpme-fixtures.ts               all of them
//   node scripts/perpme-fixtures.ts --only coin   one (launches, names, coin, sign, restriction, sell-normal, sell-restricted)
// - launches: raw TokenDeployed/TokenLaunched logs of a few real coins and xStocks, their PoolCreated
//   logs, and their launch blocks' headers (parent block and time);
// - names: every launch's token and name up to the cache's head (xStock detection);
// - coin: one coin's whole history (launch, transfers, swaps, liquidity events, position manager), the
//   senders and block times, its pool's state at the head, every holder's balanceOf at the head, and
//   PerpMe's own holders and trade count;
// - sign: two buys and two sells, read from their receipts, with the coin as token0 and as token1;
// - restriction: the coin's restrictionsActive() at the last block before its window ends and the first after;
// - sell-normal, sell-restricted: tapes (src/tape.ts) of checkSafety on a PerpMe coin, at the head and at
//   a block inside its launch window, with the holder given so the tapes stay small.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeFunctionData, getAddress, parseAbi, toHex, type Address, type Hex } from "viem";
import { makeClient } from "../src/chain.ts";
import { loadConfig } from "../src/config.ts";
import { ContractsApi, ExplorerApi } from "../src/conduit.ts";
import { KalosApi } from "../src/kalos-api.ts";
import { TOPIC } from "../src/kalos.ts";
import { PerpmeApi } from "../src/perpme-api.ts";
import { collectPerpme } from "../src/perpme-collect.ts";
import { PERPME } from "../src/perpme.ts";
import { BatchRpc } from "../src/rpc.ts";
import { checkSafety } from "../src/safety.ts";
import { Store } from "../src/store.ts";
import { emptyTape, recordingFetch, type Tape } from "../src/tape.ts";

const DIR = "test/fixtures/perpme";
const log = (m: string) => console.error(`[perpme-fixtures] ${m}`);
const lc = (a: string) => a.toLowerCase();
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : undefined;
const wanted = (name: string) => !only || only === name;
const save = (name: string, body: unknown) => {
  writeFileSync(join(DIR, `${name}.json`), `${JSON.stringify(body, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v))}\n`);
  log(`${name}.json written`);
};

/** The coins the fixtures are about (all on PerpMe's current factory, Elysium testnet). */
const FIXTURE_COINS = {
  /** WHY DOGE: HYPE-priced (the coin is token0), dozens of trades by several wallets. */
  whydoge: getAddress("0x4ddd716f0627693d12f237e0c42692fe23da0999"),
  /** SIA: HYPE-priced, the coin is token1 (its address is above WHYPE's), bought and sold. */
  sia: getAddress("0x9d4a3Be30D060542DfB3525d25e5583EFE4A0999"),
  /** USDC-priced: the creator bought 89% of the supply in the launch transaction, past the 2% cap. */
  big: getAddress("0x420bf11ef5e5de04001cfe0a55243587d0690999"),
  /** "Header Check": PerpMe's first launch, by its own deployer, with no creator buy. */
  first: getAddress("0x0b56c35d8ca0d323f1f871a7e6ea1b607c1f0e4c"),
} as const;

mkdirSync(DIR, { recursive: true });
const cfg = loadConfig(process.env);
const store = new Store(process.env.DB_PATH || "data/perpme-dev.db");
const rpc = new BatchRpc();
const got = await collectPerpme({ client: makeClient(cfg.elysiumRpc), rpc, store, log });
const head = got.head;
type RpcLog = { address: Hex; topics: Hex[]; data: Hex; logIndex: Hex; blockNumber: Hex; transactionHash: Hex; blockTimestamp?: Hex };
const plain = (l: { address: string; topics: Hex[]; data: Hex; logIndex: number | Hex; block?: bigint; blockNumber?: Hex; tx?: Hex; transactionHash?: Hex }) => ({
  address: lc(l.address),
  topics: l.topics,
  data: l.data,
  logIndex: Number(l.logIndex),
  blockNumber: Number(l.block ?? BigInt(l.blockNumber!)),
  tx: (l.tx ?? l.transactionHash)!,
});
const headerOf = async (blocks: bigint[]) => {
  const ans = await rpc.many<{ l1BlockNumber: Hex; timestamp: Hex }>(blocks.map((b) => ({ method: "eth_getBlockByNumber", params: [toHex(b), false] })));
  return Object.fromEntries(blocks.map((b, i) => [b.toString(), { parent: Number(BigInt(ans[i]!.result!.l1BlockNumber)), time: Number(BigInt(ans[i]!.result!.timestamp)) }]));
};
const factoryLogs = store.logs(`perpme:launch:${lc(PERPME.launchFactory)}`);
const poolLogs = store.logs(`perpme:pools:${lc(PERPME.poolFactory)}`);
const launchOf = (t: string) => got.launches.find((l) => lc(l.token) === lc(t))!;

if (wanted("launches")) {
  const xs = got.launches.filter((l) => l.xstock);
  const kalosPaired = got.launches.find((l) => lc(l.pairToken) === lc("0x8a2201953AF29e8BE7700bcB53dA3ce5caD18726"))!;
  const twoPct = got.launches.find((l) => !l.xstock && l.dexId === 1n)!;
  const picks = [...Object.values(FIXTURE_COINS), kalosPaired.token, twoPct.token, ...[0, 1, 100, 700, xs.length - 1].map((i) => xs[i]!.token)];
  const txs = new Set(picks.map((t) => lc(launchOf(t).tx)));
  const blocks = [...new Set(picks.map((t) => launchOf(t).block))];
  // Two launch transactions' receipts in full: the creator's buy is read from them.
  const receipts: Record<string, { from: Address; logs: ReturnType<typeof plain>[] }> = {};
  for (const t of [FIXTURE_COINS.whydoge, FIXTURE_COINS.big]) {
    const l = launchOf(t);
    const [tx, receipt] = await Promise.all([rpc.call<{ from: Address }>("eth_getTransactionByHash", [l.tx]), rpc.call<{ logs: RpcLog[] }>("eth_getTransactionReceipt", [l.tx])]);
    receipts[lc(l.tx)] = { from: getAddress(tx.from), logs: receipt.logs.map(plain) };
  }
  save("launches", {
    note: "TokenDeployed/TokenLaunched logs of real PerpMe launches (memes and xStocks), their PoolCreated logs, launch block headers, and two launch receipts",
    factory: PERPME.launchFactory,
    logs: factoryLogs.filter((l) => txs.has(lc(l.tx))).map(plain),
    poolCreated: poolLogs.filter((l) => txs.has(lc(l.tx))).map(plain),
    headers: await headerOf(blocks),
    receipts,
  });
}

if (wanted("names")) {
  save("names", {
    note: `Every launch on PerpMe's current factory up to block ${head}: token and the name its TokenDeployed carries`,
    head: head.toString(),
    launches: got.launches.map((l) => [lc(l.token), l.name]),
  });
}

const ERC = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function ownerOf(uint256) view returns (address)",
  "function restrictionsActive() view returns (bool)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
]);
const call = (to: Address, data: Hex, block: bigint) => ({ method: "eth_call", params: [{ to, data }, toHex(block)] });

if (wanted("coin")) {
  const l = launchOf(FIXTURE_COINS.whydoge);
  const sk = got.skeletons.find((s) => lc(s.coin.token) === lc(l.token))!;
  const chunkLogs = (what: string) => [...new Set(store.db.prepare("SELECT stream FROM cursors WHERE stream LIKE ?").all(`perpme:${what}:%:real:%`).map((r) => (r as { stream: string }).stream))].flatMap((s) => store.logs(s));
  const transfers = chunkLogs("transfer").filter((x) => lc(x.address) === lc(l.token));
  const swaps = chunkLogs("swap").filter((x) => lc(x.address) === lc(l.pool));
  const liq = chunkLogs("liq").filter((x) => lc(x.address) === lc(l.pool));
  const liqTxs = new Set(liq.map((x) => lc(x.tx)));
  const npmAll = store.logs(`perpme:npm:${lc(PERPME.positionManager)}`);
  const ids = new Set(npmAll.filter((x) => x.topics[0] !== TOPIC.transfer && liqTxs.has(lc(x.tx))).map((x) => x.topics[1]));
  const npm = npmAll.filter((x) => ids.has(x.topics[x.topics[0] === TOPIC.transfer ? 3 : 1]) && (x.topics[0] === TOPIC.transfer || liqTxs.has(lc(x.tx))));
  const launchLogs = factoryLogs.filter((x) => lc(x.tx) === lc(l.tx));
  const txs = [...new Set([l.tx, ...swaps.map((s) => s.tx)].map(lc))];
  const txFrom = store.recallMany<Address>("txfrom", txs);
  const blocks = [...new Set([l.block, ...swaps.map((s) => s.block), ...liq.map((x) => x.block)].map(String))];
  const blockTime = store.recallMany<number>("blocktime", blocks);
  const addrs = [...new Set(transfers.flatMap((x) => [`0x${x.topics[1]!.slice(26)}`, `0x${x.topics[2]!.slice(26)}`]))].map((a) => getAddress(a));
  const state = await rpc.many<Hex>([
    call(l.token, encodeFunctionData({ abi: ERC, functionName: "totalSupply" }), head),
    call(l.token, encodeFunctionData({ abi: ERC, functionName: "decimals" }), head),
    call(l.token, encodeFunctionData({ abi: ERC, functionName: "balanceOf", args: [l.pool] }), head),
    call(l.pairToken, encodeFunctionData({ abi: ERC, functionName: "balanceOf", args: [l.pool] }), head),
    call(l.pool, encodeFunctionData({ abi: ERC, functionName: "slot0" }), head),
    call(getAddress(PERPME.positionManager), encodeFunctionData({ abi: ERC, functionName: "ownerOf", args: [l.positionId] }), head),
    ...addrs.map((a) => call(l.token, encodeFunctionData({ abi: ERC, functionName: "balanceOf", args: [a] }), head)),
  ]);
  const api = new PerpmeApi();
  const [apiHolders, apiTrades, apiToken] = await Promise.all([api.holders(l.token), api.tradeCount(l.token), api.token(l.token)]);
  save("coin", {
    note: "WHY DOGE (0x4ddd…0999), a HYPE-priced PerpMe coin: its whole history from the dev cache, its state at the head, and PerpMe's own holders and trade counts",
    token: l.token,
    head: head.toString(),
    parentHead: got.parentHead?.toString() ?? null,
    launch: launchLogs.map(plain),
    transfers: transfers.map(plain),
    swaps: swaps.map(plain),
    liquidity: liq.map(plain),
    npm: npm.map(plain),
    txFrom: Object.fromEntries(txFrom),
    blockTime: Object.fromEntries(blockTime),
    state: {
      totalSupply: state[0]!.result,
      decimals: state[1]!.result,
      coinInPool: state[2]!.result,
      quoteInPool: state[3]!.result,
      slot0: state[4]!.result,
      positionOwner: state[5]!.result,
      balances: Object.fromEntries(addrs.map((a, i) => [lc(a), BigInt(state[6 + i]!.result!).toString()])),
    },
    perpme: { holders: apiHolders.map((h) => [lc(h.address), h.balance.toString()]), tradeCount: apiTrades, dexSyncTradeCount: apiToken?.tradeCount ?? null },
    delphi: { trades: sk.trades.length, transfers: sk.transfers.length },
  });
}

if (wanted("sign")) {
  // A buy and a sell of WHY DOGE (token0) and of SIA (token1), from their receipts.
  const out: Record<string, { from: Address; blockNumber: number; timestamp: number; pool: Address; token: Address; logs: ReturnType<typeof plain>[] }> = {};
  for (const t of [FIXTURE_COINS.whydoge, FIXTURE_COINS.sia]) {
    const sk = got.skeletons.find((s) => lc(s.coin.token) === lc(t))!;
    const picks = [sk.trades.find((x) => x.side === "buy" && lc(x.tx) !== lc(sk.coin.launchTx))!, sk.trades.find((x) => x.side === "sell")!];
    for (const p of picks) {
      const [tx, receipt] = await Promise.all([rpc.call<{ from: Address }>("eth_getTransactionByHash", [p.tx]), rpc.call<{ logs: RpcLog[]; blockNumber: Hex }>("eth_getTransactionReceipt", [p.tx])]);
      const [blk] = await rpc.many<{ timestamp: Hex }>([{ method: "eth_getBlockByNumber", params: [receipt.blockNumber, false] }]);
      out[lc(p.tx)] = { from: getAddress(tx.from), blockNumber: Number(BigInt(receipt.blockNumber)), timestamp: Number(BigInt(blk!.result!.timestamp)), pool: getAddress(sk.coin.poolId), token: t, logs: receipt.logs.map(plain) };
    }
  }
  save("sign", { note: "Receipts of a buy and a sell of WHY DOGE (the coin is token0) and of SIA (token1), PerpMe pools, Elysium testnet", txs: out });
}

if (wanted("restriction")) {
  // The last Elysium block whose parent block is below the window's end, and the next one.
  const l = launchOf(FIXTURE_COINS.whydoge);
  const parentOf = async (b: bigint) => BigInt((await rpc.call<{ l1BlockNumber: Hex }>("eth_getBlockByNumber", [toHex(b), false])).l1BlockNumber);
  let lo = l.block;
  let hi = l.block + 20_000n;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if ((await parentOf(mid)) < l.restrictionEndBlock) lo = mid;
    else hi = mid;
  }
  const active = encodeFunctionData({ abi: ERC, functionName: "restrictionsActive" });
  const ans = await rpc.many<Hex>([call(l.token, active, lo), call(l.token, active, hi), call(l.token, active, l.block)]);
  save("restriction", {
    note: "WHY DOGE's launch protection: restrictionsActive() at its launch block, at the last block before its window ends and the first after",
    token: l.token,
    restrictionEndBlock: l.restrictionEndBlock.toString(),
    launch: { block: l.block.toString(), parent: (await parentOf(l.block)).toString(), active: ans[2]!.result },
    before: { block: lo.toString(), parent: (await parentOf(lo)).toString(), active: ans[0]!.result },
    after: { block: hi.toString(), parent: (await parentOf(hi)).toString(), active: ans[1]!.result },
  });
}

async function recordSafety(name: string, token: Address, holder: Address, block: bigint, note: string) {
  if (!wanted(name)) return;
  const tape: Tape = { ...emptyTape(note), block: block.toString() };
  const fetch = recordingFetch(globalThis.fetch, tape);
  const brpc = new BatchRpc(undefined, { fetch });
  const r = await checkSafety({ rpc: brpc, fetch, contracts: new ContractsApi({ fetch }), explorer: new ExplorerApi({ fetch }), kalosApi: new KalosApi({ fetch }) }, token, { holder, block, now: new Date("2026-11-01T12:00:00Z") });
  // A launch block's full trace is big: keep only the calls down to the coin's creation (all DELPHI reads).
  type Frame = { from: string; to?: string; type?: string; calls?: Frame[] };
  const pathTo = (f: Frame): Frame | null => {
    const keep = { from: f.from, ...(f.to ? { to: f.to } : {}), ...(f.type ? { type: f.type } : {}) };
    if ((f.type === "CREATE" || f.type === "CREATE2") && lc(f.to ?? "") === lc(token)) return keep;
    for (const c of f.calls ?? []) {
      const sub = pathTo(c);
      if (sub) return { ...keep, calls: [sub] };
    }
    return null;
  };
  for (const e of tape.rpc) {
    if (e.method !== "debug_traceBlockByNumber" || !Array.isArray(e.result)) continue;
    e.result = (e.result as Array<{ txHash: string; result: Frame }>).flatMap((t) => {
      const p = pathTo(t.result);
      return p ? [{ txHash: t.txHash, result: p }] : [];
    });
  }
  writeFileSync(join(DIR, `${name}.json`), `${JSON.stringify(tape)}\n`);
  log(`${name}: ${r.symbol} at block ${block}: sell ${r.checks.sell.state}: ${r.checks.sell.summary}; ${tape.rpc.length} RPC and ${tape.http.length} HTTP answers`);
}

{
  const l = launchOf(FIXTURE_COINS.whydoge);
  const sk = got.skeletons.find((s) => lc(s.coin.token) === lc(l.token))!;
  // The biggest wallet now (not the pool), from the replayed balances.
  const bal = new Map<string, bigint>();
  for (const t of sk.transfers) {
    bal.set(lc(t.from), (bal.get(lc(t.from)) ?? 0n) - t.value);
    bal.set(lc(t.to), (bal.get(lc(t.to)) ?? 0n) + t.value);
  }
  const top = [...bal].filter(([a, v]) => v > 0n && !got.system.has(a)).sort((a, b) => (b[1] > a[1] ? 1 : -1))[0]![0];
  await recordSafety("sell-normal", l.token, getAddress(top), head, "checkSafety on WHY DOGE (a HYPE-priced PerpMe coin) at the head, long after its launch window");
  await recordSafety("sell-restricted", l.token, l.deployer, l.block + 200n, "checkSafety on WHY DOGE 200 blocks after its launch, inside its launch window (its creator as the holder)");
}
store.close();
log(`done: ${rpc.requests} requests`);
