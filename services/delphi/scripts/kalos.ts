// Reads every coin on Kalos (Elysium's biggest DEX, a Uniswap V3 fork) into DELPHI's shape and prints a
// compact table per token, with the three checks run on their own (no wallet links yet: funding and
// linking join when this is merged into the main scan). Read-only. Live, so run it by hand:
//   node scripts/kalos.ts                    every Kalos coin
//   node scripts/kalos.ts --only 0x…         one token (or its symbol); the read still covers every pool
//   node scripts/kalos.ts --recent 785000    the recent window for busy tokens, in blocks (default ≈ 24 h)
//   node scripts/kalos.ts --check 3          also re-read 3 random trades from their receipts
//   node scripts/kalos.ts --json out/kalos.json
// Cache: DB_PATH (default data/kalos-dev.db). It refuses data/delphi.db, the main scan's cache.
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { decodeEventLog, formatUnits, getAddress, isAddress, type Hex } from "viem";
import { makeClient, TRANSFER } from "../src/chain.ts";
import { loadConfig, supplyOf } from "../src/config.ts";
import { balances, pct } from "../src/detect.ts";
import { collectKalos } from "../src/kalos-collect.ts";
import { decodeV3Swap, sideOf, type LiquidityReport } from "../src/kalos.ts";
import { analyze } from "../src/report.ts";
import { BatchRpc } from "../src/rpc.ts";
import { Store } from "../src/store.ts";
import type { CoinData } from "../src/types.ts";

const args = process.argv.slice(2);
const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const only = opt("--only");
const recentArg = opt("--recent");
const checks = Number(opt("--check") ?? 0);
const jsonOut = opt("--json");
if (recentArg !== undefined && !/^\d+$/.test(recentArg)) {
  console.error("--recent needs a number of blocks");
  process.exit(2);
}

const dbPath = process.env.DB_PATH || "data/kalos-dev.db";
if (basename(resolve(dbPath)) === "delphi.db" && basename(dirname(resolve(dbPath))) === "data") {
  console.error("refusing to use data/delphi.db (the main scan's cache): set DB_PATH to another file");
  process.exit(2);
}

const cfg = loadConfig({ ...process.env, DB_PATH: dbPath });
const store = new Store(dbPath);
const rpc = new BatchRpc();
const t0 = Date.now();
const log = (m: string) => console.error(`[kalos ${Math.round((Date.now() - t0) / 1000)}s] ${m}`);
const WEB = "https://test-explorer.elysium.kinetiq.xyz";
const lc = (a: string) => a.toLowerCase();
const n = (x: number) => x.toLocaleString("en-US");
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const hype = (wei: bigint | null) => (wei === null ? "-" : `${Number(formatUnits(wei, 18)).toLocaleString("en-US", { maximumFractionDigits: 1 })}`);

/** What an address holds: read from the token for a busy coin, else replayed (system addresses included). */
function heldBy(d: CoinData, a: string): bigint {
  if (d.holdings) return d.holdings.get(lc(a)) ?? 0n;
  let v = 0n;
  for (const t of d.transfers) {
    if (lc(t.to) === lc(a)) v += t.value;
    if (lc(t.from) === lc(a)) v -= t.value;
  }
  return v;
}

function row(d: CoinData, liq: LiquidityReport | undefined) {
  const r = analyze({ ...d, links: [], fundingMissing: 0 }, { explorerWeb: WEB });
  const supply = supplyOf(d.coin);
  const bal = [...balances(d).values()].sort((a, b) => (b > a ? 1 : b < a ? -1 : 0));
  const top5 = bal.slice(0, 5).reduce((s, v) => s + v, 0n);
  const pools = liq?.pools ?? [];
  const tvl = pools.reduce((s, p) => (p.tvlHype === null ? s : s + p.tvlHype), 0n);
  const removals = pools.flatMap((p) => p.bigRemovals);
  const state = (k: "bundle" | "wash" | "concentration") => {
    const f = r.findings.find((x) => x.detector === k);
    if (f) return `${f.severity} (${Object.values(f.metrics)[0]})`;
    return r.checks[k] === "clear" ? "clear" : "n/e/d";
  };
  return {
    sym: d.coin.symbol ?? short(d.coin.token),
    token: d.coin.token,
    read: d.coin.windowFrom !== undefined ? "windows" : "full",
    trades: d.trades.length,
    traders: r.stats.traders,
    holders: r.stats.holders,
    creator: pct(heldBy(d, d.coin.creator), supply),
    top5: pct(top5, supply),
    tvl: pools.some((p) => p.tvlHype !== null) ? hype(tvl) : "-",
    pools: pools.length,
    lpOwners: liq?.lpOwners ?? 0,
    removals: removals.length,
    bundle: state("bundle"),
    wash: state("wash"),
    concentration: state("concentration"),
    report: r,
  };
}

/**
 * Re-reads a random trade from the node: who sent the transaction, and the coin's own Transfer in or out
 * of the pool, against the side and amount DELPHI read from the Swap event with the sign rule.
 */
async function check(d: CoinData, liq: LiquidityReport | undefined) {
  const t = d.trades[Math.floor(Math.random() * d.trades.length)]!;
  const is0 = liq?.pools.find((p) => lc(p.pool) === lc(t.pool))?.tokenIs0;
  const [tx, receipt] = await Promise.all([
    rpc.call<{ from: string }>("eth_getTransactionByHash", [t.tx]),
    rpc.call<{ logs: Array<{ address: string; topics: Hex[]; data: Hex; logIndex: Hex; blockNumber: Hex; transactionHash: Hex }> }>("eth_getTransactionReceipt", [t.tx]),
  ]);
  const l = receipt.logs.find((x) => Number(x.logIndex) === t.logIndex)!;
  const s = decodeV3Swap({ block: BigInt(l.blockNumber), logIndex: Number(l.logIndex), tx: l.transactionHash, address: l.address as Hex, topics: l.topics, data: l.data });
  const [tokenDelta, quoteDelta] = is0 ? [s.amount0, s.amount1] : [s.amount1, s.amount0];
  const moves = receipt.logs
    .filter((x) => lc(x.address) === lc(d.coin.token) && x.topics.length === 3)
    .map((x) => decodeEventLog({ abi: [TRANSFER], topics: x.topics as [Hex, ...Hex[]], data: x.data }).args);
  const out = moves.find((a) => lc(a.from) === lc(t.pool));
  const into = moves.find((a) => lc(a.to) === lc(t.pool));
  const onChain = out && !into ? { side: "buy", tokens: out.value } : into && !out ? { side: "sell", tokens: into.value } : { side: "?", tokens: null };
  const ok = getAddress(tx.from) === t.trader && onChain.side === t.side && sideOf(tokenDelta, quoteDelta) === t.side && onChain.tokens === t.tokens;
  console.log(
    `  ${ok ? "OK  " : "DIFF"} ${d.coin.symbol} ${t.tx}\n       DELPHI: ${t.side} ${t.tokens} by ${t.trader} (pool ${short(t.pool)}, swap amount ${tokenDelta})\n` +
      `       node:   ${onChain.side} ${onChain.tokens} by ${getAddress(tx.from)} (the pool's own Transfer of ${d.coin.symbol})`,
  );
}

try {
  const got = await collectKalos({
    client: makeClient(cfg.elysiumRpc, (ms, what) => log(`public RPC asked us to slow down (${what}): waiting ${ms / 1000} s`)),
    rpc,
    store,
    log,
    ...(recentArg ? { recentBlocks: BigInt(recentArg) } : {}),
  });
  const pick = (d: { coin: CoinData["coin"] }) => !only || (isAddress(only, { strict: false }) ? lc(d.coin.token) === lc(only) : lc(d.coin.symbol ?? "") === lc(only));
  const coins = got.skeletons.filter(pick).map((s): CoinData => ({ ...s, links: [], fundingMissing: 0 }));
  if (only && !coins.length) throw new Error(`${only} is not a Kalos coin`);
  const rows = coins.map((d) => row(d, got.liquidity.get(lc(d.coin.token)))).sort((a, b) => b.trades - a.trades);

  const head = ["coin", "read", "trades", "traders", "holders", "creator %", "top 5 %", "TVL HYPE", "pools", "LP owners", "removals ≥20%", "bundle", "wash", "concentration"];
  const cells = rows.map((r) => [r.sym, r.read, n(r.trades), n(r.traders), n(r.holders), String(r.creator), String(r.top5), r.tvl, String(r.pools), n(r.lpOwners), String(r.removals), r.bundle, r.wash, r.concentration]);
  const width = head.map((h, i) => Math.max(h.length, ...cells.map((c) => [...c[i]!].length)));
  const line = (c: string[]) => c.map((x, i) => x.padEnd(width[i]!)).join("  ");
  console.log(`\nKalos coins at block ${got.head} (checks run unlinked: no funding links yet)\n`);
  console.log(line(head));
  console.log(width.map((w) => "-".repeat(w)).join("  "));
  for (const c of cells) console.log(line(c));
  console.log(
    "\ncreator % and top 5 %: of the total supply (top 5 wallets, contracts and pools left out). TVL: pools priced in WHYPE." +
      "\nLP owners: different owners of open positions. removals ≥20%: liquidity taken out in one go. n/e/d: not enough data.",
  );

  for (const d of coins) {
    const liq = got.liquidity.get(lc(d.coin.token));
    console.log(`\n${d.coin.symbol} ${d.coin.token}  creator ${d.coin.creator}${lc(d.coin.launcher) !== lc(d.coin.creator) ? `, first liquidity by ${d.coin.launcher}` : ""}`);
    console.log(`  launch ${new Date(d.coin.launchTime * 1000).toISOString()} block ${d.coin.launchBlock} tx ${d.coin.launchTx}; main pool ${d.coin.poolId}`);
    for (const p of liq?.pools ?? []) {
      const lp = p.topOwners[0];
      console.log(
        `  pool ${p.pool} ${p.quoteSymbol ?? short(p.quote)} fee ${p.fee / 10_000}%: ${p.tvlHype !== null ? `TVL ${hype(p.tvlHype)} HYPE, ` : ""}` +
          `${p.openPositions} open positions by ${p.owners} owners` +
          (lp ? `, biggest owner ${short(lp.owner)} ${lp.sharePct}% by ${p.shareBy}${lp.roles.length ? ` (${lp.roles.join(", ")})` : ""}${lp.ownerKind !== "wallet" ? ` [${lp.ownerKind}]` : ""}` : "") +
          `; ${p.adds} adds, ${p.removes} removals` +
          (p.bigRemovals.length ? `; big removals: ${p.bigRemovals.map((x) => `${x.sharePct}% by ${short(x.owner)} in ${x.tx}`).join("; ")}` : ""),
      );
    }
    for (const note of liq?.notes ?? []) console.log(`  note: ${note}`);
  }
  if (got.ascendExtras.size) {
    console.log(`\nAscend coins trading on Kalos (to join their Ascend reports as outside trades):`);
    for (const [t, trades] of got.ascendExtras) console.log(`  ${t}: ${trades.length} trades`);
  } else console.log(`\nNo Ascend coin trades on Kalos.`);
  for (const note of got.notes.filter((x) => !coins.some((d) => x.startsWith(`${d.coin.symbol}: `)))) console.log(`note: ${note}`);

  if (checks > 0) {
    console.log(`\nSpot checks against the node's receipts:`);
    const busy = coins.filter((d) => d.trades.length);
    for (let i = 0; i < checks && busy.length; i++) {
      const d = busy[i % busy.length]!;
      await check(d, got.liquidity.get(lc(d.coin.token)));
    }
  }
  if (jsonOut) {
    mkdirSync(dirname(jsonOut), { recursive: true });
    const replacer = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v instanceof Map ? Object.fromEntries(v) : v instanceof Set ? [...v] : v);
    const body = { head: got.head, notes: got.notes, coins: rows.map(({ report, ...r }) => ({ ...r, verdict: report.verdict, findings: report.findings })), liquidity: [...got.liquidity.values()] };
    writeFileSync(jsonOut, `${JSON.stringify(body, replacer, 2)}\n`);
  }
  log(`done in ${Math.round((Date.now() - t0) / 1000)} s, ${rpc.requests} requests to the explorer's node, cache ${dbPath}`);
} finally {
  store.close();
}
