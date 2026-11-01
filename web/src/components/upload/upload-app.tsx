import Link from "next/link";
import { CodeWordmark } from "@/components/code-type/code-wordmark";
import { Connect } from "./connect";
import { DelphiArt } from "./delphi-art";
import { UploadFlow } from "./upload-flow";
import s from "./upload.module.css";

/**
 * /upload, "Get uploaded". First connect a wallet: a split page, the call on the left, DELPHI on the
 * right. Once a wallet is connected, UploadFlow takes the page: sign, DELPHI reads it, your self.
 */
export function UploadApp() {
  return (
    <UploadFlow>
      <ConnectPage />
    </UploadFlow>
  );
}

function ConnectPage() {
  return (
    <div className={s.page}>
      <header className={s.header}>
        <Link href="/" aria-label="PANTHEON home" className={s.logo}>
          <CodeWordmark text="PANTHEON" module={2.2} />
        </Link>
        <Link href="/" className={s.back}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path d="M8.5 3.5 5 7l3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Back to site
        </Link>
      </header>
      <main className={s.main}>
        <section className={s.left}>
          <div className={s.col}>
            <h1 className={s.h1}>Get uploaded.</h1>
            <p className={s.lede}>Connect your wallet. DELPHI reads it and builds a space that is yours.</p>
            <Connect />
          </div>
        </section>
        <DelphiArt className={s.art} />
      </main>
    </div>
  );
}
