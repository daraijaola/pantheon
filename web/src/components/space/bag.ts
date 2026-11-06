// Your bag, drawn: one tile per coin on a dark card, worst first, and the passport's liquid-glass lens
// riding on them. The lens rests on the coin you're looking at and glides to the one you point at: it
// stretches as it moves and wobbles as it stops, like the iOS 26 tab-bar lens it's traced from. It
// magnifies the tile under it; past its rim the tiles bend and split into colour. It arrives the way
// Apple's glass does, by bending the light in, not by fading. The tiles are a 2D canvas; the glass is
// WebGL over it, sampling a sharper copy. Without WebGL the chosen tile gets a ring. The buttons laid
// over the tiles (space.tsx) do the clicking, the keys and the reading aloud.

import { clamp, makeProgram, rrect, spaced } from "@/components/passport-book/draw";
import type { Verdict } from "./data";

export type TileKind = Verdict | "MORE";
export type TileItem = { label: string; kind: TileKind };
export type Rect = { x: number; y: number; w: number; h: number };
export type Tiles = { rects: Rect[]; W: number; H: number; radius: number; font: number; lens: [number, number]; shown: number };

/**
 * Tiles to fill `width`: as many columns as fit at about the size a ticker needs, stretched to the
 * edges. A big bag keeps to a few rows, and its last place says how many more there are.
 */
export function layoutTiles(width: number, count: number, compact: boolean): Tiles {
  const gap = compact ? 6 : 8;
  const want = compact ? 72 : 92;
  const maxRows = compact ? 5 : 4;
  const cols = Math.max(2, Math.floor((width + gap) / (want + gap)));
  const cap = cols * maxRows;
  const total = Math.min(count, cap);
  const shown = count > cap ? cap - 1 : count;
  // a small bag (four coins or fewer) gets big tiles across the card; a fuller one, a grid to the edges
  const few = count > 0 && count <= Math.min(4, cols);
  const across = few ? count : cols;
  const w = few ? Math.min(compact ? 200 : 240, (width - (across - 1) * gap) / across) : (width - (cols - 1) * gap) / cols;
  const h = few ? (compact ? 64 : 84) : compact ? 42 : 50;
  const rects = Array.from({ length: total }, (_, i) => ({ x: (i % across) * (w + gap), y: Math.floor(i / across) * (h + gap), w, h }));
  const rows = Math.max(1, Math.ceil(total / across));
  const pad = compact ? 7 : few ? 11 : 9;
  return { rects, W: width, H: rows * h + (rows - 1) * gap, radius: few ? (compact ? 14 : 18) : compact ? 11 : 13, font: few ? (compact ? 13 : 15) : compact ? 11 : 12, lens: [w / 2 + pad, h / 2 + pad], shown };
}

// ------------------------------------------------------------------ the tiles (2D)

// Each tile is lit from above, like a key: a little lighter at the top, with a fine highlight on its
// top edge. Flagged is the one white tile; the rest stay quiet.
type Style = { fill?: [string, string]; stroke?: string; lw?: number; dash?: number[]; hatch?: string; lip?: string; text: string };
const STYLE: Record<TileKind, Style> = {
  FLAG: { fill: ["#ffffff", "#ededed"], text: "#141414" },
  WATCH: { fill: ["rgba(255,255,255,0.07)", "rgba(255,255,255,0.02)"], stroke: "rgba(255,255,255,0.92)", lw: 1.5, hatch: "rgba(255,255,255,0.13)", text: "#ffffff" },
  NOT_ENOUGH_DATA: { stroke: "rgba(255,255,255,0.34)", lw: 1, dash: [4, 3], text: "rgba(255,255,255,0.62)" },
  UNKNOWN: { stroke: "rgba(255,255,255,0.26)", lw: 1, dash: [2, 3], text: "rgba(255,255,255,0.5)" },
  CLEAN: { fill: ["rgba(255,255,255,0.085)", "rgba(255,255,255,0.05)"], lip: "rgba(255,255,255,0.09)", text: "rgba(255,255,255,0.72)" },
  MORE: { stroke: "rgba(255,255,255,0.16)", lw: 1, text: "rgba(255,255,255,0.62)" },
};
/** The card under the tiles: the colour the glass sees past them. */
export const CARD_BG: [number, number, number] = [20, 20, 21];

function fit(ctx: CanvasRenderingContext2D, text: string, max: number, sp: number) {
  const width = (t: string) => [...t].reduce((w, ch) => w + ctx.measureText(ch).width + sp, -sp);
  if (width(text) <= max) return text;
  let t = text;
  while (t.length > 1 && width(`${t}…`) > max) t = t.slice(0, -1);
  return `${t}…`;
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
  T.rects.forEach((r, i) => {
    const it = items[i];
    if (!it) return;
    const a = appear(i);
    if (a <= 0.001) return;
    const S = STYLE[it.kind];
    const s = 0.94 + 0.06 * a;
    const cx = M + r.x + r.w / 2, cy = M + r.y + r.h / 2;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.translate(cx, cy);
    ctx.scale(s, s);
    ctx.translate(-r.w / 2, -r.h / 2);
    rrect(ctx, 0, 0, r.w, r.h, T.radius);
    if (S.fill) {
      const g = ctx.createLinearGradient(0, 0, 0, r.h);
      g.addColorStop(0, S.fill[0]);
      g.addColorStop(1, S.fill[1]);
      ctx.fillStyle = g;
      ctx.fill();
    }
    if (S.lip) {
      ctx.save();
      ctx.clip();
      rrect(ctx, 0.5, 0.5, r.w - 1, r.h + T.radius, T.radius - 0.5);
      ctx.strokeStyle = S.lip;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
      rrect(ctx, 0, 0, r.w, r.h, T.radius);
    }
    if (S.hatch) {
      ctx.save();
      ctx.clip();
      ctx.strokeStyle = S.hatch;
      ctx.lineWidth = 1;
      for (let x = -r.h; x < r.w + r.h; x += 6) {
        ctx.beginPath();
        ctx.moveTo(x, r.h);
        ctx.lineTo(x + r.h, 0);
        ctx.stroke();
      }
      ctx.restore();
    }
    if (S.stroke) {
      const lw = S.lw ?? 1;
      rrect(ctx, lw / 2, lw / 2, r.w - lw, r.h - lw, T.radius - lw / 2);
      ctx.setLineDash(S.dash ?? []);
      ctx.strokeStyle = S.stroke;
      ctx.lineWidth = lw;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.fillStyle = S.text;
    ctx.font = `600 ${T.font}px ${mono}`;
    const sp = T.font * 0.04;
    const label = fit(ctx, it.label, r.w - 16, sp);
    spaced(ctx, label, r.w / 2, r.h / 2 + 0.5, sp, "center");
    ctx.restore();
  });
  // no glass: a ring marks the tile you're on
  if (ring && ring.on > 0) {
    const r = T.rects[0];
    if (r) {
      ctx.save();
      ctx.globalAlpha = ring.on;
      rrect(ctx, M + ring.x - r.w / 2 - 4, M + ring.y - r.h / 2 - 4, r.w + 8, r.h + 8, T.radius + 4);
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
    }
  }
}

// ------------------------------------------------------------------ the glass (WebGL)
// The passport's lens (passport-book/card.ts), on a dark card, sampling the tiles under it.
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
  float ds = lens(f - vec2(0.0, 0.14 * b));
  float shadow = (1.0 - smoothstep(-0.2 * b, 0.7 * b, ds)) * 0.42 * uMat;
  if (d > 1.5 * px && shadow < 0.002) { gl_FragColor = vec4(0.0); return; }

  vec2 e = vec2(0.5, 0.0);
  vec2 grad = vec2(lens(f + e.xy) - lens(f - e.xy), lens(f + e.yx) - lens(f - e.yx));
  vec2 n = grad / max(length(grad), 1e-5);
  float depth = max(-d, 0.0);
  // the middle magnified; the rim bends in what lies just past it, split into its colours
  float t = clamp(depth / min(0.42 * b, 14.0), 0.0, 1.0);
  float rim = (1.0 - t) * (1.0 - t);
  float zoom = mix(1.0, 1.1, uMat);
  vec2 base = uC + (f - uC) / zoom;
  vec2 off = n * b * 0.45 * rim * uMat;
  float k = 0.1;
  vec3 col;
  col.r = under(base + off * (1.0 - k)).r;
  col.g = under(base + off).g;
  col.b = under(base + off * (1.0 + k)).b;

  float v = clamp(local(f).y / b, -1.0, 1.0);
  col = mix(col, vec3(1.0), 0.035 + 0.02 * (0.5 - 0.5 * v));
  col += vec3(1.0) * rim * 0.08;
  vec2 Ld = normalize(vec2(-0.5 + uLight.x * 0.6, -0.86 + uLight.y * 0.4));
  float facing = max(dot(n, Ld), 0.0);
  float spec = pow(facing, 3.0) * exp(-depth / (b * 0.085));
  float bounce = pow(max(dot(n, -Ld), 0.0), 4.0) * exp(-depth / (b * 0.055));
  col += vec3(1.0) * (spec * 0.55 + bounce * 0.2) * uMat;
  float s2 = sin(2.0 * atan(n.y, n.x));
  vec3 iri = mix(vec3(1.0, 0.45, 0.2), vec3(0.15, 0.82, 0.92), 0.5 - 0.5 * s2);
  float irr = exp(-pow((depth - 0.055 * b) / (0.04 * b), 2.0)) * (0.3 + 0.7 * abs(s2));
  col += (iri - vec3(0.5)) * irr * 0.1 * uMat;
  float hair = exp(-pow((depth - 1.2) / 0.8, 2.0));
  col += vec3(1.0) * hair * (0.2 + 0.4 * facing);
  float edge = exp(-pow((d + 0.35) / 0.8, 2.0));
  col = mix(col, vec3(0.0), edge * 0.35);

  float a = smoothstep(px, -px, d) * clamp(uMat * 1.6, 0.0, 1.0);
  vec4 outside = vec4(0.0, 0.0, 0.0, shadow * (1.0 - smoothstep(px, -px, d)));
  gl_FragColor = vec4(clamp(col, 0.0, 1.0) * a, a) + outside * (1.0 - a);
}`;
const NAMES = ["uTex", "uRes", "uDpr", "uSize", "uC", "uHalf", "uAngle", "uStretch", "uMat", "uBg", "uLight", "uR"] as const;

/** `host` takes the pointer; the two canvases are made inside `layer`, under the tile buttons. */
export type BagEls = { host: HTMLElement; layer: HTMLElement };
export type BagEvents = {
  /** The pointer is over a tile (or a finger drags across one); null when it leaves. */
  hover(i: number | null): void;
  /** A finger dragged the lens and let go on a tile. */
  pick(i: number): void;
};

/** How far past the tiles the canvases reach, so the glass can hang over the edge. */
export const MARGIN = 20;

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
  const S = { x: 0, y: 0, vx: 0, vy: 0, sx: 0, sy: 0, svx: 0, svy: 0, k: 0.7, vk: 0, mat: 0, tx: 0, ty: 0, press: 0, drag: false, placed: false, lx: 0, ly: 0, tlx: 0, tly: 0 };
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
  // the tiles press in one after another, worst first
  const appear = (i: number) => {
    if (reduced) return 1;
    if (!born) return 0;
    const t = (performance.now() - born) / 1000 - 0.12 - Math.min(i * 0.03, 0.5);
    const x = clamp(t / 0.45, 0, 1);
    return 1 - Math.pow(1 - x, 3);
  };
  const introDone = () => reduced || (!!born && (performance.now() - born) / 1000 > 0.12 + Math.min(((T?.rects.length ?? 1) - 1) * 0.03, 0.5) + 0.45);
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
        break;
      }
      // position: a quick spring that just overshoots
      const kp = S.drag ? 520 : 260, cp = 2 * Math.sqrt(kp) * (S.drag ? 0.9 : 0.78);
      S.vx += (kp * (S.tx - S.x) - cp * S.vx) * h;
      S.vy += (kp * (S.ty - S.y) - cp * S.vy) * h;
      S.x += S.vx * h;
      S.y += S.vy * h;
      // shape: stretches with speed and wobbles back when it stops
      const sp = Math.hypot(S.vx, S.vy);
      const want = Math.min(sp / 2400, 0.24);
      const dx = sp > 1e-3 ? S.vx / sp : 1, dy = sp > 1e-3 ? S.vy / sp : 0;
      S.svx += (210 * (dx * want - S.sx) - 9 * S.svx) * h;
      S.svy += (210 * (dy * want - S.sy) - 9 * S.svy) * h;
      S.sx += S.svx * h;
      S.sy += S.svy * h;
      // size: grows a little under a finger; arrives with a small bounce
      S.vk += (260 * (1 + 0.1 * S.press - S.k) - 15 * S.vk) * h;
      S.k += S.vk * h;
      // the light bends in: the glass arrives as its lensing grows, not as a fade
      S.mat = target >= 0 && matAt ? clamp((now - matAt) / 700, 0, 1) : 0;
      S.lx += (S.tlx - S.lx) * Math.min(1, h * 5);
      S.ly += (S.tly - S.ly) * Math.min(1, h * 5);
    }
    // painted while the tiles press in, once more as they finish, and every frame for the ring
    if (intro || wasIntro || !prog) paint();
    wasIntro = intro;
    draw();
    const settled = Math.abs(S.tx - S.x) < 0.05 && Math.abs(S.ty - S.y) < 0.05 && Math.hypot(S.vx, S.vy) < 0.05 && Math.hypot(S.sx, S.sy) < 0.001 && Math.abs(S.k - (1 + 0.1 * S.press)) < 0.001 && Math.abs(S.vk) < 0.01 && (S.mat >= 1 || target < 0) && Math.abs(S.tlx - S.lx) < 0.01 && Math.abs(S.tly - S.ly) < 0.01;
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
    gl.uniform2f(U.uLight, S.lx, S.ly);
    gl.uniform1f(U.uR, (T.radius + (T.lens[1] - T.rects[0].h / 2)) * S.k);
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
        matAt = born + (reduced ? 0 : 450);
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
