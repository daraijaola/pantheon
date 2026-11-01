import Link from "next/link";
import s from "./get-uploaded.module.css";

/** The hero's main call to action: Caspian, uploaded, in a small code-text window. */
export function GetUploaded({ className }: { className?: string }) {
  return (
    <Link href="/upload" className={`${s.btn} ${className ?? ""}`}>
      <span className={s.tile} aria-hidden="true">
        <span className={s.sweep} />
      </span>
      <span className={s.label}>Get uploaded</span>
      <span className={s.arrow} aria-hidden="true">
        →
      </span>
    </Link>
  );
}
