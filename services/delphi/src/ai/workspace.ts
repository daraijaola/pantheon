// What the AI explainer can look at: one scan's coins and reports, plus what DELPHI's cache knows
// about pools and wallet funding. Loaded once per run; the tools then read it without the network.
import { getAddress, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { isRevert, launchpadAddresses } from "../chain.ts";
import { KNOWN_HUBS, RULES, type Config } from "../config.ts";
import { actorsOf } from "../graph.ts";
import { decodeLaunch, decodePool } from "../ingest.ts";
import type { CoinReport } from "../report.ts";
import type { Store } from "../store.ts";
import type { CoinData } from "../types.ts";

const lc = (a: string) => a.toLowerCase();

/** A currency a coin trades against. Symbols are checked: anyone can deploy a token. */
export type Currency = { address: Address; symbol: string; decimals: number };

/** Native HYPE paid into a wallet. `funder` is the real payer (the sender, for payments made inside a contract call). */
/** `paidByContract`: a contract paid it inside a transaction the funder sent (a sale, a game payout, a batch). */
export type FundingView = { funder: Address; value: bigint; tx: Hex; time: number; publicHub: boolean; paidByContract?: boolean };

export type Workspace = {
  explorerWeb: string;
  /** Lowercase token → its data and its report. */
  coins: ReadonlyMap<string, CoinData>;
  reports: ReadonlyMap<string, CoinReport>;
  /** Lowercase pool id → the pool's two currencies (one of them is the coin). */
  pools: ReadonlyMap<string, readonly [Currency, Currency]>;
  /** Lowercase wallet → HYPE it received. A wallet that is missing has no funding history in the cache. */
  fundings: ReadonlyMap<string, FundingView[]>;
};

export function makeWorkspace(input: {
  explorerWeb: string;
  coins: CoinData[];
  reports: CoinReport[];
  pools?: ReadonlyMap<string, readonly [Currency, Currency]>;
  fundings?: ReadonlyMap<string, FundingView[]>;
}): Workspace {
  return {
    explorerWeb: input.explorerWeb.replace(/\/$/, ""),
    coins: new Map(input.coins.map((d) => [lc(d.coin.token), d])),
    reports: new Map(input.reports.map((r) => [lc(r.coin.token), r])),
    pools: input.pools ?? new Map(),
    fundings: input.fundings ?? new Map(),
  };
}

const NATIVE: Address = "0x0000000000000000000000000000000000000000";
const ERC20 = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);
const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
/** Keep a self-chosen symbol only if it is short and plain; otherwise name the token by its address. */
const safeSymbol = (s: string | null, a: Address) => (s && /^[A-Za-z0-9$.]{1,12}$/.test(s) ? s : `tokens of ${shortAddr(a)}`);

/** Symbol and decimals of the currencies coins trade against (remembered in the cache). */
async function currencies(client: PublicClient, store: Store, addresses: Iterable<Address>): Promise<Map<string, Currency>> {
  const out = new Map<string, Currency>();
  for (const address of new Set([...addresses].map((a) => getAddress(a)))) {
    if (address === NATIVE) {
      out.set(lc(address), { address, symbol: "HYPE", decimals: 18 });
      continue;
    }
    let meta = store.recall<{ symbol: string | null; decimals: number }>("currency", address);
    if (!meta) {
      const read = <T>(functionName: "symbol" | "decimals", fallback: T) =>
        client.readContract({ address, abi: ERC20, functionName }).catch((err: unknown) => {
          if (isRevert(err)) return fallback;
          throw err;
        });
      const [symbol, decimals] = await Promise.all([read("symbol", null), read("decimals", 18)]);
      meta = { symbol: typeof symbol === "string" ? symbol : null, decimals: Number(decimals) };
      store.remember("currency", address, meta);
    }
    out.set(lc(address), { address, symbol: safeSymbol(meta.symbol, address), decimals: meta.decimals });
  }
  return out;
}

type StoredFunding = { from: Address; via: "tx" | "internal"; value: string; tx: Hex; time: number };

/** The live workspace: the scan's coins and reports, plus pools and funding read from DELPHI's cache. */
export async function loadWorkspace(deps: {
  client: PublicClient;
  store: Store;
  cfg: Config;
  coins: CoinData[];
  reports: CoinReport[];
  /** The funders this scan treated as public (from `collect`); without it, only the listed and very busy ones. */
  hubs?: ReadonlySet<string>;
}): Promise<Workspace> {
  const { client, store, cfg } = deps;
  const lp = await launchpadAddresses(client, cfg.launchpad);
  const launches = store.logs(`launched:${lc(cfg.launchpad)}`).map(decodeLaunch);
  const coinSet = new Set(launches.map((l) => lc(l.token)));
  const pairs = new Map<string, readonly [Address, Address]>();
  for (const l of launches) pairs.set(lc(l.poolId), [l.token, l.quote]);
  for (const p of store.logs(`pools:${lc(lp.poolManager)}`).map(decodePool)) {
    if (coinSet.has(lc(p.currency0)) || coinSet.has(lc(p.currency1))) pairs.set(lc(p.poolId), [p.currency0, p.currency1]);
  }
  // Ascend coins all have 18 decimals; only the other side needs looking up.
  const others = [...pairs.values()].flat().filter((a) => !coinSet.has(lc(a)));
  const meta = await currencies(client, store, others);
  const asCurrency = (a: Address): Currency => meta.get(lc(a)) ?? { address: getAddress(a), symbol: `tokens of ${shortAddr(a)}`, decimals: 18 };
  const pools = new Map([...pairs].map(([id, [a, b]]) => [id, [asCurrency(a), asCurrency(b)] as const]));

  const hubs = new Set(KNOWN_HUBS.map(lc));
  const fundings = new Map<string, FundingView[]>();
  for (const d of deps.coins) {
    for (const w of actorsOf(d.trades, d.transfers, d.system)) {
      if (fundings.has(lc(w))) continue;
      const got = store.recall<StoredFunding[]>("funding", w);
      if (!got) continue;
      fundings.set(
        lc(w),
        got.map((f) => {
          const funder = getAddress((f.via === "internal" ? store.recall<Address>("txfrom", f.tx) : undefined) ?? f.from);
          const txs = store.recall<number>("txcount", funder);
          const publicHub = hubs.has(lc(funder)) || (txs ?? 0) >= RULES.hub.minTxCount || (deps.hubs?.has(lc(funder)) ?? false);
          return { funder, value: BigInt(f.value), tx: f.tx, time: f.time, publicHub, ...(f.via === "internal" ? { paidByContract: true } : {}) };
        }),
      );
    }
  }
  return makeWorkspace({ explorerWeb: cfg.explorerWeb, coins: deps.coins, reports: deps.reports, pools, fundings });
}
