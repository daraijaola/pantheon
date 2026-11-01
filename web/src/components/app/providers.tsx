"use client";

import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider, type Config } from "wagmi";
import { wagmiConfig } from "@/lib/chain/config";

/** Wallet and chain context, loaded only on the app screens (the landing page stays light).
 * `config`: a screen with its own wallets (/upload adds phone wallets) passes its own. */
export function Providers({ children, config = wagmiConfig }: { children: ReactNode; config?: Config }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 4_000 } } }));
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
