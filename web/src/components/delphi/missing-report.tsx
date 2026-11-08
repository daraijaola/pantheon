"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import s from "@/components/app/app.module.css";

export function MissingReport() {
  const { token } = useParams<{ token: string }>();
  const valid = /^0x[0-9a-fA-F]{40}$/.test(token ?? "");
  return <main className={s.page}>
    <header className={s.head}><div>
      <p className={s.eyebrow}>DELPHI · report not found</p>
      <h1 className={s.h1}>{valid ? "Not scanned yet" : "Not a valid address"}</h1>
      <p className={s.sub}>{valid ? "DELPHI hasn’t scanned this coin yet. This isn’t a safety verdict." : "That isn’t a valid token address. Use 0x followed by 40 hex characters."}</p>
    </div></header>
    <section className={s.cell}><div className={s.actionsRow}>
      <Link className={s.primarySmall} href="/delphi">Back to DELPHI</Link>
      <Link className={s.ghost} href="/delphi/chat">Ask DELPHI</Link>
    </div></section>
  </main>;
}
