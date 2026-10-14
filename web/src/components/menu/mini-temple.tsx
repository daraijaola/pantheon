"use client";

// The basket's temple, small and still, for the menu's featured card. Same building as section 03,
// drawn once (it decrypts in as the menu opens).

import { useEffect, useRef } from "react";
import { advanceRatio, cssColor, fitCanvas, monoFamily, prefersReducedMotion, SCRAMBLE } from "@/components/code-type/runtime";
import { buildTemple, INK } from "@/components/basket/temple";

const COLS = 120;
const INTRO = 600;

export function MiniTemple({ code, className }: { code: string; className?: string }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = ref.current;
    if (!wrap || !canvas) return;
    const ink = cssColor("--color-ink", "#171717");
    const paper = cssColor("--color-paper", "#f9f9f9");
    const family = monoFamily();
    const reduce = prefersReducedMotion();
    const W = wrap.clientWidth;
    const temple = buildTemple(COLS, code);
    let ctx = canvas.getContext("2d")!;
    const cellW = W / COLS;
    const fontPx = cellW / advanceRatio(ctx, family, 400);
    const lineH = fontPx * 1.17;
    ctx = fitCanvas(canvas, W, temple.rows * lineH);
    const order = temple.cells.map((q) => ((temple.rows - q.r) / temple.rows) * INTRO * 0.7 + Math.random() * INTRO * 0.3);
    const born = performance.now();
    let raf = 0;
    const draw = (t: number) => {
      ctx.clearRect(0, 0, W, temple.rows * lineH);
      ctx.font = `400 ${fontPx}px ${family}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      temple.cells.forEach((q, i) => {
        if (t < order[i]) return;
        const ch = t < order[i] + 120 && !q.line ? SCRAMBLE[(Math.random() * SCRAMBLE.length) | 0] : q.ch;
        const x = q.c * cellW;
        const y = q.r * lineH;
        if (!q.line && q.d >= INK) {
          ctx.globalAlpha = 1;
          ctx.fillStyle = ink;
          ctx.fillRect(x, y, cellW + 0.3, lineH + 0.3);
          ctx.fillStyle = paper;
          ctx.globalAlpha = 0.35;
        } else {
          ctx.fillStyle = ink;
          ctx.globalAlpha = q.line ? 1 : Math.min(1, q.d * 1.05);
        }
        ctx.fillText(ch, x + cellW / 2, y + lineH / 2);
      });
      ctx.globalAlpha = 1;
    };
    const tick = (now: number) => {
      const t = now - born;
      draw(t);
      raf = t < INTRO + 200 ? requestAnimationFrame(tick) : 0;
    };
    if (reduce) draw(1e9);
    else raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [code]);
  return (
    <div ref={wrapRef} className={className} aria-hidden="true">
      <canvas ref={ref} style={{ display: "block" }} />
    </div>
  );
}
