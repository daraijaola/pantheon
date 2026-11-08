"use client";

// DELPHI in the corner of every inside page: her orb (the same one as /delphi/chat and the Get uploaded
// button), drifting in a small round window of clear glass, the bar's own. One click and you're on her
// page. On a computer her name slides out beside her when you point at her; on a phone she sits at the
// end of the tab bar. It draws only while it's on screen, about 30 times a second; without WebGL a still
// bead sits in her place, and with reduced motion she holds still.

import Link from "next/link";
import { useEffect, useRef } from "react";
import { ChatOrb } from "@/components/delphi-chat/orb";
import s from "./app-frame.module.css";

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
// her "voice": a slow, uneven swell of light, so she looks alive without moving much
const voice = (t: number) => clamp(0.5 + 0.32 * Math.sin(t * 2.1) * Math.sin(t * 0.73 + 1) + 0.22 * Math.sin(t * 5.3 + 0.4) * Math.sin(t * 1.7) + 0.12 * Math.sin(t * 9.1), 0, 1);

export function DelphiOrb() {
  const windowRef = useRef<HTMLSpanElement>(null);
  const bead = useRef<HTMLSpanElement>(null);
  const hot = useRef(false);

  useEffect(() => {
    const win = windowRef.current;
    if (!win) return;
    // A canvas made here, not kept by the page: after a cached navigation this runs again, and a WebGL
    // canvas whose context was let go can't be used twice.
    const cv = document.createElement("canvas");
    cv.className = s.delphiCanvas;
    win.prepend(cv);
    const orb = ChatOrb.create(cv, (available) => {
      if (bead.current) bead.current.style.display = available ? "none" : "block";
      if (available) start();
    });
    if (!orb) {
      cv.remove();
      if (bead.current) bead.current.style.display = "block";
      return;
    }
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const t0 = performance.now();
    let raf = 0, on = true, heat = 0, last = 0, lx = 0, ly = 0;
    const frame = (now: number) => {
      raf = 0;
      if (!on || document.hidden || orb.lost) return;
      if (!reduced) raf = requestAnimationFrame(frame);
      if (last && now - last < 32) return;
      const dt = last ? Math.min((now - last) / 1000, 0.1) : 1 / 30;
      last = now;
      const W = cv.clientWidth, H = cv.clientHeight;
      const t = reduced ? 6 : (now - t0) / 1000;
      heat += ((hot.current ? 1 : 0) - heat) * Math.min(1, dt * 7);
      const r = Math.min(W, H) * 0.33 * (1 + 0.08 * heat);
      // a small drift round the middle of the window, a little stretched the way she moves
      const x = W / 2 + 2.5 * Math.sin(t * 0.6) * (1 - 0.5 * heat);
      const y = H / 2 + 1.5 * Math.sin(t * 1.1 + 0.6);
      const vx = (x - lx) * 30, vy = (y - ly) * 30;
      lx = x;
      ly = y;
      orb.draw(
        { x, y, r, think: 0, energy: 0.28 + 0.2 * voice(t) + 0.3 * heat, pulse: 0, stretch: reduced ? 0 : clamp(Math.hypot(vx, vy) / 900, 0, 0.08), angle: Math.atan2(vy, vx), time: t, fade: 1 },
        W,
        H,
        Math.min(window.devicePixelRatio || 1, 2),
      );
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
    start();
    return () => {
      if (raf) cancelAnimationFrame(raf);
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      orb.dispose();
      cv.getContext("webgl")?.getExtension("WEBGL_lose_context")?.loseContext();
      cv.remove();
    };
  }, []);

  return (
    <Link
      href="/delphi/chat"
      className={s.delphi}
      aria-label="Ask DELPHI"
      onPointerEnter={() => (hot.current = true)}
      onPointerLeave={() => (hot.current = false)}
      onFocus={() => (hot.current = true)}
      onBlur={() => (hot.current = false)}
    >
      <span className={s.delphiName} aria-hidden="true">
        Ask DELPHI
      </span>
      <span ref={windowRef} className={s.delphiWindow} aria-hidden="true">
        <span ref={bead} className={s.delphiBead} />
      </span>
    </Link>
  );
}
