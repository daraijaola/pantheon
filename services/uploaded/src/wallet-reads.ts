import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StageEvent } from "./scan.ts";

export const READ_MAX_AGE = 24 * 60 * 60_000;
export const READ_COOLDOWN = 10 * 60_000;
export type WalletRead = { wallet: string; readAt: number; complete?: boolean; stages: StageEvent[] };
export type ReadState = { read: WalletRead | null; refreshAfter: number; retry?: boolean };
type Pending = { result: Promise<ReadState>; stages: StageEvent[]; waiters: Set<() => void>; done: boolean };

const complete = (stages: StageEvent[]) => stages.every((stage) => stage.ok && (!(stage.stage === "wholeBag" || stage.stage === "standing") || stage.data.complete !== false));

export class WalletReads {
  readonly #dir: string;
  readonly #scan: (wallet: string) => AsyncIterable<StageEvent>;
  readonly #now: () => number;
  readonly #pending = new Map<string, Pending>();

  constructor(dir: string, scan: (wallet: string) => AsyncIterable<StageEvent>, now = Date.now) {
    this.#dir = dir;
    this.#scan = scan;
    this.#now = now;
  }

  #key(wallet: string) {
    if (!/^0x[0-9a-f]{40}$/i.test(wallet)) throw new Error("INVALID_ADDRESS");
    return wallet.toLowerCase();
  }

  get(wallet: string): ReadState {
    const key = this.#key(wallet);
    try {
      const state = JSON.parse(readFileSync(join(this.#dir, `${key}.json`), "utf8")) as ReadState;
      if (!Number.isFinite(state.refreshAfter) || (state.read && (state.read.wallet !== key || !Number.isFinite(state.read.readAt) || !Array.isArray(state.read.stages)))) throw new Error("Invalid saved read");
      if (state.read) state.read.complete = complete(state.read.stages);
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { read: null, refreshAfter: 0 };
    }
  }

  #save(wallet: string, state: ReadState) {
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
    const file = join(this.#dir, `${wallet}.json`);
    writeFileSync(`${file}.tmp`, JSON.stringify(state), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }

  refresh(wallet: string): Promise<ReadState> {
    const key = this.#key(wallet);
    const pending = this.#pending.get(key);
    if (pending) return pending.result;
    const state = this.get(key);
    if (this.#now() < state.refreshAfter) return Promise.resolve(state);
    const pendingRead: Pending = { result: Promise.resolve(state), stages: [], waiters: new Set(), done: false };
    this.#pending.set(key, pendingRead);
    const notify = () => { for (const wake of pendingRead.waiters) wake(); pendingRead.waiters.clear(); };
    const work = (async () => {
      const refreshAfter = this.#now() + READ_COOLDOWN;
      this.#save(key, { ...state, refreshAfter, retry: true });
      const stages: StageEvent[] = [];
      for await (const stage of this.#scan(key)) {
        stages.push(stage);
        pendingRead.stages.push(stage);
        notify();
      }
      if (!stages.length || stages.some((stage) => !stage.ok) || !stages.some((stage) => stage.stage === "wholeBag") || !stages.some((stage) => stage.stage === "standing")) throw new Error("READ_INCOMPLETE");
      const full = complete(stages);
      const next = { read: !full && state.read?.complete ? state.read : { wallet: key, readAt: this.#now(), complete: full, stages }, refreshAfter, retry: !full };
      this.#save(key, next);
      return next;
    })().finally(() => { pendingRead.done = true; notify(); this.#pending.delete(key); });
    pendingRead.result = work;
    void work.catch(() => {});
    return work;
  }

  async *scan(wallet: string): AsyncGenerator<StageEvent> {
    const key = this.#key(wallet);
    const state = this.get(wallet);
    if (!state.retry && state.read?.complete && this.#now() - state.read.readAt < READ_MAX_AGE) { yield* state.read.stages; return; }
    const result = this.refresh(wallet);
    const pending = this.#pending.get(key);
    if (pending) {
      let sent = 0;
      while (true) {
        while (sent < pending.stages.length) yield pending.stages[sent++]!;
        if (pending.done) break;
        await new Promise<void>(resolve => pending.waiters.add(resolve));
      }
      await result;
      return;
    }
    const next = await result;
    if (!next.read) throw new Error("READ_UNAVAILABLE");
    yield* next.read.stages;
  }
}
