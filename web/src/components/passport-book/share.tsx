"use client";

import { useState } from "react";
import type { PassportView } from "./view";
import s from "./passport-book.module.css";

export function PassportShare({ wallet, view }: { wallet: string; view?: PassportView }) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const text = view ? `My HYPE Passport on PANTHEON: Tier ${view.tier}, ${view.boost.replace("×", "x")} boost${view.status !== "Valid" ? ` (${view.status})` : ""}` : "My HYPE Passport on PANTHEON";
  const path = `/passport/${wallet.toLowerCase()}`;
  const url = () => new URL(path, window.location.origin).href;
  async function share() {
    setMessage("");
    if (navigator.share) {
      try { await navigator.share({ title: "HYPE Passport · PANTHEON", text, url: url() }); return; }
      catch (error) { if (error instanceof Error && error.name === "AbortError") return; }
    }
    setOpen(v => !v);
  }
  async function copy() {
    try { await navigator.clipboard.writeText(url()); setMessage("Link copied"); }
    catch { setMessage("Couldn't copy. Copy the public link below."); }
  }
  return <div className={s.share}>
    <button type="button" className={s.action} aria-expanded={open} onClick={() => void share()}>Share</button>
    {open && <div className={s.shareMenu} aria-label="Share passport">
      <button type="button" className={s.action} onClick={() => void copy()}>Copy link</button>
      <a className={s.action} href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(typeof window === "undefined" ? path : url())}`} target="_blank" rel="noreferrer">Share on X</a>
      <a className={s.publicLink} href={path}>Public passport link</a>
    </div>}
    {message && <p role="status">{message}</p>}
  </div>;
}
