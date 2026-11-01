"use client";

import { useSoon } from "./use-soon";
import s from "./get-uploaded.module.css";

/** The hero's main call to action: Caspian, uploaded, in a small code-text window. Not open yet:
 * a click says so in place instead of leading anywhere. */
export function GetUploaded({ className }: { className?: string }) {
  const { soon, show } = useSoon();
  return (
    <button type="button" className={`${s.btn} ${soon ? s.isSoon : ""} ${className ?? ""}`} onClick={show}>
      <span className={s.tile} aria-hidden="true">
        <span className={s.sweep} />
      </span>
      <span className={s.label} aria-live="polite">
        {soon ? "Opening soon" : "Get uploaded"}
      </span>
      <span className={s.arrow} aria-hidden="true">
        {soon ? "·" : "→"}
      </span>
    </button>
  );
}

/** The same call to action as a plain text button (header bar, phone menu). */
export function GetUploadedText({ className }: { className?: string }) {
  const { soon, show } = useSoon();
  return (
    <button type="button" className={className} onClick={show} style={{ cursor: "pointer" }}>
      <span aria-live="polite">{soon ? "Opening soon" : "Get uploaded"}</span>
    </button>
  );
}
