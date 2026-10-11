import { SignTypedDataVersion, TypedDataUtils } from "@metamask/eth-sig-util";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hexToBigInt, recoverTypedDataAddress, sliceHex, type Address, type Hex } from "viem";
import { generatePrivateKey, mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { attestationDigest, buildAttestation, loadAttestor, loadPepper, readSecretFile, signAttestation } from "../src/attest.ts";
import { passportDomain, passportTypes } from "../src/eip712.ts";
import { hlKeyOf } from "../src/link.ts";
import { buildFixture, FIXTURE_PATH, FORGE_REGISTRY } from "../scripts/make-attestation-fixture.ts";

const crosscheck = JSON.parse(readFileSync(new URL("./fixtures/hl/eip712_crosscheck.json", import.meta.url), "utf8"));
const MNEMONIC = "test test test test test test test test test test test junk"; // anvil's public test keys
const attestor = mnemonicToAccount(MNEMONIC, { addressIndex: 0 });
const account = crosscheck.account as Address;
const hlKey = hlKeyOf(`0x${"11".repeat(32)}`, mnemonicToAccount(MNEMONIC, { addressIndex: 1 }).address);
const T0 = 1_791_680_000;
const SECP256K1_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

describe("attestation cross-check (§13 P5)", () => {
  const a = buildAttestation({ account, hlKey, tier: 2, stamps: 5 }, T0);

  it("builds issuedAt = now, expiry = +7 d, deadline = +1 h on chain 99801", () => {
    expect(a).toEqual({ account, hlKey: crosscheck.hlKey, tier: 2, stamps: 5, issuedAt: T0, expiry: crosscheck.expiry, deadline: crosscheck.deadline, chainId: 99801 });
  });

  it("reproduces the spec's digest and signature, which recovers to the attestor", async () => {
    expect(attestationDigest(FORGE_REGISTRY, a)).toBe(crosscheck.digest);
    const sig = await signAttestation(attestor, FORGE_REGISTRY, a);
    expect(sig).toBe(crosscheck.sig);
    const recovered = await recoverTypedDataAddress({
      domain: passportDomain(FORGE_REGISTRY),
      types: { Attestation: passportTypes.Attestation },
      primaryType: "Attestation",
      message: { ...a, issuedAt: BigInt(a.issuedAt), expiry: BigInt(a.expiry), deadline: BigInt(a.deadline), chainId: BigInt(a.chainId) },
      signature: sig,
    });
    expect(recovered).toBe("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
  });

  it("hashes exactly like MetaMask's EIP-712 code (a third, independent implementation)", () => {
    const digest = TypedDataUtils.eip712Hash(
      {
        domain: passportDomain(FORGE_REGISTRY),
        types: {
          EIP712Domain: [
            { name: "name", type: "string" },
            { name: "version", type: "string" },
            { name: "verifyingContract", type: "address" },
          ],
          Attestation: [...passportTypes.Attestation],
        },
        primaryType: "Attestation",
        message: a,
      },
      SignTypedDataVersion.V4,
    );
    expect(`0x${Buffer.from(digest).toString("hex")}`).toBe(crosscheck.digest);
  });

  it("signs in the shape the registry's ecrecover accepts: 65 bytes, low-s, v ∈ {27, 28}", async () => {
    for (let tier = 0; tier <= 3; tier++) {
      const sig = await signAttestation(attestor, FORGE_REGISTRY, buildAttestation({ account, hlKey, tier, stamps: tier * 7 }, T0 + tier));
      expect((sig.length - 2) / 2).toBe(65);
      expect(hexToBigInt(sliceHex(sig, 32, 64))).toBeLessThanOrEqual(SECP256K1_HALF_N);
      expect([27, 28]).toContain(Number(hexToBigInt(sliceHex(sig, 64, 65))));
    }
  });

  it("matches the committed Foundry fixture (re-run scripts/make-attestation-fixture.ts if this fails)", async () => {
    expect(JSON.parse(readFileSync(FIXTURE_PATH, "utf8"))).toEqual(JSON.parse(JSON.stringify(await buildFixture())));
  });
});

describe("buildAttestation guards (registry rules, §6.2)", () => {
  const base = { account, hlKey, tier: 1, stamps: 0 };

  it.each([
    [{ ...base, tier: 4 }, /tier/],
    [{ ...base, tier: 1.5 }, /tier/],
    [{ ...base, stamps: 256 }, /stamps/],
    [{ ...base, stamps: -1 }, /stamps/],
    [{ ...base, account: "0x0000000000000000000000000000000000000000" as Address }, /account/],
    [{ ...base, hlKey: `0x${"00".repeat(32)}` as Hex }, /hlKey/],
    [{ ...base, hlKey: "0x1234" as Hex }, /hlKey/],
  ])("refuses %o", (input, msg) => {
    expect(() => buildAttestation(input, T0)).toThrow(msg);
  });

  it("is always strictly newer than the last on-chain issuedAt", () => {
    expect(buildAttestation({ ...base, lastIssuedAt: T0 }, T0).issuedAt).toBe(T0 + 1);
    expect(buildAttestation({ ...base, lastIssuedAt: T0 - 50 }, T0).issuedAt).toBe(T0);
    const bumped = buildAttestation({ ...base, lastIssuedAt: T0 + 30 }, T0);
    expect(bumped.expiry).toBe(bumped.issuedAt + 7 * 86_400);
    expect(bumped.expiry - bumped.issuedAt).toBeLessThanOrEqual(8 * 86_400);
  });

  it("refuses to sign what the registry would reject as issued in the future", () => {
    expect(() => buildAttestation({ ...base, lastIssuedAt: T0 + 700 }, T0)).toThrow(/too far ahead/);
  });
});

describe("secret files", () => {
  const dir = mkdtempSync(join(tmpdir(), "passport-keys-"));
  const write = (name: string, content: string, mode: number) => {
    const p = join(dir, name);
    writeFileSync(p, content);
    chmodSync(p, mode);
    return p;
  };

  it("loads a 0600 attestor key and signs with it", () => {
    const key = generatePrivateKey();
    expect(loadAttestor(write("attestor.key", `${key}\n`, 0o600)).address).toBe(privateKeyToAccount(key).address);
  });

  it("refuses key files that group or others can read", () => {
    for (const mode of [0o644, 0o640, 0o660, 0o604]) {
      expect(() => readSecretFile(write(`loose-${mode.toString(8)}`, "x", mode))).toThrow(/must be 0600 or 0400/);
    }
    expect(readSecretFile(write("ro.key", "x", 0o400))).toBe("x");
  });

  it("accepts a pepper with or without 0x, and nothing but 32 bytes", () => {
    expect(loadPepper(write("pepper", "11".repeat(32), 0o600))).toBe(`0x${"11".repeat(32)}`);
    expect(() => loadPepper(write("short", "0x1111", 0o600))).toThrow(/32 bytes/);
  });
});
