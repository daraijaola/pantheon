// Link protocol (spec §5): a single-use challenge, then EIP-712 signatures from the HL wallet
// and (when different) the Elysium wallet over the SAME Link message, rebuilt server-side.
import { randomBytes } from "node:crypto";
import { encodePacked, getAddress, isAddress, isHex, keccak256, verifyTypedData, zeroAddress, type Address, type Hex } from "viem";
import { ELYSIUM_TESTNET_CHAIN_ID, TIMING } from "./config.ts";
import type { ChallengeStore } from "./db.ts";
import { LINK_PURPOSE, linkTypedData, passportDomain, passportTypes, type LinkMessage } from "./eip712.ts";
import type { HlClient } from "./hl/client.ts";
import { signingGate, type Rejection } from "./score.ts";

/** hlKey = keccak256(pepper ‖ hlAccount): on-chain identity that does not reveal the HL address (§5.2). */
export function hlKeyOf(pepper: Hex, hlAccount: Address): Hex {
  if (!isHex(pepper) || pepper.length !== 66) throw new RangeError("pepper must be 32 bytes of hex");
  return keccak256(encodePacked(["bytes32", "address"], [pepper, getAddress(hlAccount)]));
}

export type ChallengeInput = { elysiumAccount: string; hyperliquidAccount: string };

export type ChallengeResult =
  | { ok: true; nonce: Hex; typedData: ReturnType<typeof linkTypedData> }
  | Rejection
  | { ok: false; error: "INVALID_ADDRESS"; field: keyof ChallengeInput };

export type LinkDeps = {
  store: ChallengeStore;
  /** HypePassportRegistry on Elysium: the Link domain's verifyingContract. */
  registry: Address;
  chainId?: number;
  randomNonce?: () => Hex;
};

/**
 * Step 2 of §5.3. Fails fast on API wallets, vaults, sub-accounts and multi-sigs, before anyone signs.
 * Binding checks against the DB and registry (HL_ALREADY_LINKED, …) are the API's job (P7).
 */
export async function createChallenge(
  deps: LinkDeps & { hl: Pick<HlClient, "userRole" | "userToMultiSigSigners"> },
  input: ChallengeInput,
  nowSec: number,
): Promise<ChallengeResult> {
  for (const field of ["elysiumAccount", "hyperliquidAccount"] as const) {
    const v = input[field];
    if (!isAddress(v, { strict: false }) || v.toLowerCase() === zeroAddress) return { ok: false, error: "INVALID_ADDRESS", field };
  }
  const elysium = getAddress(input.elysiumAccount);
  const hl = getAddress(input.hyperliquidAccount);

  const [role, multiSig] = await Promise.all([deps.hl.userRole(hl), deps.hl.userToMultiSigSigners(hl)]);
  const rejected = signingGate(role, multiSig);
  if (rejected) return rejected;

  const nonce = (deps.randomNonce ?? (() => `0x${randomBytes(32).toString("hex")}` as Hex))();
  const deadline = nowSec + TIMING.linkDeadline;
  deps.store.insert({ nonce, elysium, hl, deadline, createdAt: nowSec });
  return { ok: true, nonce, typedData: linkTypedData(deps.registry, message(deps, hl, elysium, nonce, deadline)) };
}

export type VerifyInput = { nonce: string; hlSignature: string; elysiumSignature?: string | undefined };

export type VerifyError = "CHALLENGE_NOT_FOUND" | "CHALLENGE_USED" | "CHALLENGE_EXPIRED" | "BAD_HL_SIGNATURE" | "BAD_ELYSIUM_SIGNATURE";

export type VerifyResult =
  | { ok: true; hyperliquidAccount: Address; elysiumAccount: Address; hlSignature: Hex; elysiumSignature: Hex | null }
  | { ok: false; error: VerifyError };

/**
 * Step 5 of §5.3. The message is rebuilt from the stored challenge; nothing the client sends is
 * trusted except the signatures. Signatures are checked BEFORE the nonce is consumed, so a wrong
 * wallet or a typo does not burn the user's challenge; the atomic consume then admits one caller.
 */
export async function verifyLink(deps: LinkDeps, input: VerifyInput, nowSec: number): Promise<VerifyResult> {
  if (!isHex(input.nonce) || input.nonce.length !== 66) return { ok: false, error: "CHALLENGE_NOT_FOUND" };
  const c = deps.store.get(input.nonce);
  if (!c) return { ok: false, error: "CHALLENGE_NOT_FOUND" };
  if (c.used) return { ok: false, error: "CHALLENGE_USED" };
  if (nowSec > c.deadline) return { ok: false, error: "CHALLENGE_EXPIRED" };

  const msg = message(deps, c.hl, c.elysium, c.nonce, c.deadline);
  if (!(await signedBy(deps.registry, msg, c.hl, input.hlSignature))) return { ok: false, error: "BAD_HL_SIGNATURE" };
  const sameWallet = c.hl === c.elysium;
  if (!sameWallet && !(await signedBy(deps.registry, msg, c.elysium, input.elysiumSignature))) {
    return { ok: false, error: "BAD_ELYSIUM_SIGNATURE" };
  }

  if (!deps.store.consume(c.nonce, nowSec)) {
    // Lost a race with a concurrent verify, or the deadline passed in between.
    return { ok: false, error: nowSec > c.deadline ? "CHALLENGE_EXPIRED" : "CHALLENGE_USED" };
  }
  return {
    ok: true,
    hyperliquidAccount: c.hl,
    elysiumAccount: c.elysium,
    hlSignature: input.hlSignature as Hex,
    elysiumSignature: sameWallet ? null : (input.elysiumSignature as Hex),
  };
}

function message(deps: LinkDeps, hl: Address, elysium: Address, nonce: Hex, deadline: number): LinkMessage {
  return {
    purpose: LINK_PURPOSE,
    hyperliquidAccount: hl,
    elysiumAccount: elysium,
    nonce,
    deadline,
    chainId: deps.chainId ?? ELYSIUM_TESTNET_CHAIN_ID,
  };
}

/** EOA signature check (EIP-1271 wallets are out of scope for v1, §5.3). Malformed input is just "no". */
async function signedBy(registry: Address, msg: LinkMessage, signer: Address, signature: string | undefined): Promise<boolean> {
  if (signature === undefined || !isHex(signature)) return false;
  try {
    return await verifyTypedData({
      address: signer,
      domain: passportDomain(registry),
      types: { Link: passportTypes.Link },
      primaryType: "Link",
      message: { ...msg, deadline: BigInt(msg.deadline), chainId: BigInt(msg.chainId) },
      signature,
    });
  } catch {
    return false;
  }
}
