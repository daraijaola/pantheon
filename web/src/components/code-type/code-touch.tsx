"use client";

import { useEffect, useRef } from "react";
import { advanceRatio, cssColor, fitCanvas, monoFamily, prefersReducedMotion, SCRAMBLE, watchActive } from "./runtime";

/*
 * "The Touch": the Creation of Adam, drawn in code.
 * The frames are baked offline in the touch lab (lab/touch): two hands modelled in 3D, lit, outlined,
 * and turned into characters cell by cell. Adam's hand (human) is a calm pen drawing; God's hand
 * (the uploaded one) is filled with binary. This player loads the frames when the section comes
 * near, plays the slow reach on a loop, and glitches God's hand live: a gentle flicker most of the
 * time, a short burst (sliced rows, scrambled glyphs, a jumping echo) every few seconds.
 */

type Frames = {
  cols: number;
  rows: number;
  loopMs: number;
  frames: { ae: string; af: string; ge: string; gf: string }[];
};

const SRC = "/touch/frames.json";
// Grid of the baked frames; used to reserve the height before they load (no layout jump).
const COLS = 288;
const ROWS = 44;
const FPS = 15;
const MIN_CHAR_W = 3.4; // below this, narrow screens crop to the fingertips instead of shrinking
const FILL_ALPHA = 0.5;
const FADE_IN = 0.03; // arms fade out toward the frame edges so the eye goes to the fingertips
const FADE_OUT = 0.24;

// God's glitch: calm most of the time, a short burst every few seconds.
const CALM = { scramble: 0.004, flip: 0.05, echoX: 1.5, echoA: 0.12 };
const BURST = { scramble: 0.09, slice: 0.6, echoX: 4, echoA: 0.24, len: 450, gapMin: 2500, gapMax: 5000 };

type Slice = { r0: number; n: number; shift: number; until: number; drop: boolean };

function fade(c: number, n: number): number {
  const x = Math.min(c, n - 1 - c) / n;
  if (x <= FADE_IN) return 0;
  if (x >= FADE_OUT) return 1;
  const t = (x - FADE_IN) / (FADE_OUT - FADE_IN);
  return t * t * (3 - 2 * t);
}

export function CodeTouch({ className }: { className?: string }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;

    const reduce = prefersReducedMotion();
    const ink = cssColor("--color-ink", "#171717");
    let ctx = canvas.getContext("2d")!;
    let family = monoFamily();
    let data: Frames | null = null;
    let grids: { a: [string[], string[]]; g: [string[], string[]] }[] = [];
    let charW = 0;
    let lineH = 0;
    let fontPx = 0;
    let colOff = 0;
    let visCols = 0;
    let slices: Slice[] = [];
    let burstAt = 0;
    let burstUntil = 0;
    let raf = 0;
    let active = true;
    let started = 0;
    let last = 0;

    // Before the frames arrive, hold the space they will take.
    const reserve = () => {
      const w = wrap.clientWidth;
      const cw = Math.max(w / COLS, MIN_CHAR_W);
      wrap.style.minHeight = `${Math.round(ROWS * (cw / 0.6) * 1.17)}px`;
    };
    reserve();

    const layout = () => {
      if (!data) return;
      const w = wrap.clientWidth;
      charW = Math.max(w / data.cols, MIN_CHAR_W);
      visCols = Math.min(data.cols, Math.floor(w / charW));
      colOff = Math.floor((data.cols - visCols) / 2);
      fontPx = charW / advanceRatio(ctx, family, 400);
      lineH = fontPx * 1.17;
      ctx = fitCanvas(canvas, w, data.rows * lineH);
    };

    const drawLayer = (lines: string[], alpha: number, dx: number, glitch: { burst: boolean } | null) => {
      for (let r = 0; r < lines.length; r++) {
        const line = lines[r];
        const sl = glitch ? slices.find((s) => r >= s.r0 && r < s.r0 + s.n) : undefined;
        for (let v = 0; v < visCols; v++) {
          const c = v + colOff;
          const src = sl ? c - sl.shift : c;
          if (src < 0 || src >= line.length) continue;
          let ch = line[src];
          if (ch === " ") continue;
          const a = alpha * fade(v, visCols);
          if (a < 0.02) continue;
          if (glitch) {
            if (sl?.drop && Math.random() < 0.3) continue;
            if ((ch === "0" || ch === "1") && Math.random() < CALM.flip) ch = ch === "0" ? "1" : "0";
            if (Math.random() < (glitch.burst ? BURST.scramble : CALM.scramble)) ch = SCRAMBLE[(Math.random() * SCRAMBLE.length) | 0];
          }
          ctx.globalAlpha = a;
          ctx.fillText(ch, (v + 0.5) * charW + dx, (r + 0.5) * lineH);
        }
      }
    };

    const draw = (now: number) => {
      if (!data) return;
      const n = grids.length;
      // rAF timestamps can land a hair before `started`; clamp so the frame index never goes negative.
      const idx = reduce ? Math.floor(n / 2) : Math.floor(((Math.max(0, now - started) / data.loopMs) % 1) * n) % n;
      const f = grids[idx];

      let burst = false;
      if (!reduce) {
        if (now >= burstAt) {
          burstUntil = now + BURST.len;
          burstAt = now + BURST.gapMin + Math.random() * (BURST.gapMax - BURST.gapMin);
        }
        burst = now < burstUntil;
        slices = slices.filter((s) => s.until > now);
        if (burst && Math.random() < BURST.slice) {
          slices.push({
            r0: (Math.random() * data.rows) | 0,
            n: 1 + ((Math.random() * 4) | 0),
            shift: (Math.random() < 0.5 ? -1 : 1) * (2 + ((Math.random() * 8) | 0)),
            until: now + 70 + Math.random() * 190,
            drop: Math.random() < 0.25,
          });
        }
      }

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.font = `400 ${fontPx}px ${family}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = ink;
      const glitch = reduce ? null : { burst };
      // God's echo (a black-and-white double exposure), then God, then Adam on top.
      const echoX = (burst ? BURST.echoX : CALM.echoX) * charW;
      const echoA = burst ? BURST.echoA : CALM.echoA;
      drawLayer(f.g[1], echoA * FILL_ALPHA, echoX, glitch);
      drawLayer(f.g[0], echoA, echoX, glitch);
      drawLayer(f.g[1], FILL_ALPHA, 0, glitch);
      drawLayer(f.g[0], 1, 0, glitch);
      drawLayer(f.a[1], FILL_ALPHA, 0, null);
      drawLayer(f.a[0], 1, 0, null);
      ctx.globalAlpha = 1;
    };

    const tick = (now: number) => {
      raf = 0;
      if (!active) return;
      if (now - last >= 1000 / FPS) {
        last = now;
        draw(now);
      }
      raf = requestAnimationFrame(tick);
    };
    const start = () => {
      if (!raf && active && data && !reduce) raf = requestAnimationFrame(tick);
    };

    let cancelled = false;
    // Load the frames only when the section gets close to the viewport.
    const near = new IntersectionObserver(
      async ([entry]) => {
        if (!entry.isIntersecting || data) return;
        near.disconnect();
        const [res] = await Promise.all([fetch(SRC), document.fonts.load(`400 8px ${family}`).catch(() => [])]);
        const json = (await res.json()) as Frames;
        if (cancelled) return;
        family = monoFamily();
        data = json;
        grids = json.frames.map((f) => ({
          a: [f.ae.split("\n"), f.af.split("\n")],
          g: [f.ge.split("\n"), f.gf.split("\n")],
        }));
        layout();
        started = performance.now();
        draw(started);
        start();
      },
      { rootMargin: "400px 0px" },
    );
    near.observe(wrap);

    const ro = new ResizeObserver(() => {
      if (!data) return reserve();
      layout();
      draw(performance.now());
    });
    ro.observe(wrap);
    const stopWatch = watchActive(wrap, (on) => {
      active = on;
      start();
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      near.disconnect();
      ro.disconnect();
      stopWatch();
    };
  }, []);

  return (
    <div ref={wrapRef} className={className} aria-hidden="true">
      <canvas ref={canvasRef} className="block" />
    </div>
  );
}
