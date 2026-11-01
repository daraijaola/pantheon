// What the tests share: a round, ballots, signed ballots and the API with a fake chain. No network.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAddress, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { buildApp } from "../src/api.ts";
import { domain, types, type Ballot, type BallotInput, type Standing } from "../src/ballot.ts";
import type { RoundDef } from "../src/round.ts";
import { Ballots } from "../src/state.ts";

export const CHAIN = 99_801;
export const T0 = 1_760_000_000;
export const DAY = 86_400;
export const coin = (n: number): Address => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
export const pool = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
export const [A, B, C, D] = [coin(0xa1), coin(0xb2), coin(0xc3), coin(0xd4)] as [Address, Address, Address, Address];

/** Round 3 (open from T0 for a day), as rounds 1 to 5 were: none of the newer fields. */
export function round(over: Partial<RoundDef> = {}): RoundDef {
  return {
    round: 3,
    chainId: CHAIN,
    opensAt: T0,
    closesAt: T0 + DAY,
    seats: 3,
    method: "test",
    source: { delphiRound: 2, scannedAt: "2026-10-14T22:43:08.000Z" },
    candidates: [A, B, C, D].map((token, i) => ({
      token,
      poolId: pool(i + 1),
      symbol: `C${i}`,
      verdict: "NOT_ENOUGH_DATA" as const,
      realUsdc: String((4 - i) * 1_000_000),
      launchedAt: T0 - 5 * DAY,
      rank: i + 1,
    })),
    ...over,
  };
}

/** The coin ranked `rank` among `ranked(n)`'s candidates. */
export const k = (rank: number): Address => coin(0x100 + rank);
export const ks = (...ranks: number[]): Address[] => ranks.map(k);
/** `n` candidates ranked 1 to n, most independent trading first. */
export const ranked = (n: number): RoundDef["candidates"] =>
  Array.from({ length: n }, (_, i) => ({
    token: k(i + 1),
    poolId: pool(0x100 + i + 1),
    symbol: `K${i + 1}`,
    verdict: "CLEAN" as const,
    realUsdc: String((n - i) * 1_000_000),
    launchedAt: T0 - 5 * DAY,
    rank: i + 1,
  }));

export const ballot = (voter: Address, coins: Address[], weight: number, signedAt = T0 + 10): Ballot => ({
  voter,
  coins,
  weight,
  staked: "0",
  tier: weight,
  signedAt,
  signature: "0x",
  receivedAt: signedAt,
});

export async function signed(key: `0x${string}`, coins: Address[], over: Partial<BallotInput> = {}): Promise<BallotInput> {
  const acct = privateKeyToAccount(key);
  const msg = { round: 3, voter: acct.address, coins, signedAt: T0 + 100, ...over };
  const signature = await acct.signTypedData({
    domain: domain(CHAIN),
    types,
    primaryType: "Ballot",
    message: { round: BigInt(msg.round), voter: msg.voter, coins: msg.coins, signedAt: BigInt(msg.signedAt) },
  });
  return { ...msg, signature };
}

/** A stake that started a month before T0, long enough for any round here. */
export const LONG_AGO = T0 - 30 * DAY;
export const standing = (staked: bigint, tier = 0, stakeStart = LONG_AGO): Standing => ({ staked, tier, stakeStart });

/** The API on a fake chain (wallets not listed have nothing), with its clock stopped at `nowSec`. Pass the
 * ballot file of an earlier app to see the same ballots at another time. */
export function app(
  wallets: Record<string, Standing> = {},
  nowSec = T0 + 100,
  rounds: RoundDef[] = [round()],
  file = join(mkdtempSync(join(tmpdir(), "trials-")), "ballots.json"),
) {
  const box = new Ballots(file);
  const a = buildApp({
    rounds: () => rounds,
    ballots: box,
    standingOf: async (v) => wallets[v.toLowerCase()] ?? standing(0n, 0, 0),
    chainId: CHAIN,
    now: () => nowSec,
  });
  return { a, box, file };
}
