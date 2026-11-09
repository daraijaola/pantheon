import type { Metadata } from "next";
import Link from "next/link";
import { SiteShell } from "@/components/site-shell";
import { deployment } from "@/lib/chain/config";
import { ascendBuyUrl } from "@/lib/chain/network-profile";
import s from "@/components/app/app.module.css";

export const metadata: Metadata = { title: "Coming soon on mainnet · PANTHEON", robots: { index: false, follow: false } };

export default function ComingSoon() {
  return (
    <SiteShell quiet>
      <main className={s.page}>
        <header className={s.head}><div>
          <p className={s.eyebrow}>Elysium mainnet</p>
          <h1 className={s.h1}>Coming soon on mainnet</h1>
          <p className={s.sub}>PNTH is live. This feature is not available on mainnet yet.</p>
        </div></header>
        <div className="flex flex-wrap gap-3">
          <a className={s.primary} href={ascendBuyUrl(deployment!.pnth)} target="_blank" rel="noreferrer">Buy PNTH on Ascend</a>
          <Link className={s.ghost} href="/">Back home</Link>
        </div>
      </main>
    </SiteShell>
  );
}
