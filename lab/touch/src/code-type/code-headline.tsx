"use client";

import { useEffect, useRef } from "react";
import { GLYPH_ROWS } from "./glyphs";
import { layoutHeadline, type HeadlineWord } from "./layout";
import {
  advanceRatio,
  cssColor,
  fitCanvas,
  monoFamily,
  prefersReducedMotion,
  randomGlyph,
  watchActive,
} from "./runtime";

// One row of a lit module: a solid ink block with characters of code knocked out of it, like a
// terminal selection. From afar it reads as a bold pixel letter; up close it is code.
// A module is 2 characters wide at density 1; at density d it is d rows of 2d smaller characters.
type Block = {
  x: number;
  y: number;
  code: string;
  enc: string; // what it shows while encrypted
  muted: boolean;
  appear: number; // ms after start: shows as encrypted characters
  reveal: number; // ms after start: the block locks in with its real code
  glitchUntil: number; // performance.now() timestamp
  nextSwap: number;
};

const scrambled = (n: number) => Array.from({ length: n }, randomGlyph).join("");

// Intro choreography: letters draw in one after another, top to bottom, then decrypt.
const START_DELAY = 250;
const LETTER_STAGGER = 55;
const LETTER_DRAW = 170;
const DECRYPT_MIN = 140;
const DECRYPT_JITTER = 220;
// After the intro: a few blocks re-encrypt now and then.
const AMBIENT_EVERY = 110;
const AMBIENT_SHARE = 0.004;
const FRAME_MS = 1000 / 30;
const MUTED = 0.4;

type Props = {
  /** The sentence, split into words; mark preferred line ends with breakAfter. */
  words: HeadlineWord[];
  /** Real code the letters are made of (whitespace already stripped). */
  fill: string;
  /** Plain-text heading for screen readers and search. */
  label: string;
  /** Largest character width in px (a letter pixel is 2 characters wide, so module = 2 × this). */
  maxCharW?: number;
  /** Tallest the heading may get, as a share of the viewport height. */
  maxHeightVh?: number;
  /** Finer code inside each letter pixel (1 = the hero's 2 characters, 2 = 2 rows of 4 smaller ones). */
  density?: number;
  /** Play the intro the first time the heading is half on screen (instead of on page load). */
  startOnView?: boolean;
  /** Purely visual (the words are already on the page elsewhere): no heading for screen readers. */
  decorative?: boolean;
  className?: string;
};

export function CodeHeadline({
  words,
  fill,
  label,
  maxCharW = 3.2,
  maxHeightVh = 0.36,
  density = 1,
  startOnView = false,
  decorative = false,
  className,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas || !fill) return;

    const reduce = prefersReducedMotion();
    const ink = cssColor("--color-ink", "#171717");
    const paper = cssColor("--color-paper", "#f9f9f9");
    let ctx = canvas.getContext("2d")!;
    let family = monoFamily();
    let adv = 0.6;
    let blocks: Block[] = [];
    let charW = 0;
    let charH = 0;
    let fontPx = 0;
    let lastReveal = 0;
    let t0 = performance.now();
    let introDone = reduce;
    let active = true;
    let started = !startOnView;
    let raf = 0;
    let lastDraw = 0;
    let lastAmbient = 0;
    let lastWidth = -1;

    const build = () => {
      const width = wrap.clientWidth;
      lastWidth = width;
      const height = window.innerHeight * maxHeightVh;
      const fit = layoutHeadline(words, { width, height }, { maxCharW });
      const unit = 2 * fit.charW; // one letter pixel, square
      charW = fit.charW / density;
      charH = charW * 2;
      fontPx = charW / adv;
      ctx = fitCanvas(canvas, fit.layout.cols * unit, fit.layout.rows * unit);
      const per = 2 * density; // characters in one block row

      const modules = [...fit.layout.modules].sort((p, q) => p.row - q.row || p.col - q.col);
      blocks = [];
      let k = 0;
      for (const m of modules) {
        const appear = START_DELAY + m.letter * LETTER_STAGGER + (m.glyphRow / GLYPH_ROWS) * LETTER_DRAW;
        const reveal = appear + DECRYPT_MIN + Math.random() * DECRYPT_JITTER;
        for (let r = 0; r < density; r++) {
          let code = "";
          for (let i = 0; i < per; i++) code += fill[k++ % fill.length];
          blocks.push({
            x: m.col * unit,
            y: m.row * unit + r * charH,
            code,
            enc: scrambled(per),
            muted: m.muted,
            appear: introDone ? 0 : appear,
            reveal: introDone ? 0 : reveal,
            glitchUntil: 0,
            nextSwap: 0,
          });
        }
        lastReveal = Math.max(lastReveal, reveal);
      }
    };

    const draw = (now: number) => {
      const t = now - t0;
      const per = 2 * density;
      const w = per * charW;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.font = `600 ${fontPx}px ${family}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (const blk of blocks) {
        if (t < blk.appear) continue;
        const tone = blk.muted ? MUTED : 1;
        const encrypted = t < blk.reveal || now < blk.glitchUntil;
        if (encrypted && now >= blk.nextSwap) {
          blk.enc = scrambled(per);
          blk.nextSwap = now + 45 + Math.random() * 45;
        }
        const cy = blk.y + charH / 2;
        if (encrypted) {
          // Still encrypted: loose ink characters, no block yet.
          ctx.globalAlpha = tone * (t < blk.reveal ? 0.45 : 0.7);
          ctx.fillStyle = ink;
          for (let i = 0; i < per; i++) ctx.fillText(blk.enc[i], blk.x + charW * (i + 0.5), cy);
          continue;
        }
        ctx.globalAlpha = tone;
        ctx.fillStyle = ink;
        // Solid letters overlap their neighbours by half a pixel so no hairline seams show.
        const seam = tone === 1 ? 0.5 : 0;
        ctx.fillRect(blk.x, blk.y, w + seam, charH + seam);
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = paper;
        for (let i = 0; i < per; i++) ctx.fillText(blk.code[i], blk.x + charW * (i + 0.5), cy);
      }
      ctx.globalAlpha = 1;
    };

    const tick = (now: number) => {
      raf = 0;
      if (!active || !started) return;
      if (!introDone && now - t0 > lastReveal) introDone = true;
      if (introDone && !reduce && now - lastAmbient > AMBIENT_EVERY) {
        lastAmbient = now;
        const n = Math.max(1, Math.round(blocks.length * AMBIENT_SHARE));
        for (let i = 0; i < n; i++) {
          blocks[(Math.random() * blocks.length) | 0].glitchUntil = now + 160 + Math.random() * 220;
        }
      }
      if (!introDone || now - lastDraw >= FRAME_MS) {
        draw(now);
        lastDraw = now;
      }
      if (!reduce) raf = requestAnimationFrame(tick);
    };

    const start = () => {
      if (!raf && active && started && !reduce) raf = requestAnimationFrame(tick);
    };

    // Held until it is seen: the clock starts when half of it is on screen.
    const seen = new IntersectionObserver(
      ([e]) => {
        if (!e.isIntersecting || started) return;
        started = true;
        t0 = performance.now();
        seen.disconnect();
        start();
      },
      { threshold: 0.5 },
    );
    if (!started) seen.observe(wrap);

    let cancelled = false;
    // Wait for the real font so character widths are right, then lay out and play.
    document.fonts.load(`600 16px ${family}`).catch(() => []).then(() => {
      if (cancelled) return;
      family = monoFamily();
      adv = advanceRatio(ctx, family, 600);
      build();
      t0 = performance.now();
      draw(t0);
      start();
    });

    const ro = new ResizeObserver(() => {
      if (!fontPx || wrap.clientWidth === lastWidth) return;
      if (started) introDone = true;
      build();
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
      seen.disconnect();
      ro.disconnect();
      stopWatch();
    };
  }, [words, fill, maxCharW, maxHeightVh, density, startOnView]);

  return (
    <div ref={wrapRef} className={className} aria-hidden={decorative || undefined}>
      {!decorative && <h1 className="sr-only">{label}</h1>}
      <canvas ref={canvasRef} aria-hidden="true" className="mx-auto block" />
    </div>
  );
}
