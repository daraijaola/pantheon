"use client";

// /upload's steps: connect (the split page, passed in as children), then sign one free message, then
// DELPHI reads the wallet and your self splits into bubbles (upload-orb.tsx), then your space.
//
// The read is the designed 24-second sequence for now. DELPHI's real scan streams its stages from the
// Get uploaded service (`/wallets/{address}/scan`), which stays private until sign-in is decided; the
// signature asked for here is the one that sign-in will check.

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { stringToHex, UserRejectedRequestError } from "viem";
import { useConfig, useConnection, useDisconnect } from "wagmi";
import { signMessage } from "wagmi/actions";
import { Providers } from "@/components/app/providers";
import { reason } from "@/components/app/shared";
import { uploadConfig } from "./upload-config";
import { UploadNext, UploadOrb, type Picked } from "./upload-orb";
import { isRejected } from "./elysium-switch";
import { CHOICE_KEY, isIos, isMobile, openWallet, signOnSession, store, walletLink, type PeerRedirect, type PhoneProvider } from "./wallet-link";

/** The message the wallet shows. Free: signing it sends nothing and pays no fee. */
function message(address: string) {
  return [
    "PANTHEON · Get uploaded",
    "",
    "Sign to let DELPHI read this wallet and build your space.",
    "Free: nothing is sent and no fee is paid.",
    "",
    `Wallet: ${address}`,
    `Time: ${new Date().toISOString()}`,
  ].join("\n");
}

/** The wallet context for all of /upload, and the step it's on. `children` is the connect page. */
export function UploadFlow({ children }: { children: ReactNode }) {
  return (
    <Providers config={uploadConfig}>
      <Steps>{children}</Steps>
    </Providers>
  );
}

const noSubscribe = () => () => {};
const onPhone = () => isMobile(navigator.userAgent, navigator.maxTouchPoints);

function Steps({ children }: { children: ReactNode }) {
  const { address, status, connector } = useConnection();
  const disconnect = useDisconnect();
  const config = useConfig();
  // Signing needs no chain, so it never switches. wagmi's signMessage would: for a WalletConnect wallet it
  // asks to switch to the chain the wallet is already on, which fails when that chain (say, Ethereum) isn't
  // Elysium. So a phone wallet gets personal_sign straight from its provider, on whatever chain its
  // session is on. Browser wallets sign through wagmi, as before.
  const sign = useMutation({
    mutationFn: async ({ message }: { message: string }) => {
      if (connector?.type !== "walletConnect") return signMessage(config, { message, connector });
      const provider = (await connector.getProvider()) as PhoneProvider;
      try {
        return await signOnSession(provider, { method: "personal_sign", params: [stringToHex(message), address] });
      } catch (e) {
        throw isRejected(e) ? new UserRejectedRequestError(e as Error) : e;
      }
    },
  });
  const [signedBy, setSignedBy] = useState<string | null>(null);
  const [picked, setPicked] = useState<{ by: string; bubble: Picked } | null>(null);
  // A phone wallet over WalletConnect signs in its own app: the tap on Sign has to open it (wallet-link.ts).
  // Browser wallets, and wallets' in-app browsers, are injected and sign in place, as before.
  const phone = useSyncExternalStore(noSubscribe, onPhone, () => false);
  const viaApp = phone && connector?.type === "walletConnect";
  const [noLink, setNoLink] = useState(false);
  const peer = useRef<PeerRedirect>(undefined);
  useEffect(() => {
    peer.current = undefined;
    if (!viaApp || !connector) return;
    let live = true;
    connector
      .getProvider()
      .then((p) => {
        const session = (p as { session?: { peer?: { metadata?: { redirect?: PeerRedirect } } } } | undefined)?.session;
        if (live) peer.current = session?.peer?.metadata?.redirect;
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [viaApp, connector, address]);

  if (status !== "connected" || !address) return children;
  if (picked?.by === address) return <UploadNext address={address} />;

  const signed = signedBy === address;
  // Closing the wallet's window is a choice, not a failure, but say what happens next.
  const signError = sign.error
    ? reason(sign.error).replace("You cancelled it in your wallet.", "You closed it in your wallet. Sign to go on.")
    : sign.isPending && noLink
      ? "Open your wallet app to sign."
      : null;

  // Everything up to opening the wallet runs in the tap itself, with no await, so the phone lets it open.
  const onSign = () => {
    const link = viaApp ? walletLink(store.get(CHOICE_KEY), peer.current, isIos(navigator.userAgent, navigator.maxTouchPoints)) : null;
    // Already asked: a second tap just opens the wallet again (the request is still waiting there).
    if (sign.isPending) {
      if (link) openWallet(link);
      return;
    }
    setNoLink(viaApp && !link);
    // The SDK would open the wallet again after its awaits; this tap already does, so it skips that.
    const choice = link ? store.get(CHOICE_KEY) : null;
    if (choice) store.remove(CHOICE_KEY);
    sign.mutate(
      { message: message(address) },
      {
        onSuccess: () => setSignedBy(address),
        onSettled: () => {
          if (choice && !store.get(CHOICE_KEY)) store.set(CHOICE_KEY, choice);
        },
      },
    );
    if (link) openWallet(link);
  };

  return (
    <UploadOrb
      // A different wallet starts over: it has to sign for itself.
      key={address}
      address={address}
      signed={signed}
      signing={sign.isPending}
      reopen={viaApp && sign.isPending}
      signError={signError}
      onSign={onSign}
      onOtherWallet={() => {
        sign.reset();
        disconnect.mutate();
      }}
      onContinue={(bubble) => setPicked({ by: address, bubble })}
    />
  );
}
