"use client";

// One Connect button. It goes straight to the wallet in this browser when there is one (Rabby,
// MetaMask, any wallet that announces itself); otherwise to WalletConnect's list, which on a phone
// opens the wallet app. "Use a phone wallet" (computers only) goes to WalletConnect's QR code.
// With two or more wallets in this browser (say Rabby and MetaMask), Connect lists them to pick from.

import { useEffect, useRef, useState } from "react";
import { useConnect, useConnectors, type Connector } from "wagmi";
import { reason } from "@/components/app/shared";

/** How long WalletConnect gets to show its QR code (or hand off to the wallet app) before we say it can't. */
const QR_WAIT_MS = 12_000;
const NO_RELAY = "Phone wallets can’t reach WalletConnect from this network. Try mobile data or another network, or a browser wallet.";
type WalletConnectProvider = { modal?: { close?: () => void } };

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
  const phone = connectors.find((c) => c.type === "walletConnect");
  const announced = announcedWallets(connectors);
  const qrTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Done one way or another (connected, closed, refused): nothing left to wait for.
  useEffect(() => {
    if (connect.isPending || !qrTimer.current) return;
    clearTimeout(qrTimer.current);
    qrTimer.current = null;
  }, [connect.isPending]);
  useEffect(
    () => () => {
      if (qrTimer.current) clearTimeout(qrTimer.current);
    },
    [],
  );

  // WalletConnect shows its QR code (or opens the wallet app) once its relay answers. Some networks block
  // the relay (a DNS filter, a VPN), and its window then stays blank for good: close it and say why.
  const watchQr = (connector: Connector) => {
    if (qrTimer.current) clearTimeout(qrTimer.current);
    const ready = (m: { type: string }) => {
      if (m.type !== "display_uri") return;
      if (qrTimer.current) clearTimeout(qrTimer.current);
      qrTimer.current = null;
      connector.emitter.off("message", ready);
    };
    connector.emitter.on("message", ready);
    qrTimer.current = setTimeout(() => {
      qrTimer.current = null;
      connector.emitter.off("message", ready);
      setNotice(NO_RELAY);
      connector
        .getProvider()
        .then((p) => (p as WalletConnectProvider | undefined)?.modal?.close?.())
        .catch(() => {});
    }, QR_WAIT_MS);
  };

  const connectWith = (connector: Connector) => {
    setChoosing(false);
    setUsed(connector);
    if (connector.type === "walletConnect") watchQr(connector);
    connect.mutate({ connector });
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
    connectWith(connector);
  };

  const pick = (id: string) => {
    const connector = announced.find((c) => c.id === id);
    if (connector) connectWith(connector);
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
    /** The wallets to pick from, while the user is choosing; null otherwise. */
    choices: choosing && announced.length > 1 ? announced.map((c): WalletChoice => ({ id: c.id, name: c.name, icon: safeIcon(c.icon) })) : null,
    pick,
    cancelPick: () => setChoosing(false),
  };
}
