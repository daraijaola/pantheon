import { createConfig, http } from "wagmi";
import { injected, walletConnect } from "wagmi/connectors";
import { elysium } from "@/lib/chain/config";

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

/**
 * /upload's wallet config: the browser wallet, like every app screen, plus phone wallets over
 * WalletConnect. Kept apart from the app screens' config so they don't load WalletConnect.
 */
export const uploadConfig = createConfig({
  chains: [elysium],
  connectors: [injected(), ...(projectId && typeof window !== "undefined" ? [phoneWallets(projectId, window.location.origin)] : [])],
  transports: { [elysium.id]: http() },
  ssr: true,
});
