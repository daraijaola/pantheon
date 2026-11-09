import { networkLabel } from "@/lib/network-copy";
import s from "@/components/app/app.module.css";

export default function Loading() {
  return (
    <main className={s.page} aria-busy="true" data-route-loading>
      <header className={s.head}>
        <div role="status">
          <p className={s.eyebrow}>App · {networkLabel}</p>
          <h1 className={s.h1}>Opening your page…</h1>
        </div>
      </header>
    </main>
  );
}
