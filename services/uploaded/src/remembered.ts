// One answer per key, remembered for a while, so the same wallet asked about twice costs one read. Reads
// run one at a time, to go easy on the node, and a failure is never remembered.

export class Remembered<T> {
  readonly #load: (key: string) => Promise<T>;
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #max: number;
  readonly #cache = new Map<string, { at: number; value: T }>();
  readonly #inFlight = new Map<string, Promise<T>>();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(load: (key: string) => Promise<T>, opts: { now?: () => number; ttlMs: number; max?: number }) {
    this.#load = load;
    this.#now = opts.now ?? Date.now;
    this.#ttlMs = opts.ttlMs;
    this.#max = opts.max ?? 5_000;
  }

  get(key: string): Promise<T> {
    const hit = this.#cache.get(key);
    if (hit && this.#now() - hit.at < this.#ttlMs) return Promise.resolve(hit.value);
    const running = this.#inFlight.get(key);
    if (running) return running;
    const run = this.#queue.then(async () => {
      const value = await this.#load(key);
      if (this.#cache.size >= this.#max) this.#cache.delete(this.#cache.keys().next().value!);
      this.#cache.set(key, { at: this.#now(), value });
      return value;
    });
    this.#queue = run.catch(() => undefined);
    const tracked = run.finally(() => this.#inFlight.delete(key));
    this.#inFlight.set(key, tracked);
    return tracked;
  }
}
