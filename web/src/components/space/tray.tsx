"use client";

// A tray: the details, only when asked for, in liquid glass over the page. Apple keeps glass for the
// layer that floats above content, and that's what a tray is. It grows out of what you tapped and goes
// back into it, so you can see where it came from. One tray holds one subject. On a wide screen it
// stands at the right; on a phone it rises from the bottom.

import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import s from "./space.module.css";

/** Where a tray grows from: the tapped thing's box on screen, and its corner radius. */
export type From = { x: number; y: number; w: number; h: number; r: number };

export const fromEl = (el: Element, r = 12): From => {
  const b = el.getBoundingClientRect();
  return { x: b.left, y: b.top, w: b.width, h: b.height, r };
};

const OPEN = "cubic-bezier(0.32, 0.72, 0, 1)";
const SHUT = "cubic-bezier(0.4, 0, 0.9, 0.4)";
const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The keyframes that take the sheet from the tapped thing's box to its own. */
function morph(sheet: HTMLElement, from: From | null): Keyframe[] | null {
  if (!from) return null;
  const p = sheet.getBoundingClientRect();
  if (!p.width || !p.height) return null;
  const dx = from.x + from.w / 2 - (p.left + p.width / 2);
  const dy = from.y + from.h / 2 - (p.top + p.height / 2);
  const ix = Math.max(0, (p.width - from.w) / 2), iy = Math.max(0, (p.height - from.h) / 2);
  const radius = getComputedStyle(sheet).borderTopLeftRadius || "28px";
  return [
    { transform: `translate(${dx}px, ${dy}px)`, clipPath: `inset(${iy}px ${ix}px round ${from.r}px)`, opacity: 0.5 },
    { transform: "translate(0px, 0px)", clipPath: `inset(0px 0px round ${radius})`, opacity: 1 },
  ];
}

const Close = createContext<() => void>(() => {});
/** Closes the tray this is in, the animated way. */
export const useCloseTray = () => useContext(Close);

export function Tray({ open, from, label, onClose, children }: { open: boolean; from: From | null; label: string; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const scrim = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const closing = useRef(false);
  const live = useRef({ from, onClose });
  useEffect(() => {
    live.current = { from, onClose };
  });

  // close: the sheet goes back into what opened it, then the dialog shuts
  const shut = useRef(() => {});
  useEffect(() => {
    shut.current = () => {
      const sh = sheet.current, sc = scrim.current;
      if (!sh || !sc || closing.current) return;
      closing.current = true;
      // once, when the glass is back in place, or soon after whatever a slow frame does
      let fired = false;
      const done = () => {
        if (fired) return;
        fired = true;
        closing.current = false;
        live.current.onClose();
      };
      window.setTimeout(done, 420);
      const k = reduced() ? null : morph(sh, live.current.from);
      const a = k
        ? sh.animate([...k].reverse(), { duration: 300, easing: SHUT, fill: "forwards" })
        : sh.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: "forwards" });
      sc.animate([{ opacity: 1 }, { opacity: 0 }], { duration: k ? 300 : 160, easing: "ease", fill: "forwards" });
      a.finished.then(done, done);
    };
  });

  useEffect(() => {
    const d = dialog.current, sh = sheet.current, sc = scrim.current;
    if (!d || !sh || !sc) return;
    if (open && !d.open) {
      for (const a of [...sh.getAnimations(), ...sc.getAnimations()]) a.cancel();
      d.showModal();
      const html = document.documentElement;
      const before = html.style.overflow;
      html.style.overflow = "hidden";
      inner.current?.scrollTo(0, 0);
      sh.removeAttribute("data-scrolled");
      const k = reduced() ? null : morph(sh, live.current.from);
      if (k) {
        sh.animate(k, { duration: 480, easing: OPEN });
        sc.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 320, easing: "ease" });
        // the words come with the glass, settling just after it
        inner.current?.animate([{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }], { duration: 340, delay: 50, easing: OPEN, fill: "backwards" });
      } else {
        sh.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160 });
        sc.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160 });
      }
      return () => {
        html.style.overflow = before;
      };
    }
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={dialog}
      className={s.tray}
      aria-label={label}
      onCancel={(e) => {
        e.preventDefault();
        shut.current();
      }}
      onClose={() => {
        // the browser can shut a dialog itself (a second Escape): keep the page in step
        closing.current = false;
        if (open) live.current.onClose();
      }}
    >
      <div ref={scrim} className={s.scrim} onClick={() => shut.current()} aria-hidden="true" />
      <div ref={sheet} className={s.sheet}>
        <Close.Provider value={() => shut.current()}>
          <div ref={inner} className={s.sheetIn} onScroll={(e) => sheet.current?.toggleAttribute("data-scrolled", e.currentTarget.scrollTop > 2)}>
            {open && children}
          </div>
        </Close.Provider>
      </div>
    </dialog>
  );
}
