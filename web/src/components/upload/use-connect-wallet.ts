"use client";

// One Connect button. It goes straight to the wallet in this browser when there is one (Rabby,
// MetaMask, any wallet that announces itself); otherwise to WalletConnect's list, which on a phone
// opens the wallet app. "Use a phone wallet" (computers only) goes to WalletConnect's QR code.

import { useState } from "react";
import { useConnect, useConnectors, type Connector } from "wagmi";
import { reason } from "@/components/app/shared";

/** The one browser wallet if exactly one announced itself (EIP-6963), else whichever answers as window.ethereum. */
function browserWallet(connectors: readonly Connector[]) {
  const announced = connectors.filter((c) => c.type === "injected" && c.id !== "injected");
  if (announced.length === 1) return announced[0];
  if ("ethereum" in window) return connectors.find((c) => c.id === "injected");
  return announced[0];
}

export function useConnectWallet() {
  const connectors = useConnectors();
  const connect = useConnect();
  const [used, setUsed] = useState<Connector | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const phone = connectors.find((c) => c.type === "walletConnect");

  const open = (way: "wallet" | "phone") => {
    setNotice(null);
    const connector = way === "phone" ? phone : (browserWallet(connectors) ?? phone ?? connectors.find((c) => c.id === "injected"));
    if (!connector) {
      setNotice("Phone wallets aren’t switched on here yet.");
      return;
    }
    setUsed(connector);
    connect.mutate({ connector });
  };

  // Closing WalletConnect's window is a choice, not a failure: no message for it.
  const closed = used?.type === "walletConnect" && /rejected|reset/i.test(connect.error?.message ?? "");
  return {
    open,
    busy: connect.isPending,
    /** Waiting on a wallet app (phone or QR) rather than this browser's wallet. */
    viaApp: used?.type === "walletConnect",
    error: notice ?? (connect.error && !closed ? reason(connect.error) : null),
    hasPhone: !!phone,
  };
}
