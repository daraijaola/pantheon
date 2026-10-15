// A ballot is a free EIP-712 signature: "in round N, I vote for these coins". No transaction, no gas.
// The service checks it, then weighs it: 1 vote for staking PNTH, plus 1, 2 or 3 for a HYPE Passport.
import { getAddress, isAddress, recoverTypedDataAddress, type Address, type Hex } from "viem";
import { z } from "zod";
import type { RoundDef } from "./round.ts";

export const domain = (chainId: number) => ({ name: "PANTHEON Trials", version: "1", chainId }) as const;

export const types = {
  Ballot: [
    { name: "round", type: "uint256" },
    { name: "voter", type: "address" },
    { name: "coins", type: "address[]" },
    { name: "signedAt", type: "uint64" },
  ],
} as const;

const address = z
  .string()
  .refine((v) => isAddress(v, { strict: false }), "must be an address")
  .transform((v) => getAddress(v));

export const BallotInput = z.object({
  round: z.number().int().min(1),
  voter: address,
  coins: z.array(address).min(1).max(10),
  signedAt: z.number().int().min(0),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/, "must be a 65-byte signature") as unknown as z.ZodType<Hex>,
});
export type BallotInput = z.infer<typeof BallotInput>;

/** What a wallet has on-chain when it votes: PNTH staked (18 decimals) and its Passport tier (0 to 3). */
export type Standing = { staked: bigint; tier: number };

/** Staking at least this much PNTH gives a wallet 1 vote. Tokens that are unlocking don't count. */
export const MIN_STAKE = 10n ** 18n;

/** How many votes a wallet puts on each coin it picks: 1 for staking, plus its Passport tier. */
export const weightOf = (s: Standing): number => (s.staked >= MIN_STAKE ? 1 : 0) + s.tier;

export type Ballot = {
  voter: Address;
  coins: Address[];
  /** Votes on each coin picked, fixed when the ballot arrives. */
  weight: number;
  /** PNTH staked then, as a decimal string of the 18-decimal amount. */
  staked: string;
  tier: number;
  signedAt: number;
  signature: Hex;
  receivedAt: number;
};

/** A signature must be this fresh when it arrives, so an old one can't be replayed later. */
export const MAX_SKEW_SEC = 600;

/** What's wrong with a ballot before its signature is checked, as a code the site can explain. Null if nothing. */
export function problem(r: RoundDef, b: BallotInput, nowSec: number): string | null {
  if (b.round !== r.round) return "WRONG_ROUND";
  if (nowSec < r.opensAt) return "NOT_OPEN";
  if (nowSec >= r.closesAt) return "CLOSED";
  if (Math.abs(nowSec - b.signedAt) > MAX_SKEW_SEC) return "STALE_SIGNATURE";
  if (b.coins.length > r.seats) return "TOO_MANY_COINS";
  const picked = b.coins.map((c) => c.toLowerCase());
  if (new Set(picked).size !== picked.length) return "DUPLICATE_COIN";
  const allowed = new Set(r.candidates.map((c) => c.token.toLowerCase()));
  if (!picked.every((c) => allowed.has(c))) return "NOT_A_CANDIDATE";
  return null;
}

/** Who signed this ballot (an ordinary wallet's EIP-712 signature). */
export function signer(chainId: number, b: BallotInput): Promise<Address> {
  return recoverTypedDataAddress({
    domain: domain(chainId),
    types,
    primaryType: "Ballot",
    message: { round: BigInt(b.round), voter: b.voter, coins: b.coins, signedAt: BigInt(b.signedAt) },
    signature: b.signature,
  });
}
