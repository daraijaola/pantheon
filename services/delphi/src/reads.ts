// Heavy reads over BatchRpc: many log streams at
// once, each with its own resume point, plus who sent each transaction, block times, what kind of thing
// an address is, view calls at one block, and who deployed a contract. Answers are remembered in the
// Store under the same names chain.ts uses ("txfrom", "blocktime", "kind"), so both readers share one
// cache. Read-only: BatchRpc refuses anything but read methods.
import { getAddress, isAddress, numberToHex, type Address, type Hex } from "viem";
import { z } from "zod";
import type { AddressKind } from "./chain.ts";
import { mapLimit } from "./chain.ts";
import { asksTooMuch, RpcError, type BatchRpc, type RpcAnswer } from "./rpc.ts";
import type { RawLog, Store } from "./store.ts";
import { multicallPolicy, multicallViews, type MulticallPolicy } from "./multicall.ts";

const lc = (a: string) => a.toLowerCase();

export type StreamSpec = {
  /** Cache name; the stream resumes from its cursor on the next run. */
  stream: string;
  address: Address | Address[];
  /** Topic filters as eth_getLogs takes them: topics[0] is the event, or any of several. */
  topics: Array<Hex | Hex[] | null>;
  from: bigint;
  to: bigint;
  /** Stop once this many new logs were read in this run: the stream is far busier than expected. */
  maxLogs?: number;
  /** Remember the time of each block that has a log (streams whose events become trades). */
  times?: boolean;
  /** The first range to ask for, in blocks (default: everything at once). Busy streams start smaller. */
  step?: bigint;
};
export type StreamResult = { found: number; capped: boolean };

const RpcLog = z.object({
  blockNumber: z.string(),
  logIndex: z.string(),
  transactionHash: z.string(),
  address: z.string(),
  topics: z.array(z.string()),
  data: z.string(),
  /** The explorer's node adds the block's time to every log, which saves a block lookup per trade. */
  blockTimestamp: z.string().optional(),
  removed: z.boolean().optional(),
});

/** Logs per call to aim for. The node refuses more than 10,000; 3,000 is about 2.7 MB of JSON. */
const TARGET_LOGS = 3_000;
/** A quiet stream's whole life fits in one call. */
const MAX_STEP = 1n << 26n;
/**
 * Bound both call count and expected response size. Busy streams send consecutive ranges; oversized
 * ranges shrink independently on the provider's 10,000-result error.
 */
const PER_REQUEST = { calls: 10, logs: 6_000 };

const minB = (a: bigint, b: bigint) => (a < b ? a : b);
const maxB = (a: bigint, b: bigint) => (a > b ? a : b);

/**
 * Reads many log streams up to their `to` block, several ranges per request. Each range is saved with its
 * stream's cursor, in order, so an interrupted run resumes where it stopped. Ranges shrink when the node
 * says a range holds too many logs and grow again to about TARGET_LOGS a call.
 */
export async function scanStreams(
  rpc: BatchRpc,
  store: Store,
  specs: readonly StreamSpec[],
  onProgress?: (done: number, total: number, logs: number) => void,
): Promise<Map<string, StreamResult>> {
  type Live = StreamSpec & { at: bigint; step: bigint; expect: number; found: number; capped: boolean };
  const live: Live[] = specs.map((s) => ({ ...s, at: store.cursor(s.stream, s.from), step: s.step ?? MAX_STEP, expect: s.step ? TARGET_LOGS : 200, found: 0, capped: false }));
  for (;;) {
    // Quiet streams first, so a busy one never keeps them waiting.
    const todo = live.filter((s) => !s.capped && s.at <= s.to).sort((a, b) => a.expect - b.expect);
    if (!todo.length) break;
    // Consecutive ranges per stream, as many as the request's budget allows (always one at least).
    const calls: Array<{ s: Live; from: bigint; to: bigint }> = [];
    let expected = 0;
    for (const s of todo) {
      for (let from = s.at; from <= s.to; from += s.step) {
        if (calls.length && (calls.length >= PER_REQUEST.calls || expected + s.expect > PER_REQUEST.logs)) break;
        calls.push({ s, from, to: minB(from + s.step - 1n, s.to) });
        expected += s.expect;
      }
      if (calls.length >= PER_REQUEST.calls || expected >= PER_REQUEST.logs) break;
    }
    const answers = await rpc.many<unknown>(
      calls.map((c) => ({ method: "eth_getLogs", params: [{ address: c.s.address, topics: c.s.topics, fromBlock: numberToHex(c.from), toBlock: numberToHex(c.to) }] })),
    );
    const times: Array<[string, number]> = [];
    const stopped = new Set<Live>();
    calls.forEach((c, i) => {
      const { s } = c;
      // A stream's ranges are saved in order: after a refused one, the rest wait for the next round.
      if (stopped.has(s) || c.from !== s.at) return;
      const a = answers[i]!;
      if (a.error) {
        if (!asksTooMuch(a.error) || c.to === c.from) {
          throw new RpcError(`eth_getLogs for ${s.stream} (blocks ${c.from}-${c.to}): ${a.error.message}`, a.error.code);
        }
        s.step = maxB(1n, (c.to - c.from + 1n) / 8n);
        s.expect = TARGET_LOGS;
        stopped.add(s);
        return;
      }
      const parsed = z.array(RpcLog).safeParse(a.result);
      if (!parsed.success) throw new RpcError(`unexpected eth_getLogs answer for ${s.stream}: ${parsed.error.issues[0]?.message}`);
      const logs = parsed.data.filter((l) => !l.removed);
      const raw: RawLog[] = logs.map((l) => ({
        block: BigInt(l.blockNumber),
        logIndex: Number(l.logIndex),
        tx: l.transactionHash as Hex,
        address: l.address as Hex,
        topics: l.topics as Hex[],
        data: l.data as Hex,
      }));
      store.saveLogs(s.stream, raw, c.to + 1n);
      if (s.times) for (const l of logs) if (l.blockTimestamp) times.push([BigInt(l.blockNumber).toString(), Number(BigInt(l.blockTimestamp))]);
      const span = c.to - c.from + 1n;
      s.found += raw.length;
      s.at = c.to + 1n;
      // The next range aims at TARGET_LOGS, growing at most 4× at a time.
      const want = raw.length ? (span * BigInt(TARGET_LOGS)) / BigInt(raw.length) : span * 4n;
      s.step = maxB(1n, minB(want, minB(span * 4n, MAX_STEP)));
      s.expect = Math.max(50, Math.min(TARGET_LOGS, raw.length));
      if (s.maxLogs !== undefined && s.found > s.maxLogs) {
        s.capped = true;
        stopped.add(s);
      }
    });
    if (times.length) store.rememberMany("blocktime", times);
    onProgress?.(live.filter((s) => s.capped || s.at > s.to).length, live.length, live.reduce((n, s) => n + s.found, 0));
  }
  return new Map(live.map((s) => [s.stream, { found: s.found, capped: s.capped }]));
}

/**
 * Queue lookup chunks concurrently. BatchRpc splits and paces their requests against one endpoint's
 * shared budget, including funding and simulation readers.
 */
async function manyCalls<T>(rpc: BatchRpc, calls: Array<{ method: string; params: unknown[] }>): Promise<RpcAnswer<T>[]> {
  const parts: Array<typeof calls> = [];
  for (let i = 0; i < calls.length; i += 100) parts.push(calls.slice(i, i + 100));
  return (await mapLimit(parts, rpc.concurrency, (p) => rpc.many<T>(p))).flat();
}

const fail = (what: string, a: RpcAnswer) => new RpcError(`${what}: ${a.error?.message ?? "empty answer"}`, a.error?.code);

/** tx hash → the wallet that sent it (the real trader; a swap's own `sender` is a router). */
export async function sendersOf(rpc: BatchRpc, store: Store, txs: Iterable<string>, onProgress?: (done: number, total: number) => void, blocks?: ReadonlyMap<string, bigint>): Promise<Map<string, Address>> {
  const want = [...new Set([...txs].map(lc))];
  const out = store.recallMany<Address>("txfrom", want);
  const todo = want.filter((t) => !out.has(t));
  const positions = new Map([...(blocks ?? [])].map(([tx, block]) => [lc(tx), block]));
  for (let i = 0; i < todo.length; i += 5_000) {
    const part = todo.slice(i, i + 5_000);
    const groups = new Map<bigint, string[]>();
    for (const hash of part) {
      const block = positions.get(hash);
      if (block === undefined || block < 0n) continue;
      if (!groups.has(block)) groups.set(block, []);
      groups.get(block)!.push(hash);
    }
    const dense = [...groups].filter(([, hashes]) => hashes.length >= 2);
    const found = new Map<string, Address>();
    try {
      const answers = await manyCalls<unknown>(rpc, dense.map(([block]) => ({ method: "eth_getBlockByNumber", params: [numberToHex(block), true] })));
      for (const [j, [block, hashes]] of dense.entries()) {
        const parsed = SenderBlock.safeParse(answers[j]!.result);
        if (!parsed.success || BigInt(parsed.data.number) !== block) continue;
        const needed = new Set(hashes);
        const duplicates = new Set<string>();
        const candidates = new Map<string, Address>();
        for (const raw of parsed.data.transactions) {
          const tx = SenderTransaction.safeParse(raw);
          if (!tx.success || !needed.has(lc(tx.data.hash))) continue;
          const hash = lc(tx.data.hash);
          if (candidates.has(hash)) duplicates.add(hash);
          if (tx.data.blockNumber !== undefined && BigInt(tx.data.blockNumber) !== block) continue;
          candidates.set(hash, getAddress(tx.data.from));
        }
        for (const [hash, from] of candidates) if (!duplicates.has(hash)) found.set(hash, from);
      }
    } catch { /* Unsupported or unavailable full blocks fall back to individual transactions. */ }
    const individual = part.filter((h) => !found.has(h));
    const answers = await manyCalls<{ from?: string } | null>(rpc, individual.map((h) => ({ method: "eth_getTransactionByHash", params: [h] })));
    individual.forEach((h, j) => {
      const from = answers[j]!.result?.from;
      if (!from || !isAddress(from, { strict: false })) throw fail(`eth_getTransactionByHash ${h}`, answers[j]!);
      found.set(h, getAddress(from));
    });
    const got = part.map((h): [string, Address] => [h, found.get(h)!]);
    store.rememberMany("txfrom", got);
    for (const [h, f] of got) out.set(h, f);
    onProgress?.(i + part.length, todo.length);
  }
  return out;
}

const SenderBlock = z.object({ number: z.string().regex(/^0x[\da-f]+$/i), transactions: z.array(z.unknown()) });
const SenderTransaction = z.object({
  hash: z.string().regex(/^0x[\da-f]{64}$/i),
  from: z.string().refine((a) => isAddress(a, { strict: false })),
  blockNumber: z.string().regex(/^0x[\da-f]+$/i).optional(),
});

/** block number (decimal string) → unix time, for blocks whose time no log carried. */
export async function blockTimesOf(rpc: BatchRpc, store: Store, blocks: Iterable<string>): Promise<Map<string, number>> {
  const want = [...new Set(blocks)];
  const out = store.recallMany<number>("blocktime", want);
  const todo = want.filter((b) => !out.has(b));
  const answers = await manyCalls<{ timestamp?: string } | null>(rpc, todo.map((b) => ({ method: "eth_getBlockByNumber", params: [numberToHex(BigInt(b)), false] })));
  const got = todo.map((b, i): [string, number] => {
    const ts = answers[i]!.result?.timestamp;
    if (!ts) throw fail(`eth_getBlockByNumber ${b}`, answers[i]!);
    return [b, Number(BigInt(ts))];
  });
  store.rememberMany("blocktime", got);
  for (const [b, t] of got) out.set(b, t);
  return out;
}

/** The node's answer to a call that reverted (or a contract that isn't there), not an outage. */
const reverted = (a: RpcAnswer) => !!a.error && (a.error.code === 3 || /revert/i.test(a.error.message));

/** One view call (already encoded); `block` overrides the block of the whole set. */
export type View = { to: Address; data: Hex; block?: bigint };

/** Raw answers to view calls at one block; `null` when the call reverted or returned nothing. */
export async function viewsAt(rpc: BatchRpc, calls: readonly View[], block: bigint | "latest", policy: MulticallPolicy | false = multicallPolicy()): Promise<Array<Hex | null>> {
  const tag = (b: bigint | "latest") => (b === "latest" ? b : numberToHex(b));
  const batched = policy ? await multicallViews(rpc, calls, block, policy) : new Map<number, Hex>();
  const pending = calls.map((c, i) => ({ c, i })).filter(({ i }) => !batched.has(i));
  const answers = await manyCalls<Hex>(rpc, pending.map(({ c }) => ({ method: "eth_call", params: [{ to: c.to, data: c.data }, tag(c.block ?? block)] })));
  const out: Array<Hex | null> = calls.map((_, i) => batched.get(i) ?? null);
  answers.forEach((a, j) => {
    const i = pending[j]!.i;
    if (reverted(a)) return null;
    if (a.error || typeof a.result !== "string") throw fail(`eth_call to ${calls[i]!.to}`, a);
    out[i] = a.result === "0x" ? null : a.result;
  });
  return out;
}

const TOKEN0 = "0x0dfe1681"; // token0()
const TOKEN1 = "0xd21220a7"; // token1()

/**
 * Wallet, trading pool, or other contract, as chain.ts's addressKinds decides it: a wallet with an
 * EIP-7702 delegation (0xef0100…) is still a wallet, and a contract that answers token0() and token1()
 * is a pool.
 */
export async function kindsOf(rpc: BatchRpc, store: Store, addresses: Iterable<string>): Promise<Map<string, AddressKind>> {
  const want = [...new Set([...addresses].map(lc))].filter((a) => isAddress(a, { strict: false }));
  const out = store.recallMany<AddressKind>("kind", want);
  const todo = want.filter((a) => !out.has(a));
  for (let i = 0; i < todo.length; i += 10_000) {
    const part = todo.slice(i, i + 10_000);
    const codes = await manyCalls<Hex>(rpc, part.map((a) => ({ method: "eth_getCode", params: [a, "latest"] })));
    const coded = part.filter((a, j) => {
      const code = codes[j]!.result;
      if (typeof code !== "string") throw fail(`eth_getCode ${a}`, codes[j]!);
      return code !== "0x" && !code.startsWith("0xef0100");
    });
    const pairs = await viewsAt(rpc, coded.flatMap((a) => [TOKEN0, TOKEN1].map((data) => ({ to: a as Address, data: data as Hex }))), "latest");
    const isPool = new Set(coded.filter((_, j) => [pairs[2 * j], pairs[2 * j + 1]].every((r) => !!r && r.length >= 66)));
    const coder = new Set(coded);
    const got = part.map((a): [string, AddressKind] => [a, !coder.has(a) ? "wallet" : isPool.has(a) ? "pool" : "contract"]);
    store.rememberMany("kind", got);
    for (const [a, k] of got) out.set(a, k);
  }
  return out;
}

/** Who made a contract, and how: `factory` is set when another contract created it inside the transaction. */
export type Creation = { block: bigint; time: number; tx: Hex | null; deployer: Address | null; factory: Address | null };
type StoredCreation = { block: string; time: number; tx: Hex | null; deployer: Address | null; factory: Address | null };

export const hexAddress = z.string().refine((v) => isAddress(v, { strict: false }), "must be an address").transform((v) => getAddress(v));
const CreationAnswer = z.object({
  creation: z
    .object({
      blockNumber: z.string().regex(/^\d+$/),
      timestamp: z.string().regex(/^\d+$/),
      hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).nullable(),
      from: hexAddress.nullable(),
    })
    .nullable(),
});
type Frame = { type?: string; from?: string; to?: string; calls?: Frame[] };
const FrameSchema: z.ZodType<Frame> = z.lazy(() =>
  z.object({ type: z.string().optional(), from: z.string().optional(), to: z.string().optional(), calls: z.array(FrameSchema).optional() }),
);
const BlockTrace = z.array(z.object({ txHash: z.string().optional(), result: FrameSchema.optional() }));

/** The frame (and its transaction's top frame) that created `target`, searching a block's call traces. */
export function findCreation(trace: z.infer<typeof BlockTrace>, target: string): { tx: Hex | null; deployer: Address | null; factory: Address | null } | null {
  const walk = (f: Frame): Frame | null => {
    if ((f.type === "CREATE" || f.type === "CREATE2") && f.to && lc(f.to) === lc(target)) return f;
    for (const c of f.calls ?? []) {
      const hit = walk(c);
      if (hit) return hit;
    }
    return null;
  };
  for (const t of trace) {
    if (!t.result) continue;
    const hit = walk(t.result);
    if (!hit) continue;
    const root = t.result.from;
    const maker = hit === t.result ? null : hit.from;
    return {
      tx: (t.txHash as Hex | undefined) ?? null,
      deployer: root && isAddress(root, { strict: false }) ? getAddress(root) : null,
      factory: maker && isAddress(maker, { strict: false }) ? getAddress(maker) : null,
    };
  }
  return null;
}

/**
 * Who deployed each contract: the explorer's /api/contract/creation answer, and when it names no sender
 * (the contract was made by a factory inside someone's transaction), the block's call trace. A contract
 * the explorer doesn't know maps to null; one whose lookup failed is left out (try again next run).
 */
export async function creationsOf(
  rpc: BatchRpc,
  store: Store,
  contracts: Iterable<string>,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<Map<string, Creation | null>> {
  const want = [...new Set([...contracts].map(lc))];
  const known = store.recallMany<StoredCreation | null>("creation", want);
  const out = new Map<string, Creation | null>();
  const load = (s: StoredCreation | null): Creation | null => (s ? { ...s, block: BigInt(s.block) } : null);
  for (const [k, v] of known) out.set(k, load(v));
  await mapLimit(
    want.filter((a) => !known.has(a)),
    4,
    async (a) => {
      let body: unknown;
      try {
        const res = await fetchFn(new URL(`/api/contract/creation/${a}`, rpc.url), {
          headers: { "user-agent": "delphi (read-only checks; pantheonindex.com)", accept: "application/json" },
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) return;
        body = await res.json();
      } catch {
        return;
      }
      const parsed = CreationAnswer.safeParse(body);
      if (!parsed.success) return;
      const c = parsed.data.creation;
      let stored: StoredCreation | null = null;
      if (c) {
        stored = { block: c.blockNumber, time: Number(c.timestamp), tx: (c.hash?.toLowerCase() as Hex | undefined) ?? null, deployer: c.from, factory: null };
        if (!c.from) {
          let answer: unknown;
          try {
            answer = await rpc.call("debug_traceBlockByNumber", [numberToHex(BigInt(c.blockNumber)), { tracer: "callTracer" }]);
          } catch {
            return;
          }
          const trace = BlockTrace.safeParse(answer);
          if (!trace.success) return;
          const hit = findCreation(trace.data, a);
          if (hit) stored = { ...stored, ...hit, tx: (hit.tx?.toLowerCase() as Hex | undefined) ?? null };
        }
      }
      store.remember("creation", a, stored);
      out.set(a, load(stored));
    },
  );
  return out;
}
