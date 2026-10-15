// A Trials round: the coins that can be voted for, when voting opens and closes, and how many basket
// seats the vote fills. Each round is a file in deployments/trials (round-N.vote.json), committed before
// it opens, so the candidates and the times are public and can't be changed quietly.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAddress, isAddress, isHex } from "viem";
import { z } from "zod";

const address = z
  .string()
  .refine((v) => isAddress(v, { strict: false }), "must be an address")
  .transform((v) => getAddress(v));
const bytes32 = z.string().refine((v) => isHex(v) && v.length === 66, "must be 32 bytes");

export const Candidate = z.object({
  token: address,
  poolId: bytes32,
  symbol: z.string().nullable(),
  verdict: z.enum(["CLEAN", "WATCH", "NOT_ENOUGH_DATA"]),
  headline: z.string().optional(),
  /** Independent trading in USDC (6 decimals), as DELPHI counts it: no wash, no creator's own trades. */
  realUsdc: z.string().regex(/^\d+$/),
  launchedAt: z.number().int(),
  /** Rank by independent trading, 1 = most. Breaks ties between equal votes. */
  rank: z.number().int().min(1),
});
export type Candidate = z.infer<typeof Candidate>;

export const RoundDef = z
  .object({
    round: z.number().int().min(1),
    chainId: z.number().int(),
    opensAt: z.number().int(),
    closesAt: z.number().int(),
    seats: z.number().int().min(1).max(10),
    method: z.string(),
    source: z.object({ delphiRound: z.number().int(), scannedAt: z.string() }),
    candidates: z.array(Candidate).min(1).max(60),
  })
  .refine((r) => r.closesAt > r.opensAt, "a round must close after it opens")
  .refine((r) => new Set(r.candidates.map((c) => c.token.toLowerCase())).size === r.candidates.length, "a coin is listed twice");
export type RoundDef = z.infer<typeof RoundDef>;

export type Status = "upcoming" | "open" | "closed";

export const statusOf = (r: RoundDef, nowSec: number): Status => (nowSec < r.opensAt ? "upcoming" : nowSec < r.closesAt ? "open" : "closed");

const FILE = /^round-(\d+)\.vote\.json$/;

/** Every vote round in the folder, oldest first. A file that doesn't parse is an error, not skipped. */
export function loadRounds(dir: string): RoundDef[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => FILE.test(n));
  } catch {
    return [];
  }
  return names
    .map((n) => {
      const parsed = RoundDef.safeParse(JSON.parse(readFileSync(join(dir, n), "utf8")));
      if (!parsed.success) throw new Error(`${n}: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
      if (Number(FILE.exec(n)![1]) !== parsed.data.round) throw new Error(`${n} says it is round ${parsed.data.round}`);
      return parsed.data;
    })
    .sort((a, b) => a.round - b.round);
}

/** The round people should see now: the newest one. */
export const currentRound = (rounds: readonly RoundDef[]): RoundDef | null => rounds.at(-1) ?? null;
