// The wallet scan, in stages: history, holdings, verdicts, the first day, the first transaction, standing,
// the wallet's whole footprint on the chain, the bag again with that footprint (every token, and coins sent
// in set apart), and where else the wallet has been if that's turned on.
// Each stage is sent as soon as it's ready, so Micheal's upload animation can show real data as it arrives.
// The first day is its own stage because finding it takes a few seconds: if it were part of history, it
// would hold back every stage behind it, and they'd all land together. A stage that fails says so and the
// rest still come, and a stage that's stuck gives up, so the reveal can never hang.
import type { Bag } from "./bag.ts";
import { NotReady, type Holdings, type HoldingsReader } from "./holdings.ts";
import type { Elsewhere, ElsewhereReader } from "./elsewhere.ts";
import { TooBig, type Footprint, type FootprintReader } from "./footprint.ts";
import type { FirstSeen, FirstTx, HistoryReader, WalletNow } from "./history.ts";
import type { StandingFacts, StandingReader } from "./standing.ts";

const STAGE_TIMEOUT_MS = 30_000;

export type StageName = "history" | "holdings" | "verdicts" | "firstDay" | "firstTx" | "standing" | "footprint" | "wholeBag" | "elsewhere";
export type StageError = "NOT_READY" | "CHAIN_UNAVAILABLE" | "TIMEOUT" | "TOO_BIG";
type Done<K extends StageName, T> = { stage: K; ok: true; data: T };
export type StageEvent =
  | Done<"history", WalletNow>
  | Done<"holdings", Holdings>
  | Done<"verdicts", Bag>
  | Done<"firstDay", { firstSeen: FirstSeen | null }>
  | Done<"firstTx", { firstTx: FirstTx | null }>
  | Done<"standing", StandingFacts>
  | Done<"footprint", Footprint>
  | Done<"wholeBag", Bag>
  | Done<"elsewhere", Elsewhere>
  | { stage: StageName; ok: false; error: StageError };

export type ScanDeps = {
  history: Pick<HistoryReader, "quick" | "firstDay" | "firstTx">;
  holdings: Pick<HoldingsReader, "read">;
  standing: Pick<StandingReader, "read">;
  footprint: Pick<FootprintReader, "read">;
  /** Left out unless reading outside Elysium is turned on. */
  elsewhere?: Pick<ElsewhereReader, "read"> | undefined;
  /** Joins holdings and verdicts, and the footprint when it's given. */
  bag: (holdings: Holdings, footprint?: Footprint) => Bag;
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
      return { ok: false, error: err instanceof NotReady ? "NOT_READY" : err instanceof TooBig ? "TOO_BIG" : "CHAIN_UNAVAILABLE" };
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
  const firstTx = settle(deps.history.firstTx(wallet), ms, log);
  // Twice as long: every other stage has landed by then, and the biggest wallets need it.
  const footprint = settle(deps.footprint.read(wallet), ms * 2, log);
  const elsewhere = deps.elsewhere ? settle(deps.elsewhere.read(wallet), ms, log) : null;

  const h = await history;
  yield h.ok ? { stage: "history", ok: true, data: h.value } : { stage: "history", ok: false, error: h.error };
  const held = await holdings;
  yield held.ok ? { stage: "holdings", ok: true, data: held.value } : { stage: "holdings", ok: false, error: held.error };
  yield held.ok ? { stage: "verdicts", ok: true, data: deps.bag(held.value) } : { stage: "verdicts", ok: false, error: held.error };
  const day = await firstDay;
  yield day.ok ? { stage: "firstDay", ok: true, data: { firstSeen: day.value } } : { stage: "firstDay", ok: false, error: day.error };
  const sentFirst = await firstTx;
  yield sentFirst.ok ? { stage: "firstTx", ok: true, data: { firstTx: sentFirst.value } } : { stage: "firstTx", ok: false, error: sentFirst.error };
  const facts = await standing;
  yield facts.ok ? { stage: "standing", ok: true, data: facts.value } : { stage: "standing", ok: false, error: facts.error };
  const trail = await footprint;
  yield trail.ok ? { stage: "footprint", ok: true, data: trail.value } : { stage: "footprint", ok: false, error: trail.error };
  if (!held.ok) yield { stage: "wholeBag", ok: false, error: held.error };
  else if (!trail.ok) yield { stage: "wholeBag", ok: false, error: trail.error };
  else yield { stage: "wholeBag", ok: true, data: deps.bag(held.value, trail.value) };
  if (elsewhere) {
    const far = await elsewhere;
    yield far.ok ? { stage: "elsewhere", ok: true, data: far.value } : { stage: "elsewhere", ok: false, error: far.error };
  }
}
