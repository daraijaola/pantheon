import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";
import { expectedDomainSeparator, preflight, PreflightError, type PreflightReader } from "../src/preflight.ts";

// The live deployment (Elysium testnet, Oct 14): values read from the chain with `cast call`.
const REGISTRY: Address = "0x0Eb4A8eB47364Be9d18410AF2f850db92b807290";
const ATTESTOR: Address = "0xA0C83077eceEc319d02424BbEFe575244434dde8";
const LIVE_DOMAIN: Hex = "0xb3993f9196e5df94b63bc2671f4efab145b28804fcc37c1cad630dcb3354ed10";

const reader = (over: Partial<Record<keyof PreflightReader, unknown>> = {}): PreflightReader => {
  const base = { chainId: 99_801, hasCode: true, attestor: ATTESTOR, domainSeparator: LIVE_DOMAIN, retired: false, ...over };
  return Object.fromEntries(Object.entries(base).map(([k, v]) => [k, async () => v])) as unknown as PreflightReader;
};
const want = { chainId: 99_801, registry: REGISTRY, attestor: ATTESTOR };

describe("expectedDomainSeparator", () => {
  it("matches the DOMAIN_SEPARATOR the deployed registry reports", () => {
    expect(expectedDomainSeparator(REGISTRY)).toBe(LIVE_DOMAIN);
  });
});

describe("preflight", () => {
  it("passes when the registry trusts our attestor with our domain", async () => {
    await expect(preflight(reader(), want)).resolves.toBeUndefined();
    // Address case must not matter.
    await expect(preflight(reader({ attestor: ATTESTOR.toLowerCase() }), want)).resolves.toBeUndefined();
  });

  it("refuses a registry that trusts a different attestor", async () => {
    const other = "0x0000000000000000000000000000000000000001";
    await expect(preflight(reader({ attestor: other }), want)).rejects.toThrow(/trusts attestor 0x0+1, but our key file is 0xA0C8/);
  });

  it("refuses a different signing domain, the wrong chain, no contract, or a retired registry", async () => {
    await expect(preflight(reader({ domainSeparator: `0x${"00".repeat(32)}` }), want)).rejects.toThrow(/signing domain/);
    await expect(preflight(reader({ chainId: 1 }), want)).rejects.toThrow(/chain 1, expected 99801/);
    await expect(preflight(reader({ hasCode: false }), want)).rejects.toThrow(/no contract/);
    await expect(preflight(reader({ retired: true }), want)).rejects.toThrow(PreflightError);
  });
});
