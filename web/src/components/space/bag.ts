// Your bag, drawn: one tile per coin on a dark card, worst first, and the passport's liquid-glass lens
// riding on them. The tiles are chips you could pick up: white porcelain for a flagged coin, etched smoked
// glass for one on watch, graphite for a clean one, an outline for one too new to judge; each lit from
// above and casting a soft shadow on the card. The lens rests on the coin you're looking at and glides to
// the one you point at: it lifts as it moves, stretches with its speed and settles with a little give,
// like the iOS 26 tab-bar lens it's traced from. It magnifies the tile under it and bends the light at
// its rim, where a highlight runs round the edge from the light above; under a finger it lights from
// inside. It arrives the way Apple's glass does, by bending the light in, not by fading. The tiles are a
// 2D canvas with nothing painted between them (the card shows through); the glass is WebGL over it,
// sampling a sharper copy. Without WebGL the chosen tile gets a ring. The buttons laid over the tiles
// (space.tsx) do the clicking, the keys and the reading aloud.

import { clamp, makeProgram, rrect, spaced } from "@/components/passport-book/draw";
import type { Verdict } from "./data";

export type TileKind = Verdict | "MORE";
export type TileItem = { label: string; kind: TileKind };
export type Rect = { x: number; y: number; w: number; h: number };
export type Tiles = { rects: Rect[]; W: number; H: number; radius: number; font: number; lens: [number, number]; shown: number };

/**
 * Tiles to fill `width`. A small bag (four coins or fewer) gets big tiles in one row. A fuller one gets a
 * grid to the edges with its rows kept even: the fewest rows that hold the coins, then the fewest columns
 * that fill them (fourteen coins lie 5, 5, 4, not 6, 6, 2). A big bag keeps to a few rows, and its last
 * place says how many more there are.
 */
export function layoutTiles(width: number, count: number, compact: boolean): Tiles {
  const gap = compact ? 8 : 10;
  const want = compact ? 64 : 96;
  const maxRows = compact ? 5 : 4;
  const maxCols = Math.max(2, Math.floor((width + gap) / (want + gap)));
  if (count > 0 && count <= Math.min(4, maxCols)) {
    const w = Math.min(compact ? 200 : 240, (width - (count - 1) * gap) / count);
    const h = compact ? 68 : 88;
    const pad = compact ? 9 : 12;
    const rects = Array.from({ length: count }, (_, i) => ({ x: i * (w + gap), y: 0, w, h }));
    return { rects, W: width, H: h, radius: compact ? 16 : 20, font: compact ? 13 : 15, lens: [w / 2 + pad, h / 2 + pad], shown: count };
  }
  const cap = maxCols * maxRows;
  const total = Math.min(count, cap);
  const shown = count > cap ? cap - 1 : count;
  const rows = Math.max(1, Math.ceil(total / maxCols));
  const cols = Math.max(2, Math.ceil(total / rows));
  const w = (width - (cols - 1) * gap) / cols;
  const h = compact ? 46 : 54;
  const pad = compact ? 7 : 9;
  const rects = Array.from({ length: total }, (_, i) => ({ x: (i % cols) * (w + gap), y: Math.floor(i / cols) * (h + gap), w, h }));
  return { rects, W: width, H: rows * h + (rows - 1) * gap, radius: compact ? 12 : 14, font: compact ? 11 : 12, lens: [w / 2 + pad, h / 2 + pad], shown };
}

// ------------------------------------------------------------------ the tiles (2D)

// Each tile is a chip lit from above: its face a little lighter at the top, a fine highlight on its top
// edge that fades down its sides, and, if it's solid, a soft shadow on the card under it. Flagged is the
// one white chip; the rest stay quiet. Outlines (too new, not read, the rest of a big bag) cast nothing:
// there's nothing there yet.
type Style = {
  /** The face, top to bottom. */
  face?: [string, string];
  /** The light on its top edge. */
  top?: string;
  edge?: string;
  lw?: number;
  dash?: number[];
  hatch?: string;
  /** How much it lifts off the card. */
  lift?: number;
  text: string;
};
const STYLE: Record<TileKind, Style> = {
  FLAG: { face: ["#ffffff", "#e2e2e2"], top: "rgba(255,255,255,1)", lift: 1, text: "#111111" },
  WATCH: { face: ["rgba(255,255,255,0.085)", "rgba(255,255,255,0.03)"], top: "rgba(255,255,255,0.22)", edge: "rgba(255,255,255,0.88)", lw: 1.25, hatch: "rgba(255,255,255,0.1)", lift: 0.8, text: "#ffffff" },
  CLEAN: { face: ["rgba(255,255,255,0.1)", "rgba(255,255,255,0.05)"], top: "rgba(255,255,255,0.14)", lift: 0.8, text: "rgba(255,255,255,0.76)" },
  NOT_ENOUGH_DATA: { edge: "rgba(255,255,255,0.38)", lw: 1, dash: [4, 3.5], text: "rgba(255,255,255,0.62)" },
  UNKNOWN: { edge: "rgba(255,255,255,0.4)", lw: 1.4, dash: [0.01, 4], text: "rgba(255,255,255,0.5)" },
  MORE: { face: ["rgba(255,255,255,0.04)", "rgba(255,255,255,0.015)"], edge: "rgba(255,255,255,0.16)", lw: 1, text: "rgba(255,255,255,0.66)" },
};
/** The card under the tiles: the colour the glass sees past them (the card's own colour there). */
export const CARD_BG: [number, number, number] = [21, 21, 21];

function fit(ctx: CanvasRenderingContext2D, text: string, max: number, sp: number) {
  const width = (t: string) => [...t].reduce((w, ch) => w + ctx.measureText(ch).width + sp, -sp);
  if (width(text) <= max) return text;
  let t = text;
  while (t.length > 1 && width(`${t}…`) > max) t = t.slice(0, -1);
  return `${t}…`;
}

/**
 * A shadow on its own, without the shape that casts it: the shape is drawn far off the canvas and only its
 * shadow is thrown back (shadow offsets are in the canvas's own pixels, so `k` is the scale in use).
 */
function shadow(ctx: CanvasRenderingContext2D, k: number, path: () => void, blur: number, dy: number, color: string) {
  const far = 4000;
  ctx.save();
  ctx.translate(far, 0);
  path();
  ctx.shadowColor = color;
  ctx.shadowBlur = blur * k;
  ctx.shadowOffsetX = -far * k;
  ctx.shadowOffsetY = dy * k;
  ctx.fillStyle = "#000";
  ctx.fill();
  ctx.restore();
}

function paintTiles(canvas: HTMLCanvasElement, scale: number, T: Tiles, items: TileItem[], M: number, mono: string, appear: (i: number) => number, ring: { x: number; y: number; on: number } | null) {
  const w = Math.round((T.W + 2 * M) * scale), h = Math.round((T.H + 2 * M) * scale);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, T.W + 2 * M, T.H + 2 * M);
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const R = T.radius;
  T.rects.forEach((r, i) => {
    const it = items[i];
    if (!it) return;
    const a = appear(i);
    if (a <= 0.001) return;
    const S = STYLE[it.kind];
    // pressing in: from a little small and a little low, into place
    const s = 0.94 + 0.06 * a;
    const cx = M + r.x + r.w / 2, cy = M + r.y + r.h / 2 + (1 - a) * 5;
    const k = scale * s;
    const body = () => rrect(ctx, 0, 0, r.w, r.h, R);
    ctx.save();
    ctx.globalAlpha = a;
    ctx.translate(cx, cy);
    ctx.scale(s, s);
    ctx.translate(-r.w / 2, -r.h / 2);
    // its shadow on the card: a close one where it touches, and a soft one under it
    if (S.lift) {
      shadow(ctx, k, body, 2, 1, `rgba(0,0,0,${0.55 * S.lift})`);
      shadow(ctx, k, body, 12, 5, `rgba(0,0,0,${0.5 * S.lift})`);
    }
    if (S.face) {
      body();
      const g = ctx.createLinearGradient(0, 0, 0, r.h);
      g.addColorStop(0, S.face[0]);
      g.addColorStop(1, S.face[1]);
      ctx.fillStyle = g;
      ctx.fill();
    }
    if (S.hatch) {
      // etched lines, kept a little inside the edge
      ctx.save();
      rrect(ctx, 1.5, 1.5, r.w - 3, r.h - 3, R - 1.5);
      ctx.clip();
      ctx.strokeStyle = S.hatch;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = -r.h; x < r.w + r.h; x += 5) {
        ctx.moveTo(x, r.h);
        ctx.lineTo(x + r.h, 0);
      }
      ctx.stroke();
      ctx.restore();
    }
    if (S.edge) {
      const lw = S.lw ?? 1;
      rrect(ctx, lw / 2, lw / 2, r.w - lw, r.h - lw, R - lw / 2);
      ctx.setLineDash(S.dash ?? []);
      ctx.lineCap = "round";
      ctx.strokeStyle = S.edge;
      ctx.lineWidth = lw;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineCap = "butt";
    }
    if (S.top) {
      // the light on its top edge, fading down its sides
      ctx.save();
      body();
      ctx.clip();
      const g = ctx.createLinearGradient(0, 0, 0, Math.min(r.h, 2 * R + 6));
      g.addColorStop(0, S.top);
      g.addColorStop(1, "rgba(255,255,255,0)");
      rrect(ctx, 0.5, 0.5, r.w - 1, r.h - 1, R - 0.5);
      ctx.strokeStyle = g;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
    }
    if (it.kind === "FLAG") {
      // porcelain: a little shade along its foot
      ctx.save();
      body();
      ctx.clip();
      const g = ctx.createLinearGradient(0, r.h - 10, 0, r.h);
      g.addColorStop(0, "rgba(0,0,0,0)");
      g.addColorStop(1, "rgba(0,0,0,0.07)");
      ctx.fillStyle = g;
      ctx.fillRect(0, r.h - 10, r.w, 10);
      ctx.restore();
    }
    ctx.fillStyle = S.text;
    ctx.font = `600 ${T.font}px ${mono}`;
    const sp = T.font * 0.07;
    const label = fit(ctx, it.label, r.w - (T.font < 12 ? 12 : 18), sp);
    spaced(ctx, label, r.w / 2, r.h / 2 + 0.5, sp, "center");
    ctx.restore();
  });
  // no glass: a ring marks the tile you're on
  if (ring && ring.on > 0) {
    const r = T.rects[0];
    if (r) {
      ctx.save();
      ctx.globalAlpha = ring.on;
      rrect(ctx, M + ring.x - r.w / 2 - 4, M + ring.y - r.h / 2 - 4, r.w + 8, r.h + 8, R + 4);
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
    }
  }
}

// ------------------------------------------------------------------ the glass (WebGL)
// The passport's lens (passport-book/card.ts), on a dark card, sampling the tiles under it. Clear glass
// with a rounded rim: flat across the middle, where it magnifies, and curving down over its outer edge,
// where it bends in what lies just past it (Apple: the light concentrates at the edges). The light comes
// from above on the left, swings a little with the pointer and lags the motion; it runs round the rim
// as a fine highlight, with a softer bounce on the far edge and a broad sheen over the top of the face.
// No colour splits off at its edge: the page stays black and white. It throws a soft shadow on the
// tiles, deeper while it is lifted, and a finger on it lights it from inside.
const FRAG = `precision highp float;
uniform sampler2D uTex;
uniform vec2 uRes;
uniform float uDpr;
uniform vec2 uSize;
uniform vec2 uC;
uniform vec2 uHalf;
uniform float uAngle;
uniform float uStretch;
uniform float uMat;
uniform vec3 uBg;
uniform vec2 uLight;
uniform float uR;
uniform float uPress;
uniform float uLift;

vec2 local(vec2 f){
  vec2 p = f - uC;
  float c = cos(uAngle), s = sin(uAngle);
  vec2 q = vec2(c * p.x + s * p.y, -s * p.x + c * p.y);
  q /= vec2(1.0 + uStretch, 1.0 - 0.5 * uStretch);
  return vec2(c * q.x - s * q.y, s * q.x + c * q.y);
}
// the lens's outline: the tile's own shape grown by the gap round it, its corners concentric with the
// tile's (Apple's rule for nested shapes: the outer radius is the inner one plus the padding)
float sdRound(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
float lens(vec2 f){ return sdRound(local(f), uHalf, min(uR, min(uHalf.x, uHalf.y))); }
vec3 under(vec2 f){
  vec2 uv = f / uSize;
  vec4 t = (uv.x >= 0.0 && uv.y >= 0.0 && uv.x <= 1.0 && uv.y <= 1.0) ? texture2D(uTex, uv) : vec4(0.0);
  return mix(uBg, t.rgb, t.a);
}

void main(){
  vec2 f = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uDpr;
  float px = 1.0 / uDpr;
  float b = uHalf.y;
  float d = lens(f);
  // its shadow on the tiles: soft, a little low, deeper and further down while it's lifted, and gone well
  // inside the canvas (so it never ends in an edge)
  float ds = lens(f - vec2(0.0, 3.0 + 4.0 * uLift));
  float shadow = (1.0 - smoothstep(-6.0, 20.0 + 10.0 * uLift, ds)) * (0.3 + 0.18 * uLift) * uMat;
  if (d > 1.5 * px && shadow < 0.002) { gl_FragColor = vec4(0.0); return; }

  vec2 e = vec2(0.5, 0.0);
  vec2 grad = vec2(lens(f + e.xy) - lens(f - e.xy), lens(f + e.yx) - lens(f - e.yx));
  vec2 n = grad / max(length(grad), 1e-5);
  float depth = max(-d, 0.0);
  // the rim: flat in the middle, curving down over the outer edge, steepest right at it
  float rimW = min(0.46 * b, 16.0);
  float t = clamp(depth / rimW, 0.0, 1.0);
  float slope = (1.0 - t) * (1.0 - t) * (1.0 + 0.35 * (1.0 - t));
  float zoom = mix(1.0, 1.12, uMat);
  vec2 base = uC + (f - uC) / zoom;
  vec2 off = n * b * 0.34 * slope * uMat;
  vec3 col = under(base + off);

  vec2 q = local(f);
  float v = clamp(q.y / b, -1.0, 1.0);
  // clear glass: a faint lift in brightness, a touch more at the top, where it catches the light
  col = mix(col, vec3(1.0), 0.03 + 0.03 * (0.5 - 0.5 * v));
  // a broad soft sheen over the upper face (the curved top reflecting the light above)
  col += vec3(1.0) * smoothstep(0.2, -0.9, v) * smoothstep(0.0, 0.7, t) * 0.045 * uMat;
  vec2 Ld = normalize(vec2(-0.5 + uLight.x * 0.6, -0.86 + uLight.y * 0.4));
  float facing = max(dot(n, Ld), 0.0);
  float spec = pow(facing, 4.0) * exp(-depth / (rimW * 0.24));
  float bounce = pow(max(dot(n, -Ld), 0.0), 3.0) * exp(-depth / (rimW * 0.16));
  col += vec3(1.0) * (spec * 0.62 + bounce * 0.2) * uMat;
  // the light travels round the edge: the rim is brighter than the face
  col += vec3(1.0) * slope * 0.055 * uMat;
  float hair = exp(-pow((depth - 1.1) / 0.75, 2.0));
  col += vec3(1.0) * hair * (0.16 + 0.42 * facing);
  float edge = exp(-pow((d + 0.3) / 0.75, 2.0));
  col = mix(col, vec3(0.0), edge * 0.3);
  // a finger on it lights it from inside, from the middle out
  vec2 g = q / max(uHalf, vec2(1.0));
  col += vec3(1.0) * exp(-dot(g, g) * 1.4) * 0.11 * uPress * uMat;

  float a = smoothstep(px, -px, d) * clamp(uMat * 1.6, 0.0, 1.0);
  vec4 outside = vec4(0.0, 0.0, 0.0, shadow * (1.0 - smoothstep(px, -px, d)));
  gl_FragColor = vec4(clamp(col, 0.0, 1.0) * a, a) + outside * (1.0 - a);
}`;
const NAMES = ["uTex", "uRes", "uDpr", "uSize", "uC", "uHalf", "uAngle", "uStretch", "uMat", "uBg", "uLight", "uR", "uPress", "uLift"] as const;

/** `host` takes the pointer; the two canvases are made inside `layer`, under the tile buttons. */
export type BagEls = { host: HTMLElement; layer: HTMLElement };
export type BagEvents = {
  /** The pointer is over a tile (or a finger drags across one); null when it leaves. */
  hover(i: number | null): void;
  /** A finger dragged the lens and let go on a tile. */
  pick(i: number): void;
};

/** How far past the tiles the canvases reach, so the glass and its shadow can hang over the edge. */
export const MARGIN = 48;

export function createBag(els: BagEls, on: BagEvents, reduced: boolean) {
  const { host, layer } = els;
  // Canvases made here, not kept by the page: after a cached navigation the effect runs again, and a
  // WebGL canvas whose context was let go can't be used twice.
  const face = document.createElement("canvas");
  const glass = document.createElement("canvas");
  for (const c of [face, glass]) {
    c.setAttribute("aria-hidden", "true");
    c.style.position = "absolute";
    c.style.pointerEvents = "none";
    layer.appendChild(c);
  }
  const sharp = document.createElement("canvas");
  const prog = makeProgram(glass, FRAG, NAMES);
  const tex = prog?.texture(0) ?? null;
  if (prog) prog.gl.uniform1i(prog.U.uTex, 0);
  else glass.remove();
  let dragged = false;

  let T: Tiles | null = null;
  let items: TileItem[] = [];
  let mono = '"Geist Mono", monospace';
  let dpr = 1;
  const M = MARGIN;
  // when the tiles first came, and when the glass was first sent somewhere: the two entrances
  let born = 0, matAt = 0, wasIntro = true;

  // ---------------------------------------------------------------- motion
  const S = { x: 0, y: 0, vx: 0, vy: 0, sx: 0, sy: 0, svx: 0, svy: 0, k: 0.7, vk: 0, mat: 0, tx: 0, ty: 0, press: 0, drag: false, placed: false, lx: 0, ly: 0, tlx: 0, tly: 0, lift: 0, glow: 0 };
  let target = -1, want = -1;
  // the lens's place: tile i's centre; the first time, it's simply there
  const go = (i: number) => {
    if (!T || i < 0) return;
    target = Math.min(i, T.rects.length - 1);
    const [x, y] = centre(target);
    S.tx = x;
    S.ty = y;
    if (!S.placed) {
      S.x = x;
      S.y = y;
      S.placed = true;
    }
  };
  const centre = (i: number): [number, number] => {
    const r = T?.rects[i];
    return r ? [r.x + r.w / 2, r.y + r.h / 2] : [0, 0];
  };
  // the tiles press in one after another, worst first, as the card comes to rest
  const appear = (i: number) => {
    if (reduced) return 1;
    if (!born) return 0;
    const t = (performance.now() - born) / 1000 - 0.36 - Math.min(i * 0.03, 0.5);
    const x = clamp(t / 0.45, 0, 1);
    return 1 - Math.pow(1 - x, 3);
  };
  const introDone = () => reduced || (!!born && (performance.now() - born) / 1000 > 0.36 + Math.min(((T?.rects.length ?? 1) - 1) * 0.03, 0.5) + 0.45);
  const place = () => {
    if (!T) return;
    for (const c of [face, glass]) Object.assign(c.style, { left: `${-M}px`, top: `${-M}px`, width: `${T.W + 2 * M}px`, height: `${T.H + 2 * M}px` });
  };

  const nearest = (x: number, y: number) => {
    if (!T) return -1;
    let best = -1, bd = Infinity;
    T.rects.forEach((r, i) => {
      const dx = Math.max(r.x - x, 0, x - (r.x + r.w)), dy = Math.max(r.y - y, 0, y - (r.y + r.h));
      const dd = dx * dx + dy * dy;
      if (dd < bd) {
        bd = dd;
        best = i;
      }
    });
    return best;
  };
  const toLocal = (e: PointerEvent): [number, number] => {
    const r = host.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const inside = (x: number, y: number) => !!T && T.rects.some((r) => x >= r.x - 3 && x <= r.x + r.w + 3 && y >= r.y - 3 && y <= r.y + r.h + 3);

  let hovered: number | null = null;
  let downAt: [number, number] | null = null;
  const setHover = (i: number | null) => {
    if (i === hovered) return;
    hovered = i;
    on.hover(i);
  };
  const onMove = (e: PointerEvent) => {
    const [x, y] = toLocal(e);
    S.tlx = clamp((x / Math.max(1, T?.W ?? 1)) * 2 - 1, -1, 1);
    S.tly = clamp((y / Math.max(1, T?.H ?? 1)) * 2 - 1, -1, 1);
    if (e.pointerType === "mouse") {
      setHover(inside(x, y) ? nearest(x, y) : null);
    } else if (S.press) {
      if (downAt && Math.hypot(x - downAt[0], y - downAt[1]) > 8) S.drag = true;
      if (S.drag && T) {
        // a finger takes the glass with it, free, then it settles on a tile when let go
        S.tx = clamp(x, 0, T.W);
        S.ty = clamp(y, 0, T.H);
        setHover(nearest(x, y));
      }
    }
    wake();
  };
  const onLeave = (e: PointerEvent) => {
    if (e.pointerType === "mouse") setHover(null);
    S.tlx = S.tly = 0;
    wake();
  };
  const onDown = (e: PointerEvent) => {
    if (e.pointerType === "mouse") return;
    const [x, y] = toLocal(e);
    downAt = [x, y];
    S.press = 1;
    S.drag = false;
    wake();
  };
  const onUp = (e: PointerEvent) => {
    if (e.pointerType === "mouse") return;
    const wasDrag = S.drag;
    S.press = 0;
    S.drag = false;
    downAt = null;
    dragged = wasDrag;
    if (wasDrag && hovered !== null) on.pick(hovered);
    setHover(null);
    wake();
  };
  host.addEventListener("pointermove", onMove);
  host.addEventListener("pointerleave", onLeave);
  host.addEventListener("pointerdown", onDown);
  host.addEventListener("pointerup", onUp);
  host.addEventListener("pointercancel", onUp);

  // ---------------------------------------------------------------- drawing
  let raf = 0, last = 0, alive = true, visible = true;
  const io = new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    if (visible) wake();
  });
  io.observe(host);
  function wake() {
    if (!raf && alive) {
      last = 0;
      raf = requestAnimationFrame(frame);
    }
  }
  function paint() {
    if (!T) return;
    const ring = prog ? null : { x: S.x, y: S.y, on: target >= 0 ? 1 : 0 };
    paintTiles(face, dpr, T, items, M, mono, appear, ring);
  }
  function frame(now: number) {
    raf = 0;
    if (!alive || !T) return;
    if (!visible || document.hidden) return;
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
    last = now;
    const intro = !introDone();
    const steps = Math.max(1, Math.round(dt / (1 / 240)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      if (reduced) {
        S.x = S.tx;
        S.y = S.ty;
        S.vx = S.vy = S.sx = S.sy = 0;
        S.k = 1;
        S.mat = 1;
        S.lift = 0;
        S.glow = S.press;
        break;
      }
      // position: a quick spring that just overshoots (under a finger it follows closer)
      const kp = S.drag ? 520 : 300, cp = 2 * Math.sqrt(kp) * (S.drag ? 0.9 : 0.74);
      S.vx += (kp * (S.tx - S.x) - cp * S.vx) * h;
      S.vy += (kp * (S.ty - S.y) - cp * S.vy) * h;
      S.x += S.vx * h;
      S.y += S.vy * h;
      // shape: stretches with its speed like a gel, and wobbles back when it stops, but not for long
      const sp = Math.hypot(S.vx, S.vy);
      const want = Math.min(sp / 3200, 0.12);
      const dx = sp > 1e-3 ? S.vx / sp : 1, dy = sp > 1e-3 ? S.vy / sp : 0;
      S.svx += (210 * (dx * want - S.sx) - 13 * S.svx) * h;
      S.svy += (210 * (dy * want - S.sy) - 13 * S.svy) * h;
      S.sx += S.svx * h;
      S.sy += S.svy * h;
      // lift: it rises off the tiles while it travels and under a finger, and comes down with a little give
      S.lift += (Math.min(1, sp / 700) + 0.6 * S.press - S.lift) * Math.min(1, h * 10);
      S.vk += (260 * (1 + 0.05 * Math.min(1, S.lift) + 0.08 * S.press - S.k) - 15 * S.vk) * h;
      S.k += S.vk * h;
      // a finger's light from inside comes and goes with it
      S.glow += (S.press - S.glow) * Math.min(1, h * 9);
      // the light bends in: the glass arrives as its lensing grows, not as a fade
      const m = target >= 0 && matAt ? clamp((now - matAt) / 700, 0, 1) : 0;
      S.mat = 1 - Math.pow(1 - m, 3);
      S.lx += (S.tlx - S.lx) * Math.min(1, h * 5);
      S.ly += (S.tly - S.ly) * Math.min(1, h * 5);
    }
    // painted while the tiles press in, once more as they finish, and every frame for the ring
    if (intro || wasIntro || !prog) paint();
    wasIntro = intro;
    draw();
    const settled =
      Math.abs(S.tx - S.x) < 0.05 &&
      Math.abs(S.ty - S.y) < 0.05 &&
      Math.hypot(S.vx, S.vy) < 0.05 &&
      Math.hypot(S.sx, S.sy) < 0.001 &&
      Math.abs(S.lift - 0.6 * S.press) < 0.002 &&
      Math.abs(S.k - (1 + 0.05 * Math.min(1, S.lift) + 0.08 * S.press)) < 0.001 &&
      Math.abs(S.vk) < 0.01 &&
      Math.abs(S.glow - S.press) < 0.002 &&
      (S.mat >= 1 || target < 0) &&
      Math.abs(S.tlx - S.lx) < 0.01 &&
      Math.abs(S.tly - S.ly) < 0.01;
    if (!intro && settled) {
      if (!prog) paint();
      return;
    }
    raf = requestAnimationFrame(frame);
  }
  function draw() {
    if (!prog || !T) return;
    const { gl, U } = prog;
    const cw = Math.round((T.W + 2 * M) * dpr), ch = Math.round((T.H + 2 * M) * dpr);
    if (glass.width !== cw || glass.height !== ch) {
      glass.width = cw;
      glass.height = ch;
    }
    gl.viewport(0, 0, cw, ch);
    const st = Math.hypot(S.sx, S.sy);
    const ang = st > 1e-4 ? Math.atan2(S.sy, S.sx) : 0;
    const sign = S.sx * Math.cos(ang) + S.sy * Math.sin(ang) >= 0 ? 1 : -1;
    gl.uniform2f(U.uRes, cw, ch);
    gl.uniform1f(U.uDpr, dpr);
    gl.uniform2f(U.uSize, T.W + 2 * M, T.H + 2 * M);
    gl.uniform2f(U.uC, S.x + M, S.y + M);
    gl.uniform2f(U.uHalf, T.lens[0] * S.k, T.lens[1] * S.k);
    gl.uniform1f(U.uAngle, ang);
    gl.uniform1f(U.uStretch, st * sign);
    gl.uniform1f(U.uMat, target >= 0 ? S.mat : 0);
    gl.uniform3f(U.uBg, CARD_BG[0] / 255, CARD_BG[1] / 255, CARD_BG[2] / 255);
    // the light swings with the pointer and lags behind the glass as it travels
    gl.uniform2f(U.uLight, S.lx - clamp(S.vx / 2000, -0.4, 0.4), S.ly - clamp(S.vy / 2000, -0.4, 0.4));
    gl.uniform1f(U.uR, (T.radius + (T.lens[1] - T.rects[0].h / 2)) * S.k);
    gl.uniform1f(U.uPress, S.glow);
    gl.uniform1f(U.uLift, clamp(S.lift, 0, 1));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  return {
    /** Whether the glass is drawn (WebGL), or the ring stands in for it. */
    glass: !!prog,
    /** Lays the tiles out and paints them. */
    set(tiles: Tiles, next: TileItem[], monoFont: string) {
      T = tiles;
      items = next;
      mono = monoFont;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (!born && next.length) {
        born = performance.now();
        matAt = born + (reduced ? 0 : 760);
        wasIntro = true;
      }
      place();
      paint();
      // the copy the glass looks through: sharper, so the magnified tile stays crisp
      if (prog && tex) {
        paintTiles(sharp, Math.min(dpr * 1.6, 3.5), T, items, M, mono, () => 1, null);
        prog.upload(0, tex, sharp);
      }
      go(want);
      wake();
    },
    /** Sends the lens to tile `i` (kept until the tiles are laid out, if they aren't yet). */
    aim(i: number) {
      want = i;
      if (S.drag) return;
      go(i);
      wake();
    },
    /** Nothing to draw (an empty bag, or one not read yet): wipes the tiles and puts the glass away. */
    clear() {
      T = null;
      items = [];
      target = -1;
      want = -1;
      S.placed = false;
      for (const c of [face, glass]) {
        c.width = 1;
        c.height = 1;
        Object.assign(c.style, { width: "0px", height: "0px" });
      }
    },
    /** True once, right after a finger dragged the lens: the click that follows isn't a tap. */
    consumeDrag() {
      const d = dragged;
      dragged = false;
      return d;
    },
    destroy() {
      alive = false;
      cancelAnimationFrame(raf);
      io.disconnect();
      host.removeEventListener("pointermove", onMove);
      host.removeEventListener("pointerleave", onLeave);
      host.removeEventListener("pointerdown", onDown);
      host.removeEventListener("pointerup", onUp);
      host.removeEventListener("pointercancel", onUp);
      prog?.destroy();
      face.remove();
      glass.remove();
    },
  };
}
