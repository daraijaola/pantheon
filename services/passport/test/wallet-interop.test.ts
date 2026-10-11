// The browser path, offline: the UI's JSON → viem/wagmi signTypedData → an EIP-1193 provider that
// signs like MetaMask's keyring (@metamask/eth-sig-util V4) → our verifyLink.
// On 2026-10-11 the same flow also ran through MetaMask's real request validation
// (@metamask/signature-controller 40.0.0), with the HL wallet on HyperEVM, Arbitrum and Ethereum.
import { SignTypedDataVersion, signTypedData } from "@metamask/eth-sig-util";
import { createWalletClient, custom, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { openDatabase, SqliteChallengeStore } from "../src/db.ts";
import { toSignable } from "../src/eip712.ts";
import { createChallenge, verifyLink } from "../src/link.ts";

const MNEMONIC = "test test test test test test test test test test test junk"; // anvil's public test keys
const H = mnemonicToAccount(MNEMONIC, { addressIndex: 1 });
const E = mnemonicToAccount(MNEMONIC, { addressIndex: 2 });
const keys = new Map([H, E].map((a) => [a.address.toLowerCase(), Buffer.from(a.getHdKey().privateKey!)]));
const NOW = 1_791_680_000;

/** Requests the wallet received, so tests can inspect exactly what a real wallet would see. */
const received: Array<{ from: string; data: string }> = [];

function walletOn(chainHex: Hex) {
  return custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      if (method === "eth_chainId") return chainHex;
      if (method !== "eth_signTypedData_v4") throw new Error(`unsupported ${method}`);
      const [from, data] = params as [string, string];
      received.push({ from, data });
      const typed = JSON.parse(data);
      // MetaMask (validation.js:106-116) and Rabby (provider/controller.ts:418-427) refuse a domain
      // chainId that differs from the active chain. Ours must never carry one.
      if (typed.domain.chainId !== undefined && Number(typed.domain.chainId) !== Number(chainHex)) {
        throw new Error(`Provided chainId "${typed.domain.chainId}" must match the active chainId "${Number(chainHex)}"`);
      }
      return signTypedData({ privateKey: keys.get(from.toLowerCase())!, data: typed, version: SignTypedDataVersion.V4 });
    },
  });
}

async function linkVia(hlChain: Hex) {
  const deps = {
    store: new SqliteChallengeStore(openDatabase(":memory:")),
    registry: "0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f" as const,
    hl: { userRole: async () => ({ role: "user" }), userToMultiSigSigners: async () => null },
  };
  const c = await createChallenge(deps, { hyperliquidAccount: H.address, elysiumAccount: E.address }, NOW);
  if (!c.ok) throw new Error(c.error);
  const td = toSignable(JSON.parse(JSON.stringify(c.typedData))); // what the UI receives, then converts
  const sign = (account: typeof H, chain: Hex) =>
    createWalletClient({ account: account.address, transport: walletOn(chain) }).signTypedData({ account: account.address, ...td });
  const hlSignature = await sign(H, hlChain);
  const elysiumSignature = await sign(E, "0x185d9"); // the Elysium wallet sits on Elysium (99801)
  return verifyLink(deps, { nonce: c.nonce, hlSignature, elysiumSignature }, NOW);
}

describe("wallet interop (MetaMask's signer through viem/wagmi)", () => {
  it.each([
    ["HyperEVM", "0x3e7"],
    ["Arbitrum", "0xa4b1"],
    ["Ethereum", "0x1"],
  ] as const)("links with the HL wallet connected to %s, no network switch", async (_name, chain) => {
    await expect(linkVia(chain)).resolves.toMatchObject({ ok: true });
  });

  it("sends wallets a domain and EIP712Domain type without chainId", async () => {
    received.length = 0;
    await linkVia("0x3e7");
    const typed = JSON.parse(received[0]!.data);
    // viem lowercases addresses when serialising; the EIP-712 hash is the same either way.
    expect(typed.domain).toEqual({ name: "HYPE Passport", version: "1", verifyingContract: "0x5615deb798bb3e4dfa0139dfa1b3d433cc23b72f" });
    expect(typed.types.EIP712Domain.map((f: { name: string }) => f.name)).toEqual(["name", "version", "verifyingContract"]);
    expect(typed.message.chainId).toBe("99801");
    expect(typed.message.purpose).toMatch(/no funds move/);
  });
});
