import { defineChain } from "viem";
import { createConfig, http } from "wagmi";
import { injected, mock, walletConnect } from "wagmi/connectors";
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

const deploymentName = process.env.NEXT_PUBLIC_DEPLOYMENT ?? "elysium-testnet";
export const deployment = DEPLOYMENTS[deploymentName] ?? null;

/** A block just before the contracts were deployed: event history (like the coins on Covenant) is read from here. */
export const deployedFrom: bigint = deploymentName === "elysium-testnet" ? 9_127_000n : 9_100_000n;

export const explorer = (kind: "tx" | "address" | "token", value: string) =>
  `${elysium.blockExplorers.default.url}/${kind}/${value}`;

// Dev only: a fixed test wallet on the private chain, so screens can be tested without a browser wallet.
const devWallet = process.env.NEXT_PUBLIC_DEV_WALLET as `0x${string}` | undefined;

// WalletConnect (Reown) project id, from dashboard.reown.com. It switches on "Scan with your phone";
// without it that button says phone wallets aren't on yet. Public by design (it ships to the browser).
const projectId = process.env.NEXT_PUBLIC_WC_PROJECT_ID;

/** Phone wallets. Browser only: WalletConnect starts up as soon as it's configured, and the server has
 * no use for it. Wallets check the site they show against the page it connects from. */
function phoneWallets(projectId: string, origin: string) {
  return walletConnect({
    projectId,
    metadata: {
      name: "PANTHEON",
      description: "Get uploaded. DELPHI reads your wallet and builds a space that is yours.",
      url: origin,
      icons: [`${origin}/upload/delphi.png`],
    },
    // Its QR window in our colours and type: ink on paper, Geist.
    qrModalOptions: {
      themeMode: "light",
      themeVariables: {
        "--wcm-accent-color": "#171717",
        "--wcm-font-family": "var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif",
      },
    },
  });
}

export const wagmiConfig = createConfig({
  chains: [elysium],
  connectors: [
    ...(devWallet ? [mock({ accounts: [devWallet], features: { reconnect: true } })] : []),
    injected(),
    ...(projectId && typeof window !== "undefined" ? [phoneWallets(projectId, window.location.origin)] : []),
  ],
  transports: { [elysium.id]: http() },
  ssr: true,
});
