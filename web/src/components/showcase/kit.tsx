"use client";
/* eslint-disable @next/next/no-img-element -- small brand marks, already optimised files */

// Shared toolkit for the landing-page "showcase" sections (How it works, What you get).
// Timing, motion preferences, small number/text helpers and the brand marks, all in one place.

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import s from "./showcase.module.css";

export type Logos = "mono" | "color";
const SCRAMBLE = "{}[]()<>/\\|=+-*&%$#@!?;:0123456789abcdefx";

// ───────────────────────── small helpers ─────────────────────────
export const clamp01 = (t: number) => Math.max(0, Math.min(1, t));
export const ease = (t: number) => 1 - Math.pow(1 - clamp01(t), 3);
export const span = (t: number, a: number, b: number) => clamp01((t - a) / (b - a));
export const fmt = (n: number, d = 0) => n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

export function decrypt(text: string, p: number): string {
  if (p >= 1) return text;
  const reveal = Math.floor(text.length * p);
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    out += i < reveal || c === " " || c === "," || c === "." ? c : SCRAMBLE[(Math.random() * SCRAMBLE.length) | 0];
  }
  return out;
}

/**
 * The step clock: which step is showing and how long it has been on screen.
 * One animation-frame loop drives it (and auto-advances); a click jumps to a step and restarts its clock.
 * Paused off screen; when it resumes, the step carries on where it left off.
 */
export function useStepClock(count: number, stepMs: number, running: boolean) {
  const [view, setView] = useState({ active: 0, t: 0 });
  const active = useRef(0);
  const start = useRef(0);
  const last = useRef(0);
  useEffect(() => {
    if (!running) return;
    start.current = performance.now() - last.current;
    let raf = 0;
    const tick = (now: number) => {
      let t = now - start.current;
      if (t >= stepMs) {
        active.current = (active.current + 1) % count;
        start.current = now;
        t = 0;
      }
      last.current = t;
      setView({ active: active.current, t });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [running, count, stepMs]);
  const select = (i: number) => {
    active.current = i;
    start.current = performance.now();
    last.current = 0;
    setView({ active: i, t: 0 });
  };
  return { ...view, select };
}

const REDUCE = "(prefers-reduced-motion: reduce)";
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const m = window.matchMedia(REDUCE);
      m.addEventListener("change", onChange);
      return () => m.removeEventListener("change", onChange);
    },
    () => window.matchMedia(REDUCE).matches,
    () => false,
  );
}

export function useInView<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setInView(e.isIntersecting), { threshold: 0.25 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return [ref, inView];
}

// ───────────────────────── brand marks ─────────────────────────
const P_GLYPH = ["######.", "#######", "##...##", "##...##", "#######", "######.", "##.....", "##.....", "##.....", "##....."];

/** Our pixel "P" (the code type from the hero), as a tiny crisp SVG. */
export function PMark({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 7 10" width={size * 0.7} height={size} shapeRendering="crispEdges" aria-hidden="true">
      {P_GLYPH.flatMap((row, y) => [...row].map((c, x) => (c === "#" ? <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} /> : null)))}
    </svg>
  );
}

export function AscendMark({ logos, size = 18 }: { logos: Logos; size?: number }) {
  return <img src="/brand/ascend-mark.png" alt="" className={logos === "mono" ? s.mono : undefined} style={{ height: size, width: "auto" }} />;
}
export function AscendWordmark({ size = 13 }: { size?: number }) {
  // Their wordmark ships light-on-dark; it is always shown as ink on our paper.
  return <img src="/brand/ascend-wordmark-light.png" alt="Ascend" className={s.ink} style={{ height: size, width: "auto" }} />;
}
export function HypeMark({ logos, size = 18 }: { logos: Logos; size?: number }) {
  return <img src={logos === "mono" ? "/brand/hype-mono.svg" : "/brand/hype.svg"} alt="" style={{ height: size, width: size }} />;
}

export function TokenChip({ icon, label, logo }: { icon?: ReactNode; label: string; logo?: string }) {
  return (
    <span className={s.chip}>
      {logo ? <img src={logo} alt="" className={s.chipLogo} /> : <span className={s.chipIcon}>{icon}</span>}
      {label}
    </span>
  );
}

