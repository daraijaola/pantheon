"use client";

// /upload's steps, all on DELPHI's orb (upload-orb.tsx): connect a wallet, sign one free message,
// DELPHI reads the wallet and your self splits into bubbles, then your space. The orb stays put from
// the first second: connecting or signing changes the words and the button under it, not the page.
//
// The read is the designed 24-second sequence for now. DELPHI's real scan streams its stages from the
// Get uploaded service (`/wallets/{address}/scan`), which stays private until sign-in is decided; the
// signature asked for here is the one that sign-in will check.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { stringToHex, UserRejectedRequestError } from "viem";
import { useConfig, useDisconnect } from "wagmi";
import { useHydratedConnection } from "@/lib/use-hydrated-connection";
import { signMessage } from "wagmi/actions";
import { reason } from "@/components/app/shared";
import { useSession } from "@/components/app/auth-session";
import { logoutSession, prepareSignIn, verifySignIn } from "@/lib/auth-client";
import { UploadNext, UploadOrb, type Picked } from "./upload-orb";
import { isRejected } from "./elysium-switch";
import { useConnectWallet } from "./use-connect-wallet";
import { CHOICE_KEY, isIos, isMobile, openWallet, signOnSession, store, walletLink, type PeerRedirect, type PhoneProvider } from "./wallet-link";

/** The wallet context for all of /upload, and the step it's on. */
export function UploadFlow() {
  return <Steps />;
}

const noSubscribe = () => () => {};
const onPhone = () => isMobile(navigator.userAgent, navigator.maxTouchPoints);

function Steps() {
  const { address, status, connector } = useHydratedConnection();
  const disconnect = useDisconnect();
  const wallet = useConnectWallet();
  const config = useConfig();
  const client = useQueryClient();
  const session = useSession();
  const attempt = useRef(0);
  useEffect(() => {
    attempt.current++;
    if (!address) return;
    void client.prefetchQuery({ queryKey: ["auth", "nonce", address], queryFn: () => prepareSignIn(address), staleTime: 120_000 });
  }, [address, client]);
  // Signing needs no chain, so it never switches. wagmi's signMessage would: for a WalletConnect wallet it
  // asks to switch to the chain the wallet is already on, which fails when that chain (say, Ethereum) isn't
  // Elysium. So a phone wallet gets personal_sign straight from its provider, on whatever chain its
  // session is on. Browser wallets sign through wagmi, as before.
  const sign = useMutation({
    mutationFn: async ({ by }: { by: `0x${string}` }) => {
      const id = ++attempt.current;
      const current = () => {
        const state = config.state;
        return attempt.current === id && state.connections.get(state.current ?? "")?.accounts[0]?.toLowerCase() === by.toLowerCase();
      };
      const message = await client.fetchQuery({ queryKey: ["auth", "nonce", by], queryFn: () => prepareSignIn(by), staleTime: 120_000 });
      if (!current()) throw new Error("Wallet changed. Sign again to go on.");
      let signature: string;
      try {
        if (connector?.type !== "walletConnect") signature = await signMessage(config, { message, connector });
        else {
          const provider = (await connector.getProvider()) as PhoneProvider;
          const result = await signOnSession(provider, { method: "personal_sign", params: [stringToHex(message), by] });
          if (typeof result !== "string") throw new Error("Wallet returned an invalid signature.");
          signature = result;
        }
      } catch (e) {
        throw isRejected(e) ? new UserRejectedRequestError(e as Error) : e;
      }
      if (!current()) throw new Error("Wallet changed. Sign again to go on.");
      const verified = await verifySignIn(message, signature);
      if (!current()) {
        await logoutSession();
        throw new Error("Wallet changed. Sign again to go on.");
      }
      client.setQueryData(["me", "session"], verified.wallet);
      await client.invalidateQueries({ queryKey: ["me"] });
    },
    onSettled: () => client.removeQueries({ queryKey: ["auth", "nonce"] }),
  });
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

  const connected = status === "connected" && address ? address : null;
  const signed = !!connected && session.data?.toLowerCase() === connected.toLowerCase();
  if (connected && signed && picked?.by === connected) return <UploadNext address={connected} />;
  // Closing the wallet's window is a choice, not a failure, but say what happens next.
  const signError = sign.error
    ? reason(sign.error).replace("You cancelled it in your wallet.", "You closed it in your wallet. Sign to go on.")
    : sign.isPending && noLink
      ? "Open your wallet app to sign."
      : null;

  // Everything up to opening the wallet runs in the tap itself, with no await, so the phone lets it open.
  const onSign = () => {
    if (!connected) return;
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
      { by: connected },
      {
        onSettled: () => {
          if (choice && !store.get(CHOICE_KEY)) store.set(CHOICE_KEY, choice);
        },
      },
    );
    if (link) openWallet(link);
  };

  return (
    <UploadOrb
      // One orb for the whole visit. A different wallet starts over inside it: it has to sign for itself.
      address={connected}
      connecting={wallet.busy}
      connectViaApp={wallet.viaApp}
      connectError={wallet.error}
      connectMessage={wallet.message}
      onRetryConnect={wallet.retry}
      onCancelConnect={wallet.cancel}
      onConnect={() => wallet.open("wallet")}
      onPhoneWallet={wallet.hasPhone ? () => wallet.open("phone") : null}
      wallets={wallet.choices}
      onPickWallet={wallet.pick}
      onCancelPick={wallet.cancelPick}
      signed={signed}
      signing={sign.isPending}
      reopen={viaApp && sign.isPending}
      signError={signError}
      onSign={onSign}
      onOtherWallet={() => {
        // Lets go of a request still open in the wallet: if it's signed later, nothing here hears it. And
        // a signature only ever counts for the wallet it was asked of, checked against the current connection.
        sign.reset();
        attempt.current++;
        disconnect.mutate();
      }}
      onContinue={(bubble) => connected && setPicked({ by: connected, bubble })}
    />
  );
}
