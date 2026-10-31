import type { Metadata } from "next";
import { Suspense } from "react";
import { DisputeForm, DisputeFromLink } from "@/components/delphi/dispute";
import { SiteShell } from "@/components/site-shell";
import s from "@/components/app/app.module.css";

export const metadata: Metadata = {
  title: "Dispute a DELPHI check · PANTHEON",
  description: "Think a DELPHI check is wrong? Say why. A person answers within 24 hours, with the evidence.",
  robots: { index: false, follow: false },
};

export default function Page() {
  return (
    <SiteShell quiet>
      <main className={s.page}>
        <header className={s.head}>
          <div>
            <p className={s.eyebrow}>DELPHI</p>
            <h1 className={s.h1}>Think a check is wrong?</h1>
            <p className={s.sub}>DELPHI reports patterns, never intent, and every check shows its transactions. If it got something wrong, tell us how you know. We fix it, and the coin’s history says what changed.</p>
          </div>
        </header>
        <div className={s.grid}>
          <div className={s.main}>
            <Suspense fallback={<DisputeForm token="" />}>
              <DisputeFromLink />
            </Suspense>
          </div>
        </div>
      </main>
    </SiteShell>
  );
}
