"use client";

import { Providers } from "@/components/app/providers";
import { WalletBar } from "@/components/app/shared";
import s from "./upload.module.css";

/** Placeholder for the upload flow: the wallet connect from the app screens, nothing to sign yet. */
export function UploadApp() {
  return (
    <main className={s.page}>
      <div className={s.art} role="img" aria-label="Caspian as an uploaded intelligence, drawn in PANTHEON's code" />
      <div>
        <p className={s.eyebrow}>Get uploaded</p>
        <h1 className={s.h1}>DELPHI is ready to build your self.</h1>
        <p className={s.sub}>Connect a wallet to begin. Nothing to sign yet.</p>
        <div className={s.wallet}>
          <Providers>
            <WalletBar />
          </Providers>
        </div>
      </div>
    </main>
  );
}
