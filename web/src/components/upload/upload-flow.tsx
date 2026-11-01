"use client";

// /upload's steps: connect (the split page, passed in as children), then sign one free message, then
// DELPHI reads the wallet and your self splits into bubbles (upload-orb.tsx), then your space.
//
// The read is the designed 24-second sequence for now. DELPHI's real scan streams its stages from the
// Get uploaded service (`/wallets/{address}/scan`), which stays private until sign-in is decided; the
// signature asked for here is the one that sign-in will check.

import { useState, type ReactNode } from "react";
import { useConnection, useDisconnect, useSignMessage } from "wagmi";
import { Providers } from "@/components/app/providers";
import { reason } from "@/components/app/shared";
import { uploadConfig } from "./upload-config";
import { UploadNext, UploadOrb, type Picked } from "./upload-orb";

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

function Steps({ children }: { children: ReactNode }) {
  const { address, status } = useConnection();
  const disconnect = useDisconnect();
  const sign = useSignMessage();
  const [signedBy, setSignedBy] = useState<string | null>(null);
  const [picked, setPicked] = useState<{ by: string; bubble: Picked } | null>(null);

  if (status !== "connected" || !address) return children;
  if (picked?.by === address) return <UploadNext address={address} />;

  const signed = signedBy === address;
  // Closing the wallet's window is a choice, not a failure, but say what happens next.
  const signError = sign.error ? reason(sign.error).replace("You cancelled it in your wallet.", "You closed it in your wallet. Sign to go on.") : null;

  return (
    <UploadOrb
      // A different wallet starts over: it has to sign for itself.
      key={address}
      address={address}
      signed={signed}
      signing={sign.isPending}
      signError={signError}
      onSign={() => sign.mutate({ message: message(address) }, { onSuccess: () => setSignedBy(address) })}
      onOtherWallet={() => {
        sign.reset();
        disconnect.mutate();
      }}
      onContinue={(bubble) => setPicked({ by: address, bubble })}
    />
  );
}
