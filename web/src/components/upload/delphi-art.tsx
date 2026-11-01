"use client";

// DELPHI, drawn live in PANTHEON's 1-bit dots: her portrait (public/upload/delphi.png) as a disc of
// ordered-dither squares on paper. She assembles from noise on arrival, the grid flickers 8 times a
// second, a scan line passes every 6s, and every 4.4s bands of the disc slip sideways with a
// magenta/teal fringe (the red/blue glitch). Reduced motion: one still frame.
//
// Cheap to run: the dither is worked out one pixel per cell, only when it changes, then scaled up
// under a fixed mask of square holes. Between changes a frame is just the scan line, or nothing.

import { useEffect, useRef } from "react";

const SRC = "/upload/delphi.png";
const INK = "#171717";
const PAPER = "#f9f9f9";
const MAGENTA = "#ff2e88";
const TEAL = "#22b8c9";
const STILL_AT = 1.6; // s in: assembled, between a glitch and a scan

// 8×8 Bayer thresholds (0–63).
const BAYER = [
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22, 3, 35, 11,
  43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
];
// The background never gets darker than this, so cells with a lower threshold stay blank there.
const BG_MIN = 0.935;
// Pixel words for ImageData (byte order RGBA in memory).
const LITTLE = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
const word = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return (LITTLE ? (255 << 24) | (b << 16) | (g << 8) | r : (r << 24) | (g << 16) | (b << 8) | 255) >>> 0;
};
const INK_W = word(INK);
const PAPER_W = word(PAPER);

function hash(x: number, y: number, s: number) {
  let h = (x * 374761393 + y * 668265263 + s * 982451653) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function vnoise(x: number, y: number, s: number) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi, s);
  const b = hash(xi + 1, yi, s);
  const c = hash(xi, yi + 1, s);
  const d = hash(xi + 1, yi + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

type Scene = {
  cols: number;
  rows: number;
  r: number;
  cx: number;
  cy: number;
  face: Float32Array; // her portrait, 0 (dark) to 1, 2r × 2r cells
  dpr: number;
  cellPx: number; // one cell, in device pixels
  dotPx: number;
  offPx: number;
  cells: HTMLCanvasElement; // one pixel per cell
  cellsCtx: CanvasRenderingContext2D;
  pixels: ImageData;
  words: Uint32Array;
  mask: CanvasPattern; // paper with one square hole per cell
  fringes: number[]; // y, first, last of each slipped row
  key: string;
};

function layout(img: HTMLImageElement, w: number, h: number, ctx: CanvasRenderingContext2D): Scene | null {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  // About 280 cells across the short side: 3px dots on a laptop, bigger on big screens.
  const cell = Math.max(2, Math.round(Math.min(w, h) / 280));
  const cellPx = Math.max(2, Math.round(cell * dpr));
  const dotPx = Math.max(1, Math.round(cellPx * 0.82));
  const offPx = Math.floor((cellPx - dotPx) / 2);
  const cols = Math.ceil((w * dpr) / cellPx);
  const rows = Math.ceil((h * dpr) / cellPx);
  // Her portrait as a big disc, a little above centre.
  const r = Math.floor(Math.min(cols, rows) * 0.39);
  if (r < 2) return null;

  const src = document.createElement("canvas");
  src.width = src.height = 2 * r;
  const g = src.getContext("2d", { willReadFrequently: true });
  const cells = document.createElement("canvas");
  cells.width = cols;
  cells.height = rows;
  const cellsCtx = cells.getContext("2d");
  const tile = document.createElement("canvas");
  tile.width = tile.height = cellPx;
  const t = tile.getContext("2d");
  if (!g || !cellsCtx || !t) return null;

  g.imageSmoothingQuality = "high";
  g.drawImage(img, 0, 0, 2 * r, 2 * r);
  const px = g.getImageData(0, 0, 2 * r, 2 * r).data;
  const face = new Float32Array(4 * r * r);
  for (let i = 0; i < face.length; i++) face[i] = px[i * 4] / 255;

  t.fillStyle = PAPER;
  t.fillRect(0, 0, cellPx, cellPx);
  t.clearRect(offPx, offPx, dotPx, dotPx);
  const mask = ctx.createPattern(tile, "repeat");
  if (!mask) return null;

  const pixels = cellsCtx.createImageData(cols, rows);
  const words = new Uint32Array(pixels.data.buffer);
  return { cols, rows, r, cx: Math.floor(cols / 2), cy: Math.floor(rows * 0.48), face, dpr, cellPx, dotPx, offPx, cells, cellsCtx, pixels, words, mask, fringes: [], key: "" };
}

// The glitch: a few bands of the disc slip sideways for a moment (one burst as she first resolves).
function glitchAt(ts: number) {
  const intro = ts > 1.25 && ts < 1.5;
  const on = intro || (ts > 2 && ts % 4.4 > 3.9 && ts % 4.4 < 4.1);
  return on ? (intro ? 999 + Math.floor(ts * 12) : Math.floor(ts / 4.4)) : -1;
}

/** What the dots look like at `ts`: the same until this changes. 8 times a second; 30 while she assembles. */
const keyAt = (ts: number) => (ts < 1.6 ? `a${Math.floor(ts * 30)}` : `${Math.floor(ts * 8)}:${glitchAt(ts)}`);

/** Work out every cell: dark or light. */
function dither(sc: Scene, ts: number) {
  const { cols, rows, r, cx, cy, face, words } = sc;
  const tick = Math.floor(ts * 8);
  const form = Math.min(1, ts / 1.4); // she assembles from noise on arrival
  const gc = glitchAt(ts);
  const bands =
    gc < 0
      ? []
      : [0, 1, 2, 3].map((i) => ({
          y: cy - r + Math.floor(hash(gc, i, 9) * 2 * r),
          h: 3 + Math.floor(hash(gc, i, 10) * 9),
          dx: (hash(gc, i, 11) > 0.5 ? 1 : -1) * (6 + Math.floor(hash(gc, i, 12) * 14)),
        }));
  const side = 2 * r;
  const r2 = r * r;
  const rim2 = (r - 1.2) * (r - 1.2);
  const fringes: number[] = [];
  words.fill(PAPER_W);
  for (let y = 0; y < rows; y++) {
    const band = bands.find((b) => y >= b.y && y < b.y + b.h);
    const dx = band ? band.dx : 0;
    const dy2 = (y - cy) * (y - cy);
    const fy = Math.min(side - 1, y - (cy - r));
    const row = y * cols;
    let first = -1;
    let last = -1;
    for (let x = 0; x < cols; x++) {
      const thr = (BAYER[(y & 7) * 8 + (x & 7)] + 0.5) / 64;
      const sx = x - dx;
      const d2 = (sx - cx) * (sx - cx) + dy2;
      if (sx >= 0 && sx < cols && d2 <= r2) {
        // A living grid: a few cells flicker each moment.
        const f = face[fy * side + Math.min(side - 1, sx - (cx - r))];
        const jitter = (hash(sx, y, tick) - 0.5) * 0.06;
        const m = Math.max(0, Math.min(1, (form - hash(sx, y, 77) * 0.54) / 0.4));
        let v = (0.04 + f * 0.92 + jitter) * m + (hash(x, y, tick + 1000) > 0.5 ? 0.2 : 1) * (1 - m);
        if (d2 > rim2) v = Math.min(v, 0.35); // the disc's rim
        if (v >= thr) continue;
        if (first < 0) first = x;
        last = x;
      } else {
        if (thr <= BG_MIN) continue;
        const n = vnoise(x * 0.05 + ts * 0.12, y * 0.05 - ts * 0.05, 3) * 0.7 + vnoise(x * 0.14 - ts * 0.2, y * 0.14, 9) * 0.3;
        if (0.985 + (n - 0.5) * 0.1 >= thr) continue;
      }
      words[row + x] = INK_W;
    }
    if (band && first >= 0) fringes.push(y, first, last);
  }
  sc.cellsCtx.putImageData(sc.pixels, 0, 0);
  sc.fringes = fringes;
}

const scanAt = (ts: number) => ts > 1.6 && ts % 6 > 2 && ts % 6 < 3.8;

/** Put the frame together, in device pixels: cells scaled up, the mask, fringes, the scan line. */
function compose(ctx: CanvasRenderingContext2D, sc: Scene, ts: number) {
  const { cols, rows, r, cx, cy, dpr, cellPx, dotPx, offPx, fringes } = sc;
  const w = cols * cellPx;
  const h = rows * cellPx;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(sc.cells, 0, 0, w, h);
  ctx.fillStyle = sc.mask;
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < fringes.length; i += 3) {
    const y = fringes[i] * cellPx + offPx;
    ctx.fillStyle = MAGENTA;
    ctx.fillRect((fringes[i + 1] - 3) * cellPx, y, 3 * cellPx, dotPx);
    ctx.fillStyle = TEAL;
    ctx.fillRect((fringes[i + 2] + 1) * cellPx, y, 3 * cellPx, dotPx);
  }
  // A slow scan down the disc, every 6s.
  if (scanAt(ts)) {
    const sp = ts % 6;
    const y = Math.round((cy - r + ((sp - 2) / 1.8) * 2 * r) * cellPx);
    const x0 = (cx - r - 6) * cellPx;
    const sw = (2 * r + 12) * cellPx;
    const fade = Math.round(26 * dpr);
    const line = Math.max(1, Math.round(dpr));
    const g = ctx.createLinearGradient(0, y - fade, 0, y);
    g.addColorStop(0, "rgba(23,23,23,0)");
    g.addColorStop(1, "rgba(23,23,23,0.08)");
    ctx.fillStyle = g;
    ctx.fillRect(x0, y - fade, sw, fade);
    ctx.fillStyle = MAGENTA;
    ctx.fillRect(x0, y - line, sw, line);
    ctx.fillStyle = TEAL;
    ctx.fillRect(x0, y + line, sw, line);
    ctx.fillStyle = INK;
    ctx.fillRect(x0, y, sw, line);
  }
}

export function DelphiArt({ className }: { className?: string }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const box = boxRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!box || !canvas || !ctx) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)");
    const img = new Image();
    let loaded = false;
    let scene: Scene | null = null;
    let start = 0;
    let raf = 0;
    let scanned = false;
    let onScreen = true;

    // Draw the frame at `now`, if anything on it changed.
    const paint = (now: number, force = false) => {
      if (!scene) return;
      const ts = still.matches ? STILL_AT : (now - start) / 1000;
      const key = keyAt(ts);
      const changed = key !== scene.key;
      if (changed) {
        dither(scene, ts);
        scene.key = key;
      }
      const scanning = scanAt(ts);
      if (changed || scanning || scanned || force) compose(ctx, scene, ts);
      scanned = scanning;
    };
    const fit = () => {
      if (!loaded) return;
      const rect = box.getBoundingClientRect();
      scene = layout(img, Math.round(rect.width), Math.round(rect.height), ctx);
      if (!scene) return;
      canvas.width = scene.cols * scene.cellPx;
      canvas.height = scene.rows * scene.cellPx;
      canvas.style.width = `${canvas.width / scene.dpr}px`;
      canvas.style.height = `${canvas.height / scene.dpr}px`;
      paint(performance.now(), true);
    };
    const loop = (now: number) => {
      raf = 0;
      if (still.matches || !onScreen) return;
      raf = requestAnimationFrame(loop);
      paint(now);
    };
    const run = () => {
      if (!raf && loaded && onScreen && !still.matches) raf = requestAnimationFrame(loop);
    };

    img.onload = () => {
      loaded = true;
      start = performance.now();
      fit();
      run();
    };
    img.src = SRC;

    const resize = new ResizeObserver(fit);
    resize.observe(box);
    // Paused while scrolled out of view (phones), and in background tabs by the browser.
    const view = new IntersectionObserver(([e]) => {
      onScreen = e.isIntersecting;
      run();
    });
    view.observe(box);
    const motion = () => {
      paint(performance.now(), true);
      run();
    };
    still.addEventListener("change", motion);
    return () => {
      img.onload = null;
      cancelAnimationFrame(raf);
      resize.disconnect();
      view.disconnect();
      still.removeEventListener("change", motion);
    };
  }, []);

  return (
    <div ref={boxRef} className={className} role="img" aria-label="DELPHI">
      <canvas ref={canvasRef} />
    </div>
  );
}
