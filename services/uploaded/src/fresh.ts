// Fresh reads for coins whose verdict is getting old, or that DELPHI hasn't read yet. A read takes about
// 10 seconds, so a question never waits for one: it gets the verdict held now and `checking: true`, and
// the fresh verdict is there the next time it asks. Only Ascend is read: every market together takes
// about 3.5 minutes and works the node hard, so Kalos and PerpMe coins wait for the scan and say how
// old their verdict is. One read at a time, and at most one per gap however many coins are asked about.
// The read runs as DELPHI's own script in its own process, so a failure here can't reach this server.
import { execFile } from "node:child_process";
import type { CoinVerdict, UnknownCoin, Verdicts } from "./verdicts.ts";

/** A read asks the node for everything, and only DELPHI's cache makes it quick: a stuck one is stopped. */
const TIMEOUT_MS = 120_000;
/** A verdict older than this is worth refreshing when someone asks. */
const FRESH_AFTER_MS = 30 * 60_000;
const GAP_MS = 5 * 60_000;

/** Runs one read and resolves with what it printed. The signal stops it. */
export type Runner = (signal: AbortSignal) => Promise<string>;

export const runDelphi = (dir: string): Runner => (signal) =>
  new Promise((resolve, reject) => {
    execFile(process.execPath, ["scripts/fresh-read.ts"], { cwd: dir, signal, timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });

export class FreshChecks {
  readonly #verdicts: Pick<Verdicts, "applyFresh">;
  readonly #run: Runner;
  readonly #now: () => number;
  readonly #gapMs: number;
  readonly #afterMs: number;
  readonly #log: (msg: string) => void;
  readonly #onLoaded: () => void;
  readonly #stop = new AbortController();
  #running = false;
  #lastStart: number | null = null;

  constructor(verdicts: Pick<Verdicts, "applyFresh">, run: Runner, opts: { now?: () => number; gapMs?: number; afterMs?: number; log?: (msg: string) => void; onLoaded?: () => void } = {}) {
    this.#verdicts = verdicts;
    this.#run = run;
    this.#now = opts.now ?? Date.now;
    this.#gapMs = opts.gapMs ?? GAP_MS;
    this.#afterMs = opts.afterMs ?? FRESH_AFTER_MS;
    this.#log = opts.log ?? (() => {});
    this.#onLoaded = opts.onLoaded ?? (() => {});
  }

  /** Starts a read if this coin needs one and the gap has passed. True while a read that covers it is running. */
  ask(coin: CoinVerdict | UnknownCoin): boolean {
    if (this.#stop.signal.aborted || (coin.known && coin.venue !== "ascend")) return false;
    if (this.#running) return true;
    const old = !coin.known || this.#now() - Date.parse(coin.scannedAt) > this.#afterMs;
    if (!old) return false;
    if (this.#lastStart !== null && this.#now() - this.#lastStart < this.#gapMs) return false;
    this.#start();
    return true;
  }

  /** Guard's regular read: starts one if none is running and the gap has passed. */
  tick() {
    if (this.#stop.signal.aborted || this.#running) return;
    if (this.#lastStart !== null && this.#now() - this.#lastStart < this.#gapMs) return;
    this.#start();
  }

  /** For shutting down: stops a running read and starts no more. */
  stop() {
    this.#stop.abort();
  }

  #start() {
    this.#running = true;
    this.#lastStart = this.#now();
    this.#run(this.#stop.signal)
      .then((json) => {
        if (this.#verdicts.applyFresh(json)) {
          this.#log("fresh verdicts loaded");
          this.#onLoaded();
        }
      })
      .catch((err: unknown) => {
        // The first line only: what's held keeps answering, and the next read may well work.
        this.#log(`fresh read failed, keeping what we have: ${(err instanceof Error ? err.message : String(err)).split("\n")[0]!.slice(0, 200)}`);
      })
      .finally(() => {
        this.#running = false;
      });
  }
}
