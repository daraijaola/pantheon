// A ballot is a free EIP-712 signature: "in round N, I vote for these coins". No transaction, no gas.
// The service checks it, then weighs it by the voter's HYPE Passport tier (1, 2 or 3 votes per coin).
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

export type Ballot = {
  voter: Address;
  coins: Address[];
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
