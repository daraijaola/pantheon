// Signing and recording one attestation: shared by the API (verify/refresh) and the scheduler.
import type { Address, Hex, LocalAccount } from "viem";
import { buildAttestation, signAttestation, type Attestation } from "./attest.ts";
import type { PassportStore } from "./db.ts";
import type { Level } from "./policy.ts";
import type { RegistryReader } from "./registry.ts";

export type Signed = { id: number; attestation: Attestation; signature: Hex };

export type IssueDeps = {
  chainId: number;
  store: PassportStore;
  registry: RegistryReader;
  attestor: LocalAccount;
};

/** Sign `level` for `account`, strictly newer than anything signed or on chain, and store it as "signed". */
export async function signAndStore(d: IssueDeps, account: Address, hlKey: Hex, level: Level, nowSec: number): Promise<Signed> {
  const lastIssuedAt = Math.max(d.store.lastIssuedAt(account), await d.registry.lastIssuedAt(account));
  const attestation = buildAttestation({ account, hlKey, tier: level.tier, stamps: level.stamps, lastIssuedAt }, nowSec, d.chainId);
  const signature = await signAttestation(d.attestor, d.registry.address, attestation);
  const id = d.store.insertAttestation({
    elysium: account,
    hlKey,
    tier: attestation.tier,
    stamps: attestation.stamps,
    issuedAt: attestation.issuedAt,
    expiry: attestation.expiry,
    deadline: attestation.deadline,
    sig: signature,
    txHash: null,
    status: "signed",
  });
  return { id, attestation, signature };
}
