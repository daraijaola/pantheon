"use client";

import { type CSSProperties, useEffect, useRef } from "react";
import { advanceRatio, cssColor, fitCanvas, monoFamily, prefersReducedMotion, SCRAMBLE, watchActive } from "./runtime";

// Faint columns of real code drifting down. Lines arrive encrypted at the top and decrypt as they fall.
const FONT_PX = 11;
const LINE_H = 18;
const COL_CHARS = 68;
const COL_GAP = 64;
const SPEED = 14; // px per second
const DECRYPT_BAND = 0.3; // top share of the screen where lines are still decrypting
const SCRAMBLE_MS = 70;
const ALPHA = 0.055;

// Cheap deterministic noise so a character keeps the same scramble for one tick.
function noise(a: number, b: number, c: number): number {
  let h = (a * 374761393 + b * 668265263 + c * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

type Props = { source: string; className?: string; style?: CSSProperties };

export function CodeRain({ source, className, style }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !source) return;
    const host = canvas.parentElement!;
    const reduce = prefersReducedMotion();
    const ink = cssColor("--color-ink", "#171717");
    const lines = source.replace(/\t/g, "    ").split("\n").map((l) => l.slice(0, COL_CHARS));
    const n = lines.length;
    let ctx = canvas.getContext("2d")!;
    let family = monoFamily();
    let charW = FONT_PX * 0.6;
    let w = 0;
    let h = 0;
    let raf = 0;
    let active = true;
    const t0 = performance.now();

    const resize = () => {
      w = host.clientWidth;
      h = host.clientHeight;
      ctx = fitCanvas(canvas, w, h);
    };

    const draw = (now: number) => {
      const s = reduce ? 0 : ((now - t0) / 1000) * SPEED;
      const tick = Math.floor(now / SCRAMBLE_MS);
      const colW = COL_CHARS * charW;
      const cols = Math.ceil((w + COL_GAP) / (colW + COL_GAP)) + 1;
      const x0 = (w - (cols * colW + (cols - 1) * COL_GAP)) / 2;
      const band = h * DECRYPT_BAND;
      const visible = Math.ceil(h / LINE_H) + 2;

      ctx.clearRect(0, 0, w, h);
      ctx.font = `400 ${FONT_PX}px ${family}`;
      ctx.textBaseline = "top";
      ctx.fillStyle = ink;
      ctx.globalAlpha = ALPHA;

      for (let c = 0; c < cols; c++) {
        // Each column runs the same file from a different line, so the wall never lines up.
        const base = s + c * 41 * LINE_H;
        const shift = base % LINE_H;
        const first = Math.floor(base / LINE_H);
        const x = x0 + c * (colW + COL_GAP);
        for (let k = -1; k < visible; k++) {
          const y = k * LINE_H + shift;
          const idx = (((k - first) % n) + n) % n;
          let text = lines[idx];
          if (!text.trim()) continue;
          if (!reduce && y < band) {
            const p = Math.max(0, y) / band; // 0 = just arrived, 1 = decrypted
            const q = (1 - p) * (1 - p) * 0.9;
            let out = "";
            for (let i = 0; i < text.length; i++) {
              const ch = text[i];
              out +=
                ch !== " " && noise(idx, i, tick) < q
                  ? SCRAMBLE[(noise(i, idx, tick + 7) * SCRAMBLE.length) | 0]
                  : ch;
            }
            text = out;
          }
          ctx.fillText(text, x, y);
        }
      }
      ctx.globalAlpha = 1;
    };

    const tick = (now: number) => {
      raf = 0;
      if (!active) return;
      draw(now);
      raf = requestAnimationFrame(tick);
    };
    const start = () => {
      if (!raf && active && !reduce) raf = requestAnimationFrame(tick);
    };

    let cancelled = false;
    document.fonts.load(`400 ${FONT_PX}px ${family}`).catch(() => []).then(() => {
      if (cancelled) return;
      family = monoFamily();
      charW = FONT_PX * advanceRatio(ctx, family, 400);
      resize();
      draw(performance.now());
      start();
    });

    const ro = new ResizeObserver(() => {
      resize();
      draw(performance.now());
    });
    ro.observe(host);
    const stopWatch = watchActive(host, (on) => {
      active = on;
      start();
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      stopWatch();
    };
  }, [source]);

  return <canvas ref={canvasRef} aria-hidden="true" className={className} style={style} />;
}
