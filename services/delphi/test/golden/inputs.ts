import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { getAddress, toEventSelector, type Address, type Hex } from "viem";
import { LAUNCHED, SWAP, TRANSFER } from "../../src/chain.ts";
import { STATIC_SYSTEM } from "../../src/config.ts";
import { actorsOf, buildLinks } from "../../src/graph.ts";
import { assemble, decodeLaunch, decodeSwap, decodeTransfer } from "../../src/ingest.ts";
import { assembleKalos, BURN, decodeLiq, decodePoolCreated, decodeV3Swap, KALOS, V3_SWAP } from "../../src/kalos.ts";
import { assemblePerpme, launchesOf, PERPME_CONTRACTS } from "../../src/perpme.ts";
import type { RawLog } from "../../src/store.ts";
import type { CoinData, Verdict } from "../../src/types.ts";

export const NOW = new Date("2026-11-04T00:23:23.405Z");
export type GoldenInput = { id: string; source: string; head: string; historicalVerdict?: Verdict; data: CoinData };
type Log = { address: Hex; topics: Hex[]; data: Hex; logIndex: number; blockNumber: number; tx: Hex };
const lc = (s: string) => s.toLowerCase();
const load = <T>(path: string): T => JSON.parse(readFileSync(new URL(`../fixtures/${path}`, import.meta.url), "utf8")) as T;
const raw = (l: Log): RawLog => ({ ...l, block: BigInt(l.blockNumber) });
const senders = (o: Record<string, Address>) => new Map(Object.entries(o).map(([k, v]) => [lc(k), getAddress(v)]));

function finish(s: Omit<CoinData, "links" | "fundingMissing">): CoinData {
  const actors = actorsOf(s.trades, s.transfers, s.system);
  return {
    ...s, network: "testnet", fundingMissing: actors.size,
    links: buildLinks({ actors, creator: s.coin.creator, launcher: s.coin.market ? s.coin.creator : s.coin.launcher,
      launchTx: s.coin.launchTx, trades: s.trades, transfers: s.transfers, fundings: [], hubs: new Set(), system: s.system }),
  };
}

function ascend(): GoldenInput {
  const fx = load<{ txs: Record<Hex, { from: Address; blockNumber: number; timestamp: number; logs: Log[] }> }>("live-trades.json");
  const logs = Object.entries(fx.txs).flatMap(([tx, t]) => t.logs.map(l => raw({ ...l, tx: tx as Hex, blockNumber: t.blockNumber })));
  const topic = (event: typeof TRANSFER | typeof SWAP | typeof LAUNCHED) => logs.filter(l => l.topics[0] === toEventSelector(event));
  const swaps = topic(SWAP).map(decodeSwap);
  const system = new Set([...STATIC_SYSTEM, "0xE2f6254508DEB93Da081837F545e0bAF7b00d8E9", "0x2B738A9A69b7a45C9dA6B519f6bE6efBfb912aec", ...swaps.map(s => s.sender)].map(lc));
  const [s] = assemble({ launches: topic(LAUNCHED).map(decodeLaunch), pools: [], swaps,
    transfers: topic(TRANSFER).map(decodeTransfer), system, meta: new Map(),
    txFrom: new Map(Object.entries(fx.txs).map(([tx, t]) => [lc(tx), getAddress(t.from)])),
    blockTime: new Map(Object.values(fx.txs).map(t => [String(t.blockNumber), t.timestamp])) });
  return { id: "raw:ascend-live", source: "live-trades.json (two transactions, partial history; funding absent)", head: String(Math.max(...logs.map(l => Number(l.block)))), data: finish(s!) };
}

function kalos(name: string): GoldenInput {
  const fx = load<{ token: Address; creation: { deployer: Address }; poolCreated: Log[]; liquidity: Log[]; swaps: Log[];
    transfers: Log[]; txFrom: Record<string, Address>; blockTime: Record<string, number> }>(`kalos/${name}.json`);
  const pools = fx.poolCreated.map(l => decodePoolCreated(raw(l)));
  const swaps = fx.swaps.map(l => decodeV3Swap(raw(l)));
  const transfers = fx.transfers.map(l => decodeTransfer(raw(l)));
  const zero = "0x" + "0".repeat(40);
  const supply = transfers.reduce((v, t) => v + (lc(t.from) === zero ? t.value : 0n) - (lc(t.to) === zero ? t.value : 0n), 0n);
  const system = new Set([...STATIC_SYSTEM, ...KALOS.contracts, ...BURN, ...pools.map(p => p.pool), ...swaps.map(s => s.sender)].map(lc));
  const [s] = assembleKalos({ tokens: [{ token: fx.token, deployer: fx.creation.deployer, name, symbol: name.toUpperCase(), supply }],
    pools, swaps, transfers, liquidity: fx.liquidity.map(l => decodeLiq(raw(l))), system,
    txFrom: senders(fx.txFrom), blockTime: new Map(Object.entries(fx.blockTime)) });
  return { id: `raw:kalos-${name}`, source: `kalos/${name}.json (funding absent)`, head: String(Math.max(...fx.swaps.map(l => l.blockNumber))), data: finish(s!) };
}

function kalosSign(): GoldenInput {
  const fx = load<{ txs: Record<Hex, { from: Address; blockNumber: number; timestamp: number; logs: Log[] }>;
    poolCreated: Log[]; firstMint: Log & { from: Address; timestamp: number } }>("kalos/sign.json");
  const logs = Object.entries(fx.txs).flatMap(([tx, t]) => t.logs.map(l => raw({ ...l, tx: tx as Hex, blockNumber: t.blockNumber })));
  const pool = decodePoolCreated(raw(fx.poolCreated[0]!));
  const swaps = logs.filter(l => l.topics[0] === toEventSelector(V3_SWAP)).map(decodeV3Swap);
  const transfers = logs.filter(l => l.topics[0] === toEventSelector(TRANSFER) && l.topics.length === 3).map(decodeTransfer);
  const system = new Set([...STATIC_SYSTEM, ...KALOS.contracts, ...BURN, pool.pool, ...swaps.map(s => s.sender)].map(lc));
  const token = getAddress("0x8a2201953AF29e8BE7700bcB53dA3ce5caD18726");
  const txFrom = new Map([...Object.entries(fx.txs).map(([tx, t]) => [lc(tx), t.from] as const), [lc(fx.firstMint.tx), fx.firstMint.from]]);
  const blockTime = new Map([...Object.values(fx.txs).map(t => [String(t.blockNumber), t.timestamp] as const), [String(fx.firstMint.blockNumber), fx.firstMint.timestamp]]);
  const [s] = assembleKalos({ tokens: [{ token, deployer: fx.firstMint.from, name: "KALOS", symbol: "KALOS", supply: 1_000_000_000n * 10n ** 18n }],
    pools: [pool], swaps, transfers, liquidity: [decodeLiq(raw(fx.firstMint))], system, txFrom, blockTime });
  return { id: "raw:kalos-sign", source: "kalos/sign.json (two trades only; first-mint sender as creator context; 1e27 supply verified in Nov 4 liquidity report; not full KALOS history)",
    head: String(Math.max(...logs.map(l => Number(l.block)))), data: finish(s!) };
}

function perpme(): GoldenInput {
  const fx = load<{ head: string; launch: Log[]; swaps: Log[]; transfers: Log[]; txFrom: Record<string, Address>;
    blockTime: Record<string, number>; state: { totalSupply: Hex; decimals: Hex } }>("perpme/coin.json");
  const launch = launchesOf(fx.launch.map(raw)).launches[0]!;
  const swaps = fx.swaps.map(l => decodeV3Swap(raw(l)));
  const system = new Set([...STATIC_SYSTEM, ...PERPME_CONTRACTS, ...BURN, launch.pool, ...swaps.map(s => s.sender)].map(lc));
  const [s] = assemblePerpme({ coins: [{ launch, supply: BigInt(fx.state.totalSupply), decimals: Number(BigInt(fx.state.decimals)) }], swaps,
    transfers: fx.transfers.map(l => decodeTransfer(raw(l))), system, txFrom: senders(fx.txFrom), blockTime: new Map(Object.entries(fx.blockTime)) });
  return { id: "raw:perpme-doge", source: "perpme/coin.json (whole recorded history, funding absent)", head: fx.head, data: finish(s!) };
}

export function inputs(): GoldenInput[] {
  const captured = JSON.parse(gunzipSync(readFileSync(new URL("../fixtures/golden/cache.json.gz", import.meta.url))).toString(), (_k: string, v: unknown): unknown => {
    if (v && typeof v === "object") {
      if ("$bigint" in v) return BigInt(v.$bigint as string);
      if ("$set" in v) return new Set(v.$set as string[]);
      if ("$map" in v) return new Map(v.$map as Array<[string, unknown]>);
    }
    return v;
  }) as GoldenInput[];
  return [...captured, ascend(), kalos("ta"), kalos("elant"), kalosSign(), perpme()];
}
