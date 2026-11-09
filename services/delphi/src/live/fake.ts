import { profile } from "../../../network.mts";
// Fake feed records, for local testing only: the feed server's tests, `scripts/feed.ts --seed N` and the
// load test. Shaped like real ones (20 holder rows, several checks with evidence) so sizes and timings are
// honest, but every one is marked: rules "fake-seed", symbols "FAKE…", addresses starting 0xfa4e.
import type { FeedCheck, FeedRecord, Venue } from "./types.ts";

const VENUES: Venue[] = ["perpme", "kalos", "ascend"];
const VERDICTS: Array<[FeedRecord["verdict"], FeedRecord["state"]]> = [
  ["CHECKING", "pending"],
  ["CLEAN", "ready"],
  ["WATCH", "ready"],
  ["FLAG", "ready"],
  ["NOT_ENOUGH_DATA", "thin"],
];

/** A small seeded random source, so the same index always makes the same record. */
function rand(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hex = (r: () => number, n: number) => Array.from({ length: n }, () => Math.floor(r() * 16).toString(16)).join("");

/** The fake coin number `i`'s address: 0xfa4e…, never a real one. */
export const fakeToken = (i: number) => `0xfa4e${i.toString(16).padStart(36, "0")}`;

/** Fake record number `i`, checked at `nowMs` (it expires a minute or two later). */
export function fakeRecord(i: number, opts: { nowMs?: number; firstBlock?: number } = {}, over: Partial<FeedRecord> = {}): FeedRecord {
  const r = rand(i + 1);
  const nowMs = opts.nowMs ?? Date.now();
  const token = fakeToken(i);
  const venue = VENUES[i % VENUES.length]!;
  const [verdict, state] = VERDICTS[i % VERDICTS.length]!;
  const creator = `0x${hex(r, 40)}`;
  const pool = venue === "ascend" ? `0x${hex(r, 64)}` : `0x${hex(r, 40)}`;
  const block = (opts.firstBlock ?? 15_000_000) + i;
  const tx = `0x${hex(r, 64)}`;
  const devShare = Math.round(r() * 0.08 * 1e6) / 1e6;
  const supply = 1_000_000_000n * 10n ** 18n;
  let left = 1;
  const rows = Array.from({ length: 20 }, (_, k) => {
    const share = k === 0 ? 0.38 : k === 1 ? devShare : Math.round(left * r() * 0.12 * 1e6) / 1e6;
    left = Math.max(0, left - share);
    return {
      address: k === 0 ? (venue === "ascend" ? `0x${hex(r, 40)}` : pool) : k === 1 ? creator : `0x${hex(r, 40)}`,
      balance: ((supply * BigInt(Math.round(share * 1e6))) / 1_000_000n).toString(),
      share,
      pool: k === 0,
      dev: k === 1,
      linkedTo: k > 1 && r() < 0.2 ? creator : null,
    };
  });
  const top10 = Math.min(100, Math.round(rows.slice(0, 10).reduce((s, x) => s + x.share, 0) * 1000) / 10);
  const evidence = () => Array.from({ length: 1 + Math.floor(r() * 3) }, () => `0x${hex(r, 64)}`);
  const checks: FeedCheck[] =
    verdict === "CHECKING"
      ? [{ code: "bundle", result: "pending", text: "Checking the first buyers.", evidence: [] }]
      : [
          { code: "bundle", result: verdict === "FLAG" ? "flag" : "ok", text: verdict === "FLAG" ? "4 wallets funded by one wallet bought 17% in the first 30 seconds." : "No linked wallets bought at launch.", evidence: evidence() },
          { code: "wash", result: verdict === "WATCH" ? "watch" : "ok", text: verdict === "WATCH" ? "31% of volume is fast round trips by the same wallets." : "No wash trading seen.", evidence: evidence() },
          { code: "whales", result: "ok", text: "No linked group holds 20% or more.", evidence: [] },
          { code: "fake-ticker", result: "ok", text: "No known coin uses this ticker.", evidence: [] },
          { code: "pool-locked", result: "info", text: "38% sits in the launch pool, locked by PerpMe's locker.", evidence: [] },
        ];
  return {
    v: 1,
    chainId: profile().chainId,
    token,
    venue,
    pool,
    symbol: `FAKE${i}`,
    name: `Fake coin ${i}`,
    state,
    verdict,
    checks,
    holders: verdict === "CHECKING" ? null : { count: 20 + Math.floor(r() * 400), top10, rows },
    dev: { address: creator, share: devShare, sold: r() < 0.3 },
    people: verdict === "CHECKING" ? null : { wallets: 40 + Math.floor(r() * 300), people: 10 + Math.floor(r() * 100) },
    fakeTickerOf: null,
    launch: { tx, block: String(block), timeMs: nowMs - 60_000, creator, creatorBuyShare: devShare },
    rules: "fake-seed",
    block: String(block + 50),
    blockHash: `0x${hex(r, 64)}`,
    checkedAtMs: nowMs,
    expiresAtMs: nowMs + 60_000 + Math.floor(r() * 60_000),
    displayOnly: true,
    reportUrl: `https://pantheonindex.com/delphi/${token}`,
    disputeUrl: `https://pantheonindex.com/delphi/dispute?token=${token}`,
    ...over,
  };
}
