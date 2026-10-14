import { defineChain } from "viem";
import { createConfig, http } from "wagmi";
import { injected, mock } from "wagmi/connectors";
import { DEPLOYMENTS } from "./deployments";

/** Elysium testnet: Hyperliquid's first L2, where Ascend runs. */
export const elysium = defineChain({
  id: 99801,
  name: "Elysium Testnet",
  nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
  rpcUrls: { default: { http: [process.env.NEXT_PUBLIC_RPC_URL ?? "https://testnet-rpc.elysium.kinetiq.xyz"] } },
  blockExplorers: { default: { name: "Elysium explorer", url: "https://elysium.kinetiq.xyz/testnet-explorer" } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
  testnet: true,
});

export const deployment = DEPLOYMENTS[process.env.NEXT_PUBLIC_DEPLOYMENT ?? "elysium-testnet"] ?? null;

export const explorer = (kind: "tx" | "address" | "token", value: string) =>
  `${elysium.blockExplorers.default.url}/${kind}/${value}`;

// Dev only: a fixed test wallet on the private chain, so screens can be tested without a browser wallet.
const devWallet = process.env.NEXT_PUBLIC_DEV_WALLET as `0x${string}` | undefined;

export const wagmiConfig = createConfig({
  chains: [elysium],
  connectors: devWallet ? [mock({ accounts: [devWallet], features: { reconnect: true } }), injected()] : [injected()],
  transports: { [elysium.id]: http() },
  ssr: true,
});
