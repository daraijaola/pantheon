// Checks run once at startup, before the API listens: the registry we point at must be the one
// that trusts OUR attestor, with OUR signing domain, on the right chain. Otherwise the service would
// run normally while every passport it signs is rejected on-chain (BadSignature).
// This also proves the attestor key file matches its public address without anyone opening the key.
import { hashDomain, isAddressEqual, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { passportDomain } from "./eip712.ts";

const preflightAbi = parseAbi([
  "function ATTESTOR() view returns (address)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function retired() view returns (bool)",
]);

/** What the checks read from Elysium (a fake in tests). */
export interface PreflightReader {
  chainId(): Promise<number>;
  hasCode(): Promise<boolean>;
  attestor(): Promise<Address>;
  domainSeparator(): Promise<Hex>;
  retired(): Promise<boolean>;
}

export function createPreflightReader(client: PublicClient, registry: Address): PreflightReader {
  const read = <T>(functionName: "ATTESTOR" | "DOMAIN_SEPARATOR" | "retired") =>
    client.readContract({ address: registry, abi: preflightAbi, functionName }) as Promise<T>;
  return {
    chainId: () => client.getChainId(),
    hasCode: async () => ((await client.getCode({ address: registry })) ?? "0x") !== "0x",
    attestor: () => read<Address>("ATTESTOR"),
    domainSeparator: () => read<Hex>("DOMAIN_SEPARATOR"),
    retired: () => read<boolean>("retired"),
  };
}

export class PreflightError extends Error {
  override name = "PreflightError";
}

/** The signing domain the registry must have: the same one our signatures are made for. */
export const expectedDomainSeparator = (registry: Address): Hex =>
  hashDomain({
    domain: passportDomain(registry),
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "verifyingContract", type: "address" },
      ],
    },
  });

/** Throws a PreflightError naming the first mismatch. Every value it prints is public. */
export async function preflight(
  r: PreflightReader,
  want: { chainId: number; registry: Address; attestor: Address },
): Promise<void> {
  const chainId = await r.chainId();
  if (chainId !== want.chainId) throw new PreflightError(`RPC is on chain ${chainId}, expected ${want.chainId}`);
  if (!(await r.hasCode())) throw new PreflightError(`no contract at REGISTRY_ADDRESS ${want.registry}`);
  const onChain = await r.attestor();
  if (!isAddressEqual(onChain, want.attestor)) {
    throw new PreflightError(`registry trusts attestor ${onChain}, but our key file is ${want.attestor}`);
  }
  const domain = await r.domainSeparator();
  if (domain.toLowerCase() !== expectedDomainSeparator(want.registry).toLowerCase()) {
    throw new PreflightError(`registry signing domain ${domain} differs from ours: signatures would be rejected`);
  }
  if (await r.retired()) throw new PreflightError("registry is retired: it no longer accepts passports");
}
