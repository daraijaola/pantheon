// EIP-712 definitions shared by the service, Micheal's UI and HypePassportRegistry (spec §5.1).
// The domain deliberately has NO chainId: MetaMask refuses typed data whose domain chainId differs
// from the active network (@metamask/signature-controller 40.0.0, dist/utils/validation.js:106-116),
// and HL users are usually on HyperEVM or Arbitrum. Every struct carries `chainId` instead.
import type { Address, Hex } from "viem";

export const passportDomain = (verifyingContract: Address) =>
  ({ name: "HYPE Passport", version: "1", verifyingContract }) as const;

export const passportTypes = {
  Link: [
    { name: "purpose", type: "string" },
    { name: "hyperliquidAccount", type: "address" },
    { name: "elysiumAccount", type: "address" },
    { name: "nonce", type: "bytes32" },
    { name: "deadline", type: "uint64" },
    { name: "chainId", type: "uint256" },
  ],
  Attestation: [
    { name: "account", type: "address" },
    { name: "hlKey", type: "bytes32" },
    { name: "tier", type: "uint8" },
    { name: "stamps", type: "uint32" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiry", type: "uint64" },
    { name: "deadline", type: "uint64" },
    { name: "chainId", type: "uint256" },
  ],
} as const;

export const LINK_PURPOSE =
  "HYPE Passport: link this Hyperliquid account to this Elysium wallet. Read-only; no funds move.";

/** Numbers, not bigints, so the payload is plain JSON for the UI (all values fit in 2^53). */
export type LinkMessage = {
  purpose: string;
  hyperliquidAccount: Address;
  elysiumAccount: Address;
  nonce: Hex;
  deadline: number;
  chainId: number;
};

/** The JSON payload `/passport/challenge` returns (wagmi adds the EIP712Domain type itself). */
export function linkTypedData(registry: Address, message: LinkMessage) {
  return {
    domain: passportDomain(registry),
    types: { Link: passportTypes.Link },
    primaryType: "Link" as const,
    message,
  };
}

/**
 * The same payload typed for viem/wagmi `signTypedData`, whose TypeScript types want bigint for
 * uint fields (the hash is identical either way). The UI calls this on the JSON it received.
 */
export function toSignable(td: ReturnType<typeof linkTypedData>) {
  return { ...td, message: { ...td.message, deadline: BigInt(td.message.deadline), chainId: BigInt(td.message.chainId) } };
}
