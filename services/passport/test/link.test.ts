import { readFileSync } from "node:fs";
import type { Address, Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase, SqliteChallengeStore } from "../src/db.ts";
import { passportDomain, toSignable } from "../src/eip712.ts";
import type { MultiSigSigners, UserRole } from "../src/hl/schemas.ts";
import { createChallenge, hlKeyOf, verifyLink, type LinkDeps } from "../src/link.ts";

// Foundry/anvil's public test mnemonic: well-known throwaway keys, never funded on a real chain.
const MNEMONIC = "test test test test test test test test test test test junk";
const key = (i: number) => mnemonicToAccount(MNEMONIC, { addressIndex: i });
const H = key(1); // HL wallet
const E = key(2); // Elysium wallet
const AGENT = key(3); // an API wallet acting for H
const STRANGER = key(4);

const REGISTRY = "0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f" as Address; // spec §5.1 cross-check
const NOW = 1_791_680_000;

const crosscheck = JSON.parse(readFileSync(new URL("./fixtures/hl/eip712_crosscheck.json", import.meta.url), "utf8"));

let deps: LinkDeps & { hl: { userRole: (u: Address) => Promise<UserRole>; userToMultiSigSigners: (u: Address) => Promise<MultiSigSigners> } };
let roles: Map<string, UserRole>;
let multisigs: Map<string, MultiSigSigners>;

beforeEach(() => {
  roles = new Map([[AGENT.address.toLowerCase(), { role: "agent", data: { user: H.address.toLowerCase() } }]]);
  multisigs = new Map();
  deps = {
    store: new SqliteChallengeStore(openDatabase(":memory:")),
    registry: REGISTRY,
    hl: {
      userRole: async (u) => roles.get(u.toLowerCase()) ?? { role: "user" },
      userToMultiSigSigners: async (u) => multisigs.get(u.toLowerCase()) ?? null,
    },
  };
});

async function challenge(hl = H.address, ely = E.address) {
  const c = await createChallenge(deps, { hyperliquidAccount: hl, elysiumAccount: ely }, NOW);
  if (!c.ok) throw new Error(`challenge refused: ${c.error}`);
  return c;
}

describe("hlKey (§5.2)", () => {
  it("matches the cross-check vector (pepper 0x11…11, HL = anvil key #1)", () => {
    expect(hlKeyOf(`0x${"11".repeat(32)}`, H.address)).toBe(crosscheck.hlKey);
    expect(hlKeyOf(`0x${"11".repeat(32)}`, H.address.toLowerCase() as Address)).toBe(crosscheck.hlKey);
  });

  it("changes completely with the pepper, and refuses a short one", () => {
    expect(hlKeyOf(`0x${"22".repeat(32)}`, H.address)).not.toBe(crosscheck.hlKey);
    expect(() => hlKeyOf("0x1111", H.address)).toThrow(RangeError);
  });
});

describe("challenge", () => {
  it("hands out plain-JSON typed data for the UI, valid 15 minutes", async () => {
    const c = await challenge();
    expect(c.typedData.domain).toEqual({ name: "HYPE Passport", version: "1", verifyingContract: REGISTRY });
    expect(c.typedData.domain).not.toHaveProperty("chainId");
    expect(c.typedData.message).toMatchObject({ hyperliquidAccount: H.address, elysiumAccount: E.address, chainId: 99801, deadline: NOW + 900 });
    expect(c.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(JSON.parse(JSON.stringify(c.typedData))).toEqual(c.typedData);
  });

  it("issues a fresh random nonce each time", async () => {
    expect((await challenge()).nonce).not.toBe((await challenge()).nonce);
  });

  it("refuses API wallets, vaults and multi-sigs before anyone signs", async () => {
    await expect(createChallenge(deps, { hyperliquidAccount: AGENT.address, elysiumAccount: E.address }, NOW)).resolves.toEqual({
      ok: false,
      error: "AGENT_WALLET",
      master: H.address.toLowerCase(),
    });
    roles.set(STRANGER.address.toLowerCase(), { role: "vault" });
    await expect(createChallenge(deps, { hyperliquidAccount: STRANGER.address, elysiumAccount: E.address }, NOW)).resolves.toMatchObject({
      error: "NOT_A_SIGNING_ACCOUNT",
    });
    multisigs.set(H.address.toLowerCase(), { authorizedUsers: [E.address], threshold: 1 });
    await expect(createChallenge(deps, { hyperliquidAccount: H.address, elysiumAccount: E.address }, NOW)).resolves.toEqual({
      ok: false,
      error: "MULTISIG_UNSUPPORTED",
    });
  });

  it.each([
    [{ hyperliquidAccount: "0x1234", elysiumAccount: E.address }, "hyperliquidAccount"],
    [{ hyperliquidAccount: H.address, elysiumAccount: "0x0000000000000000000000000000000000000000" }, "elysiumAccount"],
  ])("refuses a bad address %#", async (input, field) => {
    await expect(createChallenge(deps, input, NOW)).resolves.toEqual({ ok: false, error: "INVALID_ADDRESS", field });
  });
});

describe("verify (§13 P4)", () => {
  it("accepts H and E signing the same typed data (as the UI sends it, via JSON)", async () => {
    const c = await challenge();
    const td = JSON.parse(JSON.stringify(c.typedData));
    const r = await verifyLink(deps, { nonce: c.nonce, hlSignature: await H.signTypedData(toSignable(td)), elysiumSignature: await E.signTypedData(toSignable(td)) }, NOW);
    expect(r).toMatchObject({ ok: true, hyperliquidAccount: H.address, elysiumAccount: E.address });
  });

  it("needs one signature when E == H", async () => {
    const c = await challenge(H.address, H.address);
    const r = await verifyLink(deps, { nonce: c.nonce, hlSignature: await H.signTypedData(toSignable(c.typedData)) }, NOW);
    expect(r).toMatchObject({ ok: true, elysiumSignature: null });
  });

  it("refuses swapped signatures", async () => {
    const c = await challenge();
    const r = await verifyLink(deps, { nonce: c.nonce, hlSignature: await E.signTypedData(toSignable(c.typedData)), elysiumSignature: await H.signTypedData(toSignable(c.typedData)) }, NOW);
    expect(r).toEqual({ ok: false, error: "BAD_HL_SIGNATURE" });
  });

  it("refuses a missing or foreign Elysium signature", async () => {
    const c = await challenge();
    const hlSignature = await H.signTypedData(toSignable(c.typedData));
    await expect(verifyLink(deps, { nonce: c.nonce, hlSignature }, NOW)).resolves.toEqual({ ok: false, error: "BAD_ELYSIUM_SIGNATURE" });
    const elysiumSignature = await STRANGER.signTypedData(toSignable(c.typedData));
    await expect(verifyLink(deps, { nonce: c.nonce, hlSignature, elysiumSignature }, NOW)).resolves.toEqual({ ok: false, error: "BAD_ELYSIUM_SIGNATURE" });
  });

  it("refuses a signature over another verifyingContract", async () => {
    const c = await challenge();
    const other = { ...c.typedData, domain: passportDomain("0x000000000000000000000000000000000000dEaD") };
    const r = await verifyLink(deps, { nonce: c.nonce, hlSignature: await H.signTypedData(toSignable(other)), elysiumSignature: await E.signTypedData(toSignable(other)) }, NOW);
    expect(r).toEqual({ ok: false, error: "BAD_HL_SIGNATURE" });
  });

  it("refuses a signature with another chainId in the message", async () => {
    const c = await challenge();
    const other = { ...c.typedData, message: { ...c.typedData.message, chainId: 999 } };
    const r = await verifyLink(deps, { nonce: c.nonce, hlSignature: await H.signTypedData(toSignable(other)), elysiumSignature: await E.signTypedData(toSignable(other)) }, NOW);
    expect(r).toEqual({ ok: false, error: "BAD_HL_SIGNATURE" });
  });

  it("refuses a tampered elysiumAccount (the server rebuilds the message)", async () => {
    const c = await challenge();
    const other = { ...c.typedData, message: { ...c.typedData.message, elysiumAccount: STRANGER.address } };
    const r = await verifyLink(deps, { nonce: c.nonce, hlSignature: await H.signTypedData(toSignable(other)), elysiumSignature: await STRANGER.signTypedData(toSignable(other)) }, NOW);
    expect(r).toEqual({ ok: false, error: "BAD_HL_SIGNATURE" });
  });

  it("refuses the master's API wallet signing for it", async () => {
    const c = await challenge();
    const r = await verifyLink(deps, { nonce: c.nonce, hlSignature: await AGENT.signTypedData(toSignable(c.typedData)), elysiumSignature: await E.signTypedData(toSignable(c.typedData)) }, NOW);
    expect(r).toEqual({ ok: false, error: "BAD_HL_SIGNATURE" });
  });

  it("expires after 15 minutes (the deadline second itself still counts)", async () => {
    const c = await challenge();
    const sigs = { hlSignature: await H.signTypedData(toSignable(c.typedData)), elysiumSignature: await E.signTypedData(toSignable(c.typedData)) };
    await expect(verifyLink(deps, { nonce: c.nonce, ...sigs }, NOW + 901)).resolves.toEqual({ ok: false, error: "CHALLENGE_EXPIRED" });
    await expect(verifyLink(deps, { nonce: c.nonce, ...sigs }, NOW + 900)).resolves.toMatchObject({ ok: true });
  });

  it("is single-use, even when two verifies race", async () => {
    const c = await challenge();
    const input = { nonce: c.nonce, hlSignature: await H.signTypedData(toSignable(c.typedData)), elysiumSignature: await E.signTypedData(toSignable(c.typedData)) };
    const results = await Promise.all([verifyLink(deps, input, NOW), verifyLink(deps, input, NOW)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    await expect(verifyLink(deps, input, NOW)).resolves.toEqual({ ok: false, error: "CHALLENGE_USED" });
  });

  it("does not burn the challenge on a bad signature", async () => {
    const c = await challenge();
    const elysiumSignature = await E.signTypedData(toSignable(c.typedData));
    await expect(verifyLink(deps, { nonce: c.nonce, hlSignature: await STRANGER.signTypedData(toSignable(c.typedData)), elysiumSignature }, NOW)).resolves.toMatchObject({
      ok: false,
    });
    await expect(verifyLink(deps, { nonce: c.nonce, hlSignature: await H.signTypedData(toSignable(c.typedData)), elysiumSignature }, NOW)).resolves.toMatchObject({
      ok: true,
    });
  });

  it("answers garbage without throwing", async () => {
    const c = await challenge();
    await expect(verifyLink(deps, { nonce: c.nonce, hlSignature: "0xdeadbeef" }, NOW)).resolves.toEqual({ ok: false, error: "BAD_HL_SIGNATURE" });
    await expect(verifyLink(deps, { nonce: c.nonce, hlSignature: "not hex" }, NOW)).resolves.toEqual({ ok: false, error: "BAD_HL_SIGNATURE" });
    await expect(verifyLink(deps, { nonce: "0x12", hlSignature: "0x" }, NOW)).resolves.toEqual({ ok: false, error: "CHALLENGE_NOT_FOUND" });
    await expect(verifyLink(deps, { nonce: `0x${"ab".repeat(32)}` as Hex, hlSignature: "0x" }, NOW)).resolves.toEqual({
      ok: false,
      error: "CHALLENGE_NOT_FOUND",
    });
  });
});

describe("challenge store", () => {
  it("purges expired challenges", async () => {
    await challenge();
    expect(deps.store.purgeExpired(NOW + 901)).toBe(1);
  });
});
