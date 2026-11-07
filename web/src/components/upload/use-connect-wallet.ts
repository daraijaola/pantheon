"use client";

// One Connect button. It goes straight to the wallet in this browser when there is one (Rabby,
// MetaMask, any wallet that announces itself); otherwise to WalletConnect's list, which on a phone
// opens the wallet app. "Use a phone wallet" (computers only) goes to WalletConnect's QR code.
// With two or more wallets in this browser (say Rabby and MetaMask), Connect lists them to pick from.

import { useEffect, useRef, useState } from "react";
import { useConnect, useConnectors, type Connector } from "wagmi";
import { reason } from "@/components/app/shared";
import { walletAttempt, type PairingProvider, type WalletPhase } from "@/lib/wallet-connect-attempt";

/** The one browser wallet if exactly one announced itself (EIP-6963), else whichever answers as window.ethereum. */
const announcedWallets = (connectors: readonly Connector[]) => connectors.filter((c) => c.type === "injected" && c.id !== "injected");

function browserWallet(connectors: readonly Connector[]) {
  const announced = announcedWallets(connectors);
  if (announced.length === 1) return announced[0];
  if ("ethereum" in window) return connectors.find((c) => c.id === "injected");
  return announced[0];
}

/** A wallet in this browser, as it announced itself. The icon only if it's an image data URI (EIP-6963). */
export type WalletChoice = { id: string; name: string; icon: string | null };

const safeIcon = (icon: unknown) => (typeof icon === "string" && /^data:image\/(svg\+xml|png|jpeg|webp|gif)[;,]/i.test(icon) ? icon : null);

export function useConnectWallet() {
  const connectors = useConnectors();
  const connect = useConnect();
  const [used, setUsed] = useState<Connector | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [phase, setPhase] = useState<WalletPhase | null>(null);
  const phone = connectors.find((c) => c.type === "walletConnect");
  const announced = announcedWallets(connectors);
  const attempt = useRef<ReturnType<typeof walletAttempt> | null>(null);
  const generation = useRef(0);
  useEffect(() => () => {
    generation.current++;
    const previous = attempt.current;
    attempt.current = null;
    void previous?.cancel();
  }, []);

  const connectWith = async (connector: Connector) => {
    const id = ++generation.current;
    setPhase("initializing");
    if (attempt.current) await attempt.current.cancel();
    if (generation.current !== id) return;
    attempt.current = null;
    setChoosing(false);
    setUsed(connector);
    setNotice(null);
    connect.reset();
    if (connector.type !== "walletConnect") {
      setPhase(null);
      connect.mutate({ connector });
      return;
    }
    const current = walletAttempt({
      init: () => connector.getProvider() as Promise<PairingProvider>,
      pair: () => connect.mutateAsync({ connector }),
      disconnect: () => connector.disconnect(),
      update: next => { if (generation.current === id) setPhase(next); },
    });
    attempt.current = current;
    setPhase("initializing");
  };

  const open = (way: "wallet" | "phone") => {
    setNotice(null);
    // More than one wallet in this browser: let the user pick rather than take whichever answers first.
    if (way === "wallet" && announced.length > 1) {
      connect.reset();
      setChoosing(true);
      return;
    }
    const connector = way === "phone" ? phone : (browserWallet(connectors) ?? phone ?? connectors.find((c) => c.id === "injected"));
    if (!connector) {
      setNotice("Phone wallets aren’t switched on here yet.");
      return;
    }
    void connectWith(connector);
  };

  const pick = (id: string) => {
    const connector = announced.find((c) => c.id === id);
    if (connector) void connectWith(connector);
  };

  return {
    open,
    busy: phase ? ["initializing", "pairing", "ready"].includes(phase) : connect.isPending,
    /** Waiting on a wallet app (phone or QR) rather than this browser's wallet. */
    viaApp: used?.type === "walletConnect",
    error: notice ?? (phase === "init-failed" ? "WalletConnect couldn’t start. Retry reloads this page so you can connect again." : phase === "relay-failed" ? "WalletConnect’s relay connection failed. Retry, or use a browser wallet." : phase === "failed" ? "WalletConnect couldn’t connect. Retry, or use a browser wallet." : !phase && connect.error ? reason(connect.error) : null),
    message: phase === "slow" ? "Still waiting for WalletConnect. Please try again." : phase === "initializing" ? "Opening WalletConnect…" : null,
    retry: phase === "init-failed" ? () => window.location.reload() : phase === "slow" || phase === "failed" || phase === "relay-failed" ? () => used && void connectWith(used) : null,
    cancel: phase && ["initializing", "pairing", "ready"].includes(phase) ? () => {
      generation.current++;
      setPhase("cancelled");
      void attempt.current?.cancel();
    } : null,
    hasPhone: !!phone,
    /** The wallets to pick from, while the user is choosing; null otherwise. */
    choices: choosing && announced.length > 1 ? announced.map((c): WalletChoice => ({ id: c.id, name: c.name, icon: safeIcon(c.icon) })) : null,
    pick,
    cancelPick: () => setChoosing(false),
  };
}
