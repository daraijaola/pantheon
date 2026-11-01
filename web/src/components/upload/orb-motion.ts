// Timing, layout and motion for DELPHI's orb on /upload. Plain functions: no React, no WebGL.
// Times are seconds since the orb page opened.

/** What DELPHI says while she reads, in order: history, holdings, verdicts, then your standing. */
export const LINES = [
  "Reading your history",
  "Finding your first block",
  "Tracing Ascend, PerpMe and Kalos",
  "Opening your bag",
  "Pricing every coin",
  "Checking for bundled buys",
  "Following the volume",
  "Asking who holds the most",
  "Linking each claim to its transaction",
  "Weighing your stake",
  "Counting your time bonus",
  "Checking your HYPE Passport",
  "Counting your Trials votes",
  "Naming your standing",
  "Building your self",
] as const;

export const T = {
  bead: 0.38, // a bead forms under the top edge
  fall: 0.98, // it has fallen; it blooms on a spring
  line: 1.6, // each line DELPHI says
  globeLead: 3.6, // the data wraps into a globe over the read's last seconds
  splitDur: 1.7, // the globe splits into bubbles
  cover: 1.35, // a picked bubble fills the screen, flashes white, then fades to paper
} as const;

/** How long the read runs: one line each. */
export const READ = LINES.length * T.line;

export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
export const smooth = (a: number, b: number, v: number) => {
  const x = clamp((v - a) / (b - a), 0, 1);
  return x * x * (3 - 2 * x);
};
export const inOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const outBack = (x: number) => 1 + 2.70158 * Math.pow(x - 1, 3) + 1.70158 * Math.pow(x - 1, 2);
const hash = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};
function spring(p: number, z: number, f: number) {
  if (p <= 0) return 0;
  const w = f * 2 * Math.PI;
  const wd = w * Math.sqrt(1 - z * z);
  return 1 - Math.exp(-z * w * p) * (Math.cos(wd * p) + ((z * w) / wd) * Math.sin(wd * p));
}
/** A voice-like level between 0 and 1, so the light breathes like someone speaking. */
export function voice(t: number) {
  return clamp(0.5 + 0.32 * Math.sin(t * 2.1) * Math.sin(t * 0.73 + 1) + 0.22 * Math.sin(t * 5.3 + 0.4) * Math.sin(t * 1.7) + 0.12 * Math.sin(t * 9.1), 0, 1);
}

// ------------------------------------------------------------------ layout

export type Layout = {
  w: number;
  h: number;
  cx: number;
  cy: number;
  /** The orb while it listens, and at the end of the read. */
  r0: number;
  r1: number;
  /** Space kept at the bottom for the line under the bubbles. */
  band: number;
  /** Where the bubbles may go. */
  arena: { x0: number; y0: number; x1: number; y1: number };
};

const TOP = 64; // the band the wallet chip sits in

export function layout(w: number, h: number): Layout {
  const band = w < 640 ? 112 : 124;
  return {
    w,
    h,
    cx: w / 2,
    cy: TOP + (h - TOP) * 0.41,
    r0: Math.min(104, 0.26 * w, 0.13 * (h - TOP)),
    r1: Math.min(172, 0.42 * w, 0.23 * (h - TOP)),
    band,
    arena: { x0: 14, y0: TOP + 6, x1: w - 14, y1: h - band },
  };
}

// ------------------------------------------------------------------ the orb

/** When things happened: `read` is when the signature came in, `split` when the read ends. */
export type Timeline = { read: number | null; split: number | null };

export type Orb = {
  cx: number;
  cy: number;
  r: number;
  drop: number;
  think: number;
  energy: number;
  pulse: number;
  dots: number;
  mix: number;
  globe: number;
  prog: number;
  /** A fresh patch of data: where (x, y in the orb's own units) and how old. */
  bloom: [number, number, number];
};

/** The orb's radius during the read: it grows from r0 to r1. */
export function readRadius(t: number, tl: Timeline, L: Layout) {
  if (tl.read === null) return L.r0;
  return L.r0 + (L.r1 - L.r0) * inOut(clamp((t - tl.read) / READ, 0, 1));
}

function pulseAt(t: number, tl: Timeline) {
  let p = 0;
  const hit = (e: number) => {
    if (t >= e && t < e + 1.4) p = Math.max(p, Math.exp(-(t - e) * 4));
  };
  hit(T.fall);
  if (tl.read !== null) for (let i = 0; i < LINES.length; i++) hit(tl.read + i * T.line);
  return p;
}

export function mainOrb(t: number, tl: Timeline, L: Layout, reduced: boolean): Orb {
  const o: Orb = { cx: L.cx, cy: L.cy, r: L.r0, drop: 0, think: 0, energy: 0.16, pulse: 0, dots: 0, mix: 0, globe: 0, prog: 0, bloom: [0, 0, 99] };
  const reading = tl.read !== null && t >= tl.read;
  const split = tl.split !== null && t >= tl.split;

  if (reduced) {
    // Settled frames only: no drop, no breathing; the data fills in as DELPHI reads.
    if (!reading) return { ...o, energy: 0.3 };
    const p = clamp((t - (tl.read ?? 0)) / READ, 0, 1);
    const done = { ...o, r: L.r1 * 0.86, think: 1, energy: 0.5, prog: p, dots: 1, mix: 0.14 + 0.56 * p, globe: p > 0.85 ? 1 : 0 };
    return split ? { ...done, r: 0 } : done;
  }

  const top = TOP + 1;
  if (t < T.bead) {
    const p = t / T.bead;
    o.r = Math.max(16 * Math.sin((p * Math.PI) / 2), 0.5);
    o.cy = top + o.r * 1.15;
    o.drop = 0.55 * p;
    o.energy = 0.3;
    return o;
  }
  if (t < T.fall) {
    const p = (t - T.bead) / (T.fall - T.bead);
    o.r = 16 + 18 * p;
    o.cy = top + 18.4 + (L.cy - top - 18.4) * p * p * p;
    o.drop = 0.55 + 0.25 * Math.sin(p * Math.PI);
    o.energy = 0.35;
    return o;
  }
  // Bloomed, and listening.
  const p = t - T.fall;
  const bloomR = 34 + (L.r0 - 34) * spring(p / 0.85, 0.45, 1.15);
  o.r = bloomR * (1 + 0.022 * Math.sin(p * 2.6) * smooth(0.8, 1.6, p));
  o.drop = -0.55 * Math.exp(-p * 7) * Math.cos(p * 14);
  o.energy = 0.14 + 0.22 * voice(t) * smooth(0.6, 1.4, p);
  o.pulse = pulseAt(t, tl);
  if (!reading || tl.read === null) return o;

  if (!split || tl.split === null) {
    // DELPHI reads: the light breaks into halftone, hex data condenses out of it, then wraps into a globe.
    const rp = clamp((t - tl.read) / READ, 0, 1);
    const end = tl.read + READ;
    o.think = smooth(tl.read, tl.read + 1.6, t);
    o.r = (bloomR + readRadius(t, tl, L) - L.r0) * (1 + 0.018 * Math.sin(t * 3.1));
    o.energy = 0.45 + 0.4 * voice(t);
    o.prog = rp;
    o.dots = smooth(tl.read + 0.2, tl.read + 2, t);
    o.mix = 0.14 + 0.56 * smooth(0.04, 0.8, rp);
    o.globe = inOut(clamp((t - (end - T.globeLead)) / 2.6, 0, 1));
    const i = Math.floor((t - tl.read) / T.line);
    if (i >= 1) o.bloom = [hash(i) - 0.5, hash(i + 19) - 0.5, t - tl.read - i * T.line];
    return o;
  }

  // The split: the globe swells once, then gives itself to the bubbles.
  const q = t - tl.split;
  const swell = q < 0.3 ? Math.sin((Math.PI * q) / 0.3) * 0.06 : 0;
  return {
    ...o,
    drop: 0,
    think: 1,
    energy: 0.5,
    prog: 1,
    dots: 1,
    mix: 0.7,
    globe: 1,
    r: L.r1 * (1 + swell) * (1 - inOut(clamp((q - 0.15) / 0.85, 0, 1))),
  };
}

/** How far the orb's liquid reaches for a bubble: wide while they bud, then just a touch. */
export function budReach(t: number, split: number, L: Layout) {
  const p = clamp((t - split) / T.splitDur, 0, 1);
  return 14 + (L.r1 * 0.45 - 14) * (1 - smooth(0.55, 1, p));
}

// ------------------------------------------------------------------ the bubbles

/** One bubble for each design DELPHI's light can take, biggest first. */
export const BUBBLES = [
  { design: "read", type: 7, w: 1, think: 1, off: 3.1 }, // G: halftone and hex together
  { design: "globe", type: 3, w: 0.9, think: 1, off: 7.7 }, // D
  { design: "hex", type: 2, w: 0.84, think: 1, off: 1.9 }, // C
  { design: "halftone", type: 1, w: 0.78, think: 1, off: 5.3 }, // B
  { design: "light", type: 0, w: 0.72, think: 0, off: 9.2 }, // A
  { design: "bars", type: 4, w: 0.66, think: 0.55, off: 2.6 }, // E
  { design: "ledger", type: 5, w: 0.6, think: 1, off: 6.4 }, // F
] as const;

export type BubbleDesign = (typeof BUBBLES)[number]["design"];

type Bubble = { x: number; y: number; vx: number; vy: number; r: number; rr: number; s: number; sv: number; sa: number; hov: number; cruise: number };
export type Sim = { t: number; w: number; h: number; b: Bubble[]; frozen: boolean };

const STEP = 1 / 120;

function createSim(L: Layout, split: number, reduced: boolean): Sim {
  const ar = L.arena;
  const area = (ar.x1 - ar.x0) * (ar.y1 - ar.y0);
  const sumW = BUBBLES.reduce((s, b) => s + b.w * b.w, 0);
  // Together they cover about 16% of the page, and the biggest is never wider than 40% of it.
  const k = Math.min(Math.sqrt((0.16 * area) / (Math.PI * sumW)), (Math.min(ar.x1 - ar.x0, ar.y1 - ar.y0) * 0.2) / BUBBLES[0].w);
  const sc = Math.min(L.w, L.h) / 900;
  return {
    t: split,
    w: L.w,
    h: L.h,
    frozen: false,
    b: BUBBLES.map((d, i) => {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / BUBBLES.length + 0.35;
      const v0 = (260 + 40 * hash(i + 3)) * Math.max(sc, 0.55);
      const cruise = reduced ? 0 : (48 + 30 * (1 - d.w)) * Math.max(sc, 0.6);
      return { x: L.cx, y: L.cy, vx: Math.cos(a) * v0, vy: Math.sin(a) * v0, r: d.w * k, rr: 0, s: 0, sv: 0, sa: 0, hov: 0, cruise };
    }),
  };
}

function stepSim(S: Sim, L: Layout, split: number, hover: number) {
  const ar = L.arena;
  const t = S.t;
  const dt = STEP;
  for (let i = 0; i < S.b.length; i++) {
    const b = S.b[i];
    const grow = outBack(clamp((t - split - 0.28 - i * 0.07) / 0.95, 0, 1));
    b.hov += ((i === hover ? 1 : 0) - b.hov) * Math.min(1, dt * 8);
    b.rr = b.r * grow * (1 + 0.07 * b.hov);
    // Drift at a calm speed; slow right down under the pointer.
    const sp = Math.hypot(b.vx, b.vy) || 1e-6;
    const f = 1 + ((b.cruise * (1 - 0.6 * b.hov)) / sp - 1) * Math.min(1, dt * 0.9);
    b.vx *= f;
    b.vy *= f;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    const r = b.rr;
    if (t > split + 0.6) {
      // Bounce off the edges, squashing against them.
      const kick = (v: number) => Math.min(Math.abs(v) / 700, 0.3) * 7;
      if (b.x - r < ar.x0) { b.x = ar.x0 + r; if (b.vx < 0) { b.sv += kick(b.vx); b.sa = 0; b.vx = -b.vx; } }
      if (b.x + r > ar.x1) { b.x = ar.x1 - r; if (b.vx > 0) { b.sv += kick(b.vx); b.sa = 0; b.vx = -b.vx; } }
      if (b.y - r < ar.y0) { b.y = ar.y0 + r; if (b.vy < 0) { b.sv += kick(b.vy); b.sa = Math.PI / 2; b.vy = -b.vy; } }
      if (b.y + r > ar.y1) { b.y = ar.y1 - r; if (b.vy > 0) { b.sv += kick(b.vy); b.sa = Math.PI / 2; b.vy = -b.vy; } }
    }
    b.sv += (-140 * b.s - 10 * b.sv) * dt;
    b.s = clamp(b.s + b.sv * dt, -0.14, 0.2);
  }
  if (t > split + 0.75) {
    // And off each other: heavier bubbles push lighter ones, both squash along the hit.
    for (let i = 0; i < S.b.length; i++) {
      for (let j = i + 1; j < S.b.length; j++) {
        const a = S.b[i];
        const c = S.b[j];
        const dx = c.x - a.x;
        const dy = c.y - a.y;
        const dist = Math.hypot(dx, dy) || 1e-6;
        const min = a.rr + c.rr + 6;
        if (dist >= min) continue;
        const nx = dx / dist;
        const ny = dy / dist;
        const over = min - dist;
        const ma = a.rr * a.rr + 1;
        const mc = c.rr * c.rr + 1;
        const tot = ma + mc;
        a.x -= (nx * over * mc) / tot;
        a.y -= (ny * over * mc) / tot;
        c.x += (nx * over * ma) / tot;
        c.y += (ny * over * ma) / tot;
        const rv = (c.vx - a.vx) * nx + (c.vy - a.vy) * ny;
        if (rv < 0) {
          const jn = (-2 * rv) / (1 / ma + 1 / mc);
          a.vx -= (jn * nx) / ma;
          a.vy -= (jn * ny) / ma;
          c.vx += (jn * nx) / mc;
          c.vy += (jn * ny) / mc;
          const sq = Math.min(-rv / 900, 0.25) * 6;
          const ang = Math.atan2(ny, nx);
          a.sv += sq;
          a.sa = ang;
          c.sv += sq;
          c.sa = ang;
        }
      }
    }
  }
  S.t += dt;
}

/**
 * The bubbles at time `t`, stepped at a fixed rate from the split so every screen plays the same way.
 * With reduced motion they're placed where they'd settle and stay there.
 */
export function simTo(sim: Sim | null, t: number, L: Layout, split: number, hover: number, reduced: boolean): Sim {
  let S = sim;
  if (!S || S.w !== L.w || S.h !== L.h || t < S.t - 1e-6) S = createSim(L, split, reduced);
  if (reduced) {
    if (!S.frozen) {
      while (S.t < split + 8) stepSim(S, L, split, -1);
      S.frozen = true;
    }
    return S;
  }
  // Back from a hidden tab: skip ahead rather than replay minutes of drifting.
  if (S.t > split + 3 && t - S.t > 1) S.t = t - 1 / 60;
  let n = 0;
  while (S.t + STEP <= t && n < 2400) {
    stepSim(S, L, split, hover);
    n++;
  }
  return S;
}

/** The bubble nearest the middle of the page. */
export function nearestMiddle(S: Sim, L: Layout) {
  const cx = L.w / 2;
  const cy = (L.arena.y0 + L.arena.y1) / 2;
  let best = 0;
  let bd = Infinity;
  S.b.forEach((b, i) => {
    const d = Math.hypot(b.x - cx, b.y - cy);
    if (d < bd) {
      bd = d;
      best = i;
    }
  });
  return best;
}
