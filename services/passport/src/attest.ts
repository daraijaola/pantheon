// Attestations (spec §5.1, §6.2): the attestor's EIP-712 signature that `account` holds `tier`
// and `stamps`. Anyone may submit it; HypePassportRegistry checks the signer, chain and times.
import { readFileSync, statSync } from "node:fs";
import { hashTypedData, isAddress, isHex, zeroAddress, type Address, type Hex, type LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ELYSIUM_TESTNET_CHAIN_ID, STAMP_MASK, TIMING } from "./config.ts";
import { passportDomain, passportTypes } from "./eip712.ts";

/** Plain numbers (all fit in 2^53) so it serialises to JSON for the API and the DB. */
export type Attestation = {
  account: Address;
  hlKey: Hex;
  tier: number;
  stamps: number;
  issuedAt: number;
  expiry: number;
  deadline: number;
  chainId: number;
};

export type AttestationInput = {
  account: Address;
  hlKey: Hex;
  tier: number;
  stamps: number;
  /** The account's last on-chain issuedAt: the registry needs a strictly newer one (§6.2). */
  lastIssuedAt?: number;
};

/** issuedAt = now (or last + 1), expiry = issuedAt + 7 d, deadline = now + 1 h, chain 99801 (§13 P5). */
export function buildAttestation(input: AttestationInput, nowSec: number, chainId = ELYSIUM_TESTNET_CHAIN_ID): Attestation {
  if (!isAddress(input.account, { strict: false }) || input.account.toLowerCase() === zeroAddress) {
    throw new RangeError("account must be a non-zero address");
  }
  if (!isHex(input.hlKey) || input.hlKey.length !== 66 || BigInt(input.hlKey) === 0n) throw new RangeError("hlKey must be a non-zero bytes32");
  if (!Number.isInteger(input.tier) || input.tier < 0 || input.tier > 3) throw new RangeError("tier must be 0..3");
  if (!Number.isInteger(input.stamps) || input.stamps < 0 || (input.stamps & ~STAMP_MASK) !== 0) {
    throw new RangeError("stamps must only use bits 0-7");
  }
  const issuedAt = Math.max(nowSec, (input.lastIssuedAt ?? 0) + 1);
  // The registry rejects issuedAt > now + 10 min (IssuedInFuture); never sign one it would refuse.
  if (issuedAt > nowSec + 600) throw new RangeError("lastIssuedAt is too far ahead of now");
  return {
    account: input.account,
    hlKey: input.hlKey,
    tier: input.tier,
    stamps: input.stamps,
    issuedAt,
    expiry: issuedAt + TIMING.attestationTtl,
    deadline: nowSec + TIMING.attestationDeadline,
    chainId,
  };
}

function typed(registry: Address, a: Attestation) {
  return {
    domain: passportDomain(registry),
    types: { Attestation: passportTypes.Attestation },
    primaryType: "Attestation" as const,
    message: {
      ...a,
      issuedAt: BigInt(a.issuedAt),
      expiry: BigInt(a.expiry),
      deadline: BigInt(a.deadline),
      chainId: BigInt(a.chainId),
    },
  };
}

/** Equals `HypePassportRegistry.hashAttestation(a)` (checked by contracts-check/). */
export function attestationDigest(registry: Address, a: Attestation): Hex {
  return hashTypedData(typed(registry, a));
}

/** 65-byte r‖s‖v signature, low-s and v ∈ {27, 28}, as the registry requires. */
export function signAttestation(attestor: LocalAccount, registry: Address, a: Attestation): Promise<Hex> {
  if (!attestor.signTypedData) throw new TypeError("attestor account cannot sign typed data");
  return attestor.signTypedData(typed(registry, a));
}

/**
 * Read a key or pepper file. Refuses files that group or others can access: on this shared
 * server `/srv/hackathon` is group-readable, so a loose mode means the secret may already leak.
 */
export function readSecretFile(path: string): string {
  const { mode } = statSync(path);
  if ((mode & 0o077) !== 0) {
    throw new Error(`refusing ${path}: mode ${(mode & 0o777).toString(8)}, must be 0600 or 0400`);
  }
  return readFileSync(path, "utf8").trim();
}

function hex32(value: string, what: string): Hex {
  const v = value.startsWith("0x") ? value : `0x${value}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(v)) throw new Error(`${what} file must hold 32 bytes of hex`);
  return v as Hex;
}

export function loadAttestor(keyFile: string): LocalAccount {
  return privateKeyToAccount(hex32(readSecretFile(keyFile), "attestor key"));
}

export function loadPepper(pepperFile: string): Hex {
  return hex32(readSecretFile(pepperFile), "pepper");
}
