// A 7 × 7 pixel icon on a tiny canvas, in our signature: when it appears (the menu opens) its
// pixels decrypt in from noise, then now and then it glitches (a row slips, a pixel flips, a faint
// echo trails it). While its item is hovered it keeps glitching.

import { useEffect, useRef } from "react";
import { cssColor, prefersReducedMotion } from "../code-type/runtime";
import { ICONS, type IconName } from "./icons";

const N = 7;
const INTRO = 380; // ms for the pixels to settle
const BURST = 260; // ms of one glitch
const GAP_MIN = 1800;
const GAP_MAX = 4800;
const FPS = 20;

export function GlitchIcon({ name, size = 21, hot = false }: { name: IconName; size?: number; hot?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const hotRef = useRef(hot);
  const kick = useRef<() => void>(() => {});
  useEffect(() => {
    hotRef.current = hot;
    kick.current();
  }, [hot]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const ink = cssColor("--color-ink", "#171717");
    const reduce = prefersReducedMotion();
    const rows = ICONS[name];
    const cell = size / N;
    const dot = cell * 0.82;
    const value = (r: number, c: number) => (rows[r]?.[c] === "#" ? 1 : rows[r]?.[c] === "+" ? 0.4 : 0);
    const settle = Array.from({ length: N * N }, () => Math.random() * INTRO * 0.75);
    const born = performance.now();
    let burstFrom = born + INTRO + 500 + Math.random() * GAP_MAX;
    let raf = 0;
    let timer = 0;
    let last = 0;

    const draw = (now: number) => {
      const t = now - born;
      const burst = hotRef.current || (now >= burstFrom && now < burstFrom + BURST);
      ctx.clearRect(0, 0, size, size);
      ctx.fillStyle = ink;
      const shift = burst ? Array.from({ length: N }, () => (Math.random() < 0.22 ? (Math.random() < 0.5 ? -1 : 1) : 0)) : null;
      const layer = (dx: number, alpha: number) => {
        for (let r = 0; r < N; r++) {
          for (let c = 0; c < N; c++) {
            let v = value(r, (c - (shift ? shift[r] : 0) + N) % N);
            if (t < settle[r * N + c]) v = Math.random() < 0.35 ? 0.3 : 0; // still noise
            else if (burst && Math.random() < 0.07) v = v ? 0 : 0.35; // a flipped pixel
            if (!v) continue;
            ctx.globalAlpha = v * alpha;
            ctx.fillRect(c * cell + (cell - dot) / 2 + dx, r * cell + (cell - dot) / 2, dot, dot);
          }
        }
      };
      if (burst) layer(cell, 0.2); // the echo
      layer(0, 1);
      ctx.globalAlpha = 1;
    };

    const tick = (now: number) => {
      raf = 0;
      if (now >= burstFrom + BURST && !hotRef.current) burstFrom = now + GAP_MIN + Math.random() * (GAP_MAX - GAP_MIN);
      if (now - last >= 1000 / FPS) {
        last = now;
        draw(now);
      }
      const busy = now - born < INTRO || hotRef.current || (now >= burstFrom && now < burstFrom + BURST);
      if (busy) raf = requestAnimationFrame(tick);
      else timer = window.setTimeout(() => (raf = requestAnimationFrame(tick)), Math.max(16, burstFrom - now));
    };

    // Hovering wakes a sleeping icon straight away.
    kick.current = () => {
      if (reduce || raf) return;
      clearTimeout(timer);
      raf = requestAnimationFrame(tick);
    };
    if (reduce) draw(born + INTRO);
    else raf = requestAnimationFrame(tick);
    return () => {
      kick.current = () => {};
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
  }, [name, size]);

  return <canvas ref={ref} aria-hidden="true" style={{ width: size, height: size, display: "block", flex: "none" }} />;
}
