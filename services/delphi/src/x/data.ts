// DELPHI-on-X's view of the chain: the same cache and rules as the scan, read again every few
// minutes, plus a quick top-up when someone asks about one coin: funding history for that coin's
// wallets DELPHI hasn't looked up yet, then a fresh read. One read at a time.
import { getAddress, type Address, type PublicClient } from "viem";
import { loadWorkspace } from "../ai/workspace.ts";
import type { Config } from "../config.ts";
import { ExplorerBudgetError } from "../explorer.ts";
import type { FundingSource } from "../funding.ts";
import type { KalosCollected } from "../kalos-collect.ts";
import type { BatchRpc } from "../rpc.ts";
import { actorsOf, isSystem } from "../graph.ts";
import { collect } from "../ingest.ts";
import { analyze } from "../report.ts";
import type { Store } from "../store.ts";
import type { Snapshot } from "./xtools.ts";

const lc = (a: string) => a.toLowerCase();

export class ChainView {
  private current: Snapshot | null = null;
  private busy: Promise<unknown> = Promise.resolve();
  private readonly deps: { client: PublicClient; store: Store; cfg: Config; explorer: FundingSource | null; log: (m: string) => void };
  /**
   * `kalos`: also read every coin on Kalos, over this batched node, again at most every `everyMs`
   * (Kalos is busy: a fresh read takes about 40 s, so in between the last one is reused).
   */
  private readonly opts: { maxTopUp?: number; kalos?: { rpc: BatchRpc; everyMs: number } | null };
  private kalosRead: { at: number; data: KalosCollected } | null = null;

  constructor(deps: ChainView["deps"], opts: ChainView["opts"] = {}) {
    this.deps = deps;
    this.opts = opts;
  }

  snapshot(): Snapshot {
    if (!this.current) throw new Error("no data read yet");
    return this.current;
  }

  /** One read at a time: a second caller waits for the first and then reads again. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.busy.then(fn, fn);
    this.busy = run.catch(() => undefined);
    return run;
  }

  /** Reads everything again from the cache (and new chain logs). Funding comes from the cache only. */
  refresh(): Promise<Snapshot> {
    return this.serial(async () => {
      const { client, store, cfg } = this.deps;
      const k = this.opts.kalos;
      const kalos = !k ? null : this.kalosRead && Date.now() - this.kalosRead.at < k.everyMs ? { reuse: this.kalosRead.data } : { rpc: k.rpc };
      const got = await collect({ client, store, cfg, explorer: null, kalos });
      if (k && got.kalos && kalos && "rpc" in kalos) this.kalosRead = { at: Date.now(), data: got.kalos };
      const { coins, head, notes, hubs, liquidity } = got;
      const readAt = new Date();
      const reports = coins.map((d) => analyze(d, { explorerWeb: cfg.explorerWeb, now: readAt }));
      const ws = await loadWorkspace({ client, store, cfg, coins, reports, hubs, liquidity });
      this.current = { ws, head, readAt, notes: notes.filter((n) => !n.startsWith("explorer skipped")) };
      return this.current;
    });
  }

  /**
   * Fresh data for one coin: looks up funding for its wallets that have none in the cache (at most
   * `maxTopUp`), then reads again. Skipped when the last read is under a minute old and nothing is missing.
   */
  async forCoin(token: string): Promise<Snapshot> {
    const snap = this.snapshot();
    const d = snap.ws.coins.get(lc(token));
    if (!d) return this.refresh();
    const { store, explorer, log } = this.deps;
    const missing = [...actorsOf(d.trades, d.transfers, d.system)]
      .map(lc)
      .filter((w) => !isSystem(d, w) && !d.contracts?.has(w) && store.recall("funding", w) === undefined)
      .slice(0, this.opts.maxTopUp ?? 30);
    const fresh = Date.now() - snap.readAt.getTime() < 60_000;
    if (fresh && missing.length === 0) return snap;
    if (explorer?.fundingsMany && missing.length) {
      // All of them at once (about 25 batched reads), then how busy each new funder is.
      try {
        const got = await explorer.fundingsMany(missing.map((w) => getAddress(w)));
        for (const [w, fs] of got) store.remember("funding", w, fs.map((f) => ({ from: f.from, via: f.via, value: f.value.toString(), tx: f.tx, time: f.time })));
        const funders = [...new Set([...got.values()].flat().map((f) => lc(f.from)))].filter((f) => store.recall<number>("txcount", f) === undefined);
        if (funders.length && explorer.txCounts) for (const [f, n] of await explorer.txCounts(funders.map((f) => getAddress(f)))) store.remember("txcount", f, n);
        if (got.size < missing.length) log(`funding read for ${got.size}/${missing.length} wallets of ${token}`);
      } catch (err) {
        log(`funding lookup failed for ${token}: ${(err as Error).message}`);
      }
    } else if (explorer && missing.length) {
      let looked = 0;
      try {
        for (const w of missing) {
          const got = (await explorer.fundings(getAddress(w))).map((f) => ({ from: f.from, via: f.via, value: f.value.toString(), tx: f.tx, time: f.time }));
          store.remember("funding", w, got);
          looked += 1;
          for (const f of got) {
            const funder = lc(f.from) as Address;
            if (store.recall<number>("txcount", funder) === undefined) store.remember("txcount", funder, await explorer.txCount(getAddress(funder)));
          }
        }
      } catch (err) {
        if (!(err instanceof ExplorerBudgetError)) throw err;
        log(`explorer allowance low: looked up ${looked}/${missing.length} wallets for ${token}`);
      }
    }
    return this.refresh();
  }
}
