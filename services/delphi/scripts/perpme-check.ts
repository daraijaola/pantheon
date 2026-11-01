// Checks DELPHI's PerpMe numbers for random coins against two other sources: the token itself (balanceOf
// and totalSupply at the same block, the truth) and PerpMe's own data (dex-sync's trade counts, and its
// indexer's holders and trades). Read-only. Live, so run it by hand, after scripts/perpme.ts:
//   node scripts/perpme-check.ts                     20 random coins that traded at least once after launch
//   node scripts/perpme-check.ts --n 30 --seed 7     another sample (the same seed picks the same coins)
//   node scripts/perpme-check.ts --all-coins         sample from every coin, quiet ones too
//   node scripts/perpme-check.ts --include 0x…       add a coin (repeatable)
// Cache: DB_PATH (default data/perpme-dev.db). It refuses data/delphi.db, the main scan's cache.
import { basename, dirname, resolve } from "node:path";
import { encodeFunctionData, getAddress, parseAbi, type Address } from "viem";
import { makeClient } from "../src/chain.ts";
import { loadConfig, supplyOf } from "../src/config.ts";
import { balances, pct } from "../src/detect.ts";
import { PerpmeApi } from "../src/perpme-api.ts";
import { collectPerpme } from "../src/perpme-collect.ts";
import { viewsAt } from "../src/reads.ts";
import { BatchRpc } from "../src/rpc.ts";
import { Store } from "../src/store.ts";
import type { CoinData } from "../src/types.ts";

const args = process.argv.slice(2);
const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const count = Number(opt("--n") ?? 20);
const seed = Number(opt("--seed") ?? 42);
const include = args.flatMap((a, i) => (args[i - 1] === "--include" ? [a.toLowerCase()] : []));
const dbPath = process.env.DB_PATH || "data/perpme-dev.db";
if (basename(resolve(dbPath)) === "delphi.db" && basename(dirname(resolve(dbPath))) === "data") {
  console.error("refusing to use data/delphi.db (the main scan's cache): set DB_PATH to another file");
  process.exit(2);
}

const cfg = loadConfig({ ...process.env, DB_PATH: dbPath });
const store = new Store(dbPath);
const rpc = new BatchRpc();
const api = new PerpmeApi();
const t0 = Date.now();
const log = (m: string) => console.error(`[perpme-check ${Math.round((Date.now() - t0) / 1000)}s] ${m}`);
const lc = (a: string) => a.toLowerCase();
const ERC = parseAbi(["function balanceOf(address) view returns (uint256)", "function totalSupply() view returns (uint256)"]);
const word = (r: `0x${string}` | null | undefined) => (r && r.length >= 66 ? BigInt(r.slice(0, 66)) : 0n);

/** A small seeded random generator (mulberry32), so a sample can be drawn again. */
function random(s: number) {
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Row = {
  sym: string;
  token: Address;
  trades: [ours: number, dexSync: number | null, indexer: number | null];
  /** DELPHI's trades up to the block PerpMe's indexer has read (its API lags the chain). */
  tradesAtIndexer: number;
  tradesAtBefore: number;
  dexAtIndexer: boolean | null;
  idxAtIndexer: boolean | null;
  holders: [ours: number, perpme: number | null, chain: number];
  holderSetsAgree: boolean;
  balancesAgree: boolean;
  perpmeAgrees: boolean | null;
  /** PerpMe's holders against balanceOf at the indexer's own block. */
  perpmeAgreesAtIndexer: boolean | null;
  creator: [ours: number, chain: number];
  why: string[];
};

try {
  const got = await collectPerpme({ client: makeClient(cfg.elysiumRpc), rpc, store, log });
  const head = got.head;
  const startIndexed = await api.indexedBlock().catch(() => null);
  log(`PerpMe's indexer is at block ${startIndexed ?? "?"}; DELPHI read up to ${head}`);
  const coins = got.skeletons.map((s): CoinData => ({ ...s, links: [], fundingMissing: 0 }));
  const pool = coins.filter((d) => args.includes("--all-coins") || d.trades.length >= 2);
  const rand = random(seed);
  const sample = [...pool].map((d) => [rand(), d] as const).sort((a, b) => a[0] - b[0]).slice(0, count).map(([, d]) => d);
  for (const t of include) {
    const d = coins.find((c) => lc(c.coin.token) === t);
    if (d && !sample.includes(d)) sample.push(d);
  }
  log(`checking ${sample.length} of ${pool.length} coins (seed ${seed})`);

  const rows: Row[] = [];
  for (const d of sample) {
    const token = d.coin.token;
    const ours = balances(d);
    // PerpMe's indexer keeps reading while we ask: its block before and after bounds what its answers saw.
    const before = await api.indexedBlock().catch(() => null);
    const [dex, indexerTrades, theirHolders] = await Promise.all([api.token(token).catch(() => null), api.tradeCount(token).catch(() => null), api.holders(token).catch(() => null)]);
    const after = await api.indexedBlock().catch(() => null);
    const indexed = after;
    const theirs = new Map((theirHolders ?? []).filter((h) => h.balance > 0n && !d.system.has(lc(h.address))).map((h) => [lc(h.address), h.balance] as const));
    const everyone = [...new Set([...ours.keys(), ...theirs.keys(), lc(d.coin.creator)])];
    const reads = await viewsAt(rpc, [{ to: token, data: encodeFunctionData({ abi: ERC, functionName: "totalSupply" }) }, ...everyone.map((a) => ({ to: token, data: encodeFunctionData({ abi: ERC, functionName: "balanceOf", args: [getAddress(a)] }) }))], head);
    const supply = word(reads[0]);
    const chain = new Map(everyone.map((a, i) => [a, word(reads[i + 1])] as const).filter(([a, v]) => v > 0n && a !== lc(d.coin.creator)) as Array<[string, bigint]>);
    const creatorChain = word(reads[1 + everyone.indexOf(lc(d.coin.creator))]);
    // PerpMe's data is as of its indexer's block: compare it with balanceOf there too.
    const atIdx = indexed !== null && indexed < head ? await viewsAt(rpc, everyone.map((a) => ({ to: token, data: encodeFunctionData({ abi: ERC, functionName: "balanceOf", args: [getAddress(a)] }) })), indexed) : null;
    const chainAtIdx = atIdx ? new Map(everyone.map((a, i) => [a, word(atIdx[i])] as const).filter(([a, v]) => v > 0n && !d.system.has(a))) : chain;
    if (creatorChain > 0n && !d.system.has(lc(d.coin.creator))) chain.set(lc(d.coin.creator), creatorChain);
    const sameSet = (a: Map<string, bigint>, b: Map<string, bigint>) => a.size === b.size && [...a.keys()].every((k) => b.has(k));
    const sameBal = (a: Map<string, bigint>, b: Map<string, bigint>) => sameSet(a, b) && [...a].every(([k, v]) => b.get(k) === v);
    const why: string[] = [];
    const lateTrades = indexed !== null ? d.trades.filter((t) => t.block > indexed).length : 0;
    const tradesAtIndexer = d.trades.length - lateTrades;
    const tradesAtBefore = before !== null ? d.trades.filter((t) => t.block <= before).length : tradesAtIndexer;
    /** PerpMe's count sits between DELPHI's at the indexer's block before the question and after it. */
    const matchesIndexer = (n: number | null) => (n === null ? null : n >= tradesAtBefore && n <= tradesAtIndexer);
    if (dex && dex.tradeCount !== d.trades.length) why.push(`dex-sync counts ${dex.tradeCount} trades, DELPHI ${d.trades.length}: ${lateTrades} of DELPHI's came after the indexer's block, leaving ${tradesAtIndexer}`);
    if (!sameBal(ours, chain)) {
      const diff = [...new Set([...ours.keys(), ...chain.keys()])].filter((a) => ours.get(a) !== chain.get(a));
      why.push(`DELPHI and balanceOf differ for ${diff.length} address(es): ${diff.slice(0, 3).join(", ")}`);
    }
    if (theirHolders && !sameBal(theirs, chain)) {
      const diff = [...new Set([...theirs.keys(), ...chain.keys()])].filter((a) => theirs.get(a) !== chain.get(a));
      const atIdxDiff = [...new Set([...theirs.keys(), ...chainAtIdx.keys()])].filter((a) => theirs.get(a) !== chainAtIdx.get(a));
      why.push(`PerpMe's holders and balanceOf at the head differ for ${diff.length} address(es)${atIdx ? `, at the indexer's block for ${atIdxDiff.length}` : ""}`);
    }
    const creatorOurs = pct([...d.transfers].reduce((s, t) => s + (lc(t.to) === lc(d.coin.creator) ? t.value : 0n) - (lc(t.from) === lc(d.coin.creator) ? t.value : 0n), 0n), supplyOf(d.coin));
    const creatorOnChain = pct(creatorChain, supply);
    if (creatorOurs !== creatorOnChain) why.push(`creator share ${creatorOurs}% by DELPHI, ${creatorOnChain}% by balanceOf`);
    rows.push({
      sym: (d.coin.symbol ?? "?").replace(/[\p{C}]/gu, "").slice(0, 12),
      token,
      trades: [d.trades.length, dex?.tradeCount ?? null, indexerTrades],
      tradesAtIndexer,
      tradesAtBefore,
      dexAtIndexer: matchesIndexer(dex?.tradeCount ?? null),
      idxAtIndexer: matchesIndexer(indexerTrades),
      holders: [ours.size, theirHolders ? theirs.size : null, chain.size],
      holderSetsAgree: sameSet(ours, chain),
      balancesAgree: sameBal(ours, chain),
      perpmeAgrees: theirHolders ? sameBal(theirs, chain) : null,
      perpmeAgreesAtIndexer: theirHolders ? sameBal(theirs, chainAtIdx) : null,
      creator: [creatorOurs, creatorOnChain],
      why,
    });
    log(`  ${rows.at(-1)!.sym}: ${why.length ? why.join("; ") : "all agree"}`);
  }

  const head2 = ["coin", "token", "trades D/dex/idx", "D at idx block", "holders D/PerpMe/chain", "balances D=chain", "PerpMe=chain (head / idx block)", "creator % D/chain", "notes"];
  const cells = rows.map((r) => [
    r.sym,
    r.token,
    r.trades.map((x) => x ?? "?").join(" / "),
    r.tradesAtBefore === r.tradesAtIndexer ? String(r.tradesAtIndexer) : `${r.tradesAtBefore}-${r.tradesAtIndexer}`,
    r.holders.map((x) => x ?? "?").join(" / "),
    r.balancesAgree ? "yes" : "NO",
    r.perpmeAgrees === null ? "?" : `${r.perpmeAgrees ? "yes" : "NO"} / ${r.perpmeAgreesAtIndexer ? "yes" : "NO"}`,
    `${r.creator[0]} / ${r.creator[1]}`,
    r.why.join("; ") || "-",
  ]);
  const width = head2.map((h, i) => Math.max(h.length, ...cells.map((c) => [...c[i]!].length)));
  const line = (c: string[]) => `| ${c.map((x, i) => x.padEnd(width[i]!)).join(" | ")} |`;
  console.log(`\nPerpMe cross-check at block ${head} (PerpMe's indexer at ${startIndexed ?? "?"} when it started), ${rows.length} coins, seed ${seed}\n`);
  console.log(line(head2));
  console.log(`|${width.map((w) => "-".repeat(w + 2)).join("|")}|`);
  for (const c of cells) console.log(line(c));
  const rate = (k: (r: Row) => boolean | null) => {
    const asked = rows.filter((r) => k(r) !== null);
    return `${asked.filter((r) => k(r)).length}/${asked.length}`;
  };
  console.log(
    `\nAgreement: DELPHI's holders and balances = balanceOf ${rate((r) => r.balancesAgree)}; creator share = balanceOf ${rate((r) => r.creator[0] === r.creator[1])}; ` +
      `trades = dex-sync ${rate((r) => (r.trades[1] === null ? null : r.trades[0] === r.trades[1]))} at the head, ${rate((r) => r.dexAtIndexer)} at the indexer's block; ` +
      `trades = PerpMe's indexer ${rate((r) => r.idxAtIndexer)} at its block; ` +
      `PerpMe's holders = balanceOf ${rate((r) => r.perpmeAgrees)} at the head, ${rate((r) => r.perpmeAgreesAtIndexer)} at the indexer's block.` +
      "\nHolders leave out pools, PerpMe's contracts and other contracts (the launch factory keeps a few wei of every coin), on both sides.",
  );
  log(`done in ${Math.round((Date.now() - t0) / 1000)} s`);
} finally {
  store.close();
}
