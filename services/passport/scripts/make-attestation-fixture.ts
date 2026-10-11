// Writes contracts-check/fixtures/attestation.json: attestations signed by OUR attest.ts that the
// Foundry cross-check submits to the reference HypePassportRegistry. Inputs are the spec's §5.1
// cross-check (anvil's public test keys; pepper 0x11…11), so the first entry must reproduce its digest.
// Run: node scripts/make-attestation-fixture.ts   (a vitest test fails if the file drifts)
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Address } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { attestationDigest, buildAttestation, signAttestation } from "../src/attest.ts";
import { hlKeyOf } from "../src/link.ts";

const MNEMONIC = "test test test test test test test test test test test junk";
/** First contract a Foundry test deploys (deployer = default test contract, nonce 1). */
export const FORGE_REGISTRY = "0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f" as Address;
export const FIXTURE_PATH = fileURLToPath(new URL("../contracts-check/fixtures/attestation.json", import.meta.url));
const T0 = 1_791_680_000;

export async function buildFixture() {
  const attestor = mnemonicToAccount(MNEMONIC, { addressIndex: 0 });
  const hl = mnemonicToAccount(MNEMONIC, { addressIndex: 1 }).address;
  const account = mnemonicToAccount(MNEMONIC, { addressIndex: 2 }).address;
  const hlKey = hlKeyOf(`0x${"11".repeat(32)}`, hl);

  const entry = async (tier: number, stamps: number, now: number, lastIssuedAt?: number) => {
    const a = buildAttestation({ account, hlKey, tier, stamps, ...(lastIssuedAt === undefined ? {} : { lastIssuedAt }) }, now);
    return { ...a, digest: attestationDigest(FORGE_REGISTRY, a), sig: await signAttestation(attestor, FORGE_REGISTRY, a) };
  };
  const first = await entry(2, 5, T0); // the spec's cross-check inputs
  const renewal = await entry(3, 133, T0 + 3600, first.issuedAt); // upgrade, an hour later
  const downgrade = await entry(0, 128, T0 + 7200, renewal.issuedAt); // tier 0 keeps the binding (§6.2)
  return { attestor: attestor.address, registry: FORGE_REGISTRY, first, renewal, downgrade };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(FIXTURE_PATH, `${JSON.stringify(await buildFixture(), null, 2)}\n`);
  console.log(`wrote ${FIXTURE_PATH}`);
}
