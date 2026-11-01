"use client";

import { useEffect, useRef } from "react";
import { ChatOrb } from "@/components/delphi-chat/orb";
import { useSoon } from "./use-soon";
import s from "./get-uploaded.module.css";

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const voice = (t: number) => clamp(0.5 + 0.32 * Math.sin(t * 2.1) * Math.sin(t * 0.73 + 1) + 0.22 * Math.sin(t * 5.3 + 0.4) * Math.sin(t * 1.7) + 0.12 * Math.sin(t * 9.1), 0, 1);

/** DELPHI's orb (the same one as /delphi/chat), drifting inside the button's small window. It only
 * draws while the button is on screen; with no WebGL, a still glass bead sits in its place. */
function TileOrb({ pulseAt }: { pulseAt: React.RefObject<number> }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const bead = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    const orb = ChatOrb.create(cv);
    if (!orb) {
      if (bead.current) bead.current.style.display = "block";
      return;
    }
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const t0 = performance.now();
    let raf = 0;
    let on = true;
    let lx = 0;
    let ly = 0;
    const frame = () => {
      raf = 0;
      if (!on || document.hidden || orb.lost) return;
      const W = cv.clientWidth;
      const H = cv.clientHeight;
      const now = performance.now();
      const t = reduced ? 6 : (now - t0) / 1000;
      const r = Math.min(H * 0.32, 16);
      // A slow figure of eight across the window, stretched a little along the way it moves.
      const x = W / 2 + (W / 2 - r - 8) * Math.sin(t * 0.55);
      const y = H / 2 + 3.5 * Math.sin(t * 1.1 + 0.6);
      const vx = (x - lx) * 60;
      const vy = (y - ly) * 60;
      lx = x;
      ly = y;
      const since = (now - (pulseAt.current ?? -1e9)) / 1000;
      const pulse = reduced || since < 0 ? 0 : Math.exp(-since * 3.2) * (since < 1.6 ? 1 : 0);
      orb.draw(
        {
          x,
          y,
          r,
          think: 0,
          energy: 0.22 + 0.2 * voice(t) + 0.35 * pulse,
          pulse,
          stretch: reduced ? 0 : clamp(Math.hypot(vx, vy) / 900, 0, 0.1),
          angle: Math.atan2(vy, vx),
          time: t,
          fade: 1,
        },
        W,
        H,
        Math.min(window.devicePixelRatio || 1, 2),
      );
      if (!reduced) raf = requestAnimationFrame(frame);
    };
    const start = () => {
      if (!raf) raf = requestAnimationFrame(frame);
    };
    const io = new IntersectionObserver(([e]) => {
      on = e.isIntersecting;
      if (on) start();
    });
    io.observe(cv);
    const onVis = () => !document.hidden && start();
    document.addEventListener("visibilitychange", onVis);
    const onLost = (e: Event) => e.preventDefault();
    cv.addEventListener("webglcontextlost", onLost);
    start();
    return () => {
      if (raf) cancelAnimationFrame(raf);
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      cv.removeEventListener("webglcontextlost", onLost);
    };
  }, [pulseAt]);

  return (
    <>
      <canvas ref={canvas} className={s.orb} />
      <span ref={bead} className={s.bead} />
    </>
  );
}

/** The hero's main call to action: DELPHI's orb, moving in a small window. Not open yet: a click
 * says so in place instead of leading anywhere, and the orb answers with one soft pulse. */
export function GetUploaded({ className }: { className?: string }) {
  const { soon, show } = useSoon();
  const pulseAt = useRef(-1e9);
  return (
    <button
      type="button"
      className={`${s.btn} ${soon ? s.isSoon : ""} ${className ?? ""}`}
      onClick={() => {
        pulseAt.current = performance.now();
        show();
      }}
    >
      <span className={s.tile} aria-hidden="true">
        <TileOrb pulseAt={pulseAt} />
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
