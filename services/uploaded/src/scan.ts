// The wallet scan, in stages: history, then holdings, then verdicts, then the first day, then standing.
// Each stage is sent as soon as it's ready, so Micheal's upload animation can show real data as it arrives.
// The first day is its own stage because finding it takes a few seconds: if it were part of history, it
// would hold back every stage behind it, and they'd all land together. A stage that fails says so and the
// rest still come, and a stage that's stuck gives up, so the reveal can never hang.
import type { Bag } from "./bag.ts";
import { NotReady, type Holdings, type HoldingsReader } from "./holdings.ts";
import type { FirstSeen, HistoryReader, WalletNow } from "./history.ts";
import type { StandingFacts, StandingReader } from "./standing.ts";

const STAGE_TIMEOUT_MS = 30_000;

export type StageName = "history" | "holdings" | "verdicts" | "firstDay" | "standing";
export type StageError = "NOT_READY" | "CHAIN_UNAVAILABLE" | "TIMEOUT";
type Done<K extends StageName, T> = { stage: K; ok: true; data: T };
export type StageEvent =
  | Done<"history", WalletNow>
  | Done<"holdings", Holdings>
  | Done<"verdicts", Bag>
  | Done<"firstDay", { firstSeen: FirstSeen | null }>
  | Done<"standing", StandingFacts>
  | { stage: StageName; ok: false; error: StageError };

export type ScanDeps = {
  history: Pick<HistoryReader, "quick" | "firstDay">;
  holdings: Pick<HoldingsReader, "read">;
  standing: Pick<StandingReader, "read">;
  /** Joins holdings and verdicts. */
  bag: (holdings: Holdings) => Bag;
  timeoutMs?: number;
  log?: (msg: string) => void;
};

type Settled<T> = { ok: true; value: T } | { ok: false; error: StageError };

/** Never rejects: a failure or a stuck read becomes an answer. */
function settle<T>(work: Promise<T>, ms: number, log: (msg: string) => void): Promise<Settled<T>> {
  let timer: NodeJS.Timeout;
  const late = new Promise<Settled<T>>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: "TIMEOUT" }), ms);
  });
  const read = work.then(
    (value): Settled<T> => ({ ok: true, value }),
    (err: unknown): Settled<T> => {
      log(`scan stage failed: ${(err as Error).message.split("\n")[0]}`);
      return { ok: false, error: err instanceof NotReady ? "NOT_READY" : "CHAIN_UNAVAILABLE" };
    },
  );
  return Promise.race([read, late]).finally(() => clearTimeout(timer));
}

export async function* scanStages(wallet: string, deps: ScanDeps): AsyncGenerator<StageEvent> {
  const ms = deps.timeoutMs ?? STAGE_TIMEOUT_MS;
  const log = deps.log ?? (() => {});
  // All start now and are sent in order, so the scan takes as long as the slowest, not all of them added up.
  const history = settle(deps.history.quick(wallet), ms, log);
  const holdings = settle(deps.holdings.read(wallet), ms, log);
  const firstDay = settle(deps.history.firstDay(wallet), ms, log);
  const standing = settle(deps.standing.read(wallet), ms, log);

  const h = await history;
  yield h.ok ? { stage: "history", ok: true, data: h.value } : { stage: "history", ok: false, error: h.error };
  const held = await holdings;
  yield held.ok ? { stage: "holdings", ok: true, data: held.value } : { stage: "holdings", ok: false, error: held.error };
  yield held.ok ? { stage: "verdicts", ok: true, data: deps.bag(held.value) } : { stage: "verdicts", ok: false, error: held.error };
  const day = await firstDay;
  yield day.ok ? { stage: "firstDay", ok: true, data: { firstSeen: day.value } } : { stage: "firstDay", ok: false, error: day.error };
  const facts = await standing;
  yield facts.ok ? { stage: "standing", ok: true, data: facts.value } : { stage: "standing", ok: false, error: facts.error };
}
