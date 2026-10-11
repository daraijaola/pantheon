// Reads HypePassportRegistry on Elysium (spec §6) and mirrors its binding rules, so the service
// never signs an attestation that `submit` would revert on.
import { createPublicClient, defineChain, http, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { ELYSIUM_TESTNET_CHAIN_ID, type Config } from "./config.ts";

export const registryAbi = parseAbi([
  "struct Passport { bytes32 hlKey; uint8 tier; uint32 stamps; uint64 issuedAt; uint64 expiry; uint64 linkedAt; }",
  "struct Attestation { address account; bytes32 hlKey; uint8 tier; uint32 stamps; uint64 issuedAt; uint64 expiry; uint64 deadline; uint256 chainId; }",
  "function passportOf(address account) view returns (Passport)",
  "function isValid(address account) view returns (bool)",
  "function multiplierOf(address account) view returns (uint256)",
  "function accountOfHlKey(bytes32 hlKey) view returns (address)",
  "function rebindableAt(bytes32 hlKey) view returns (uint64)",
  "function lastIssuedAt(address account) view returns (uint64)",
  "function retired() view returns (bool)",
  "function submit(Attestation a, bytes sig)",
  "function unlink()",
  "event PassportIssued(address indexed account, bytes32 indexed hlKey, uint8 tier, uint32 stamps, uint64 issuedAt, uint64 expiry)",
  "event Unlinked(address indexed account, bytes32 indexed hlKey, uint64 rebindableAt)",
]);

/** Matches HypePassportRegistry.REBIND_COOLDOWN: also how long an expired binding blocks rebinding. */
export const REBIND_COOLDOWN_SEC = 7 * 86_400;

export const elysiumTestnet = (rpc: string) =>
  defineChain({
    id: ELYSIUM_TESTNET_CHAIN_ID,
    name: "Elysium Testnet",
    nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
    contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
  });

export type OnChainPassport = {
  hlKey: Hex;
  tier: number;
  stamps: number;
  issuedAt: number;
  expiry: number;
  linkedAt: number;
};

export interface RegistryReader {
  readonly address: Address;
  passportOf(account: Address): Promise<OnChainPassport & { valid: boolean; multiplier: bigint }>;
  accountOfHlKey(hlKey: Hex): Promise<Address>;
  rebindableAt(hlKey: Hex): Promise<number>;
  lastIssuedAt(account: Address): Promise<number>;
  blockNumber(): Promise<bigint>;
}

export function createRegistryReader(client: PublicClient, address: Address): RegistryReader {
  const read = <T>(functionName: string, args: readonly unknown[]) =>
    client.readContract({ address, abi: registryAbi, functionName, args } as never) as Promise<T>;
  return {
    address,
    async passportOf(account) {
      const [p, valid, multiplier] = await Promise.all([
        read<{ hlKey: Hex; tier: number; stamps: number; issuedAt: bigint; expiry: bigint; linkedAt: bigint }>("passportOf", [account]),
        read<boolean>("isValid", [account]),
        read<bigint>("multiplierOf", [account]),
      ]);
      return {
        hlKey: p.hlKey,
        tier: p.tier,
        stamps: p.stamps,
        issuedAt: Number(p.issuedAt),
        expiry: Number(p.expiry),
        linkedAt: Number(p.linkedAt),
        valid,
        multiplier,
      };
    },
    accountOfHlKey: (hlKey) => read<Address>("accountOfHlKey", [hlKey]),
    rebindableAt: async (hlKey) => Number(await read<bigint>("rebindableAt", [hlKey])),
    lastIssuedAt: async (account) => Number(await read<bigint>("lastIssuedAt", [account])),
    blockNumber: () => client.getBlockNumber(),
  };
}

export function createElysiumClient(config: Config): PublicClient {
  // Multicall batching keeps a GET /passport/:address to one RPC request.
  return createPublicClient({ chain: elysiumTestnet(config.elysiumRpc), transport: http(config.elysiumRpc, { timeout: 10_000 }), batch: { multicall: true } });
}

const ZERO_KEY = `0x${"00".repeat(32)}`;

export type BindingConflict = "ACCOUNT_ALREADY_LINKED" | "HL_ALREADY_LINKED" | "REBIND_COOLDOWN";

/**
 * The registry's `submit` binding rules (§6.2), read-only: can `account` take `hlKey` now?
 * A binding whose passport expired ≥ 7 days ago no longer blocks (it auto-frees on submit).
 */
export async function bindingConflict(
  reg: RegistryReader,
  account: Address,
  hlKey: Hex,
  nowSec: number,
): Promise<{ conflict: BindingConflict; until?: number } | null> {
  const [mine, holder] = await Promise.all([reg.passportOf(account), reg.accountOfHlKey(hlKey)]);
  if (mine.hlKey !== ZERO_KEY && mine.hlKey.toLowerCase() !== hlKey.toLowerCase() && mine.expiry + REBIND_COOLDOWN_SEC > nowSec) {
    return { conflict: "ACCOUNT_ALREADY_LINKED" };
  }
  if (holder.toLowerCase() !== account.toLowerCase()) {
    if (holder !== "0x0000000000000000000000000000000000000000") {
      const theirs = await reg.passportOf(holder);
      if (theirs.expiry + REBIND_COOLDOWN_SEC > nowSec) return { conflict: "HL_ALREADY_LINKED" };
    } else {
      const until = await reg.rebindableAt(hlKey);
      if (nowSec < until) return { conflict: "REBIND_COOLDOWN", until };
    }
  }
  return null;
}
