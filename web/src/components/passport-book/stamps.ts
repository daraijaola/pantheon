// Page two of the passport: its stamps. The passport service checks the wallet's Hyperliquid history
// and the registry stores what it earned as a bitmap; each stamp is pressed into this page under its
// own bubble of the card's liquid glass, inked when earned and pressed in blind until then.

import { FINISH, clamp, makeProgram, microtext, rgba, rrect, spaced, waves, type FinishName, type Fonts, type RGB } from "./draw";
import type { Layout } from "./card";
import { dmy, passportNo, type PassportView } from "./view";

export const STAMPS = [
  { key: "STAKER", have: "10+ HYPE staked", need: "Stake 10 HYPE", tilt: -7 },
  { key: "KHYPE", have: "10+ HYPE worth of kHYPE", need: "Hold 10+ HYPE worth of kHYPE", tilt: 5 },
  { key: "GENESIS", have: "In the genesis airdrop", need: "Genesis airdrop only", tilt: -3 },
  { key: "VETERAN", have: "A year on Hyperliquid", need: "A year on Hyperliquid", tilt: 6 },
  { key: "TRADER", have: "$1M+ traded", need: "Trade $1M in total", tilt: -4 },
  { key: "HYPURR", have: "Holds a Hypurr", need: "Hold a Hypurr", tilt: 4 },
  { key: "KNTQ", have: "1,000+ KNTQ held", need: "Hold 1,000 KNTQ", tilt: -6 },
  { key: "SEASONED", have: "30 days on Hyperliquid", need: "30 days on Hyperliquid", tilt: -2 },
] as const;
type StampKey = (typeof STAMPS)[number]["key"];

// Emblems in the menu icons' dot-matrix: "#" a full dot, "+" a half-tone one.
const PIX = {
  STAKER: ["..#######..", ".##+++++##.", "..#######..", ".##+++++##.", "..#######..", ".##+++++##.", "..#######.."],
  KHYPE: ["....#....", "....#....", "...###...", "..##+##..", ".##+++##.", ".#+++++#.", "#+++++++#", "#+++++++#", ".#+++++#.", "..#####.."],
  GENESIS: [".....#.....", ".#...#...#.", "..#.....#..", "....###....", "...#####...", "..#######..", "###########"],
  VETERAN: ["....#....", "....#....", "...###...", "#########", ".#######.", "..#####..", "..##.##..", ".##...##.", ".#.....#."],
  TRADER: [".........#.", "........###", "........###", ".....#..###", "....###.###", "....###..#.", ".#..###..#.", "###..#.....", "###..#.....", "###........", ".#........."],
  HYPURR: ["#.........#", "##.......##", "###########", "###########", "##..###..##", "##..###..##", "###########", "####.+.####", ".#########.", "..#######.."],
  ARROW: ["..#..", "...#.", "#####", "...#.", "..#.."],
  GEM: [".#.", "###", ".#."],
};
type C = CanvasRenderingContext2D;
function pix(c: C, rows: string[], cx: number, cy: number, u: number) {
  const x0 = cx - (rows[0].length * u) / 2, y0 = cy - (rows.length * u) / 2, g = u * 0.86;
  rows.forEach((row, j) => {
    for (let i = 0; i < row.length; i++) {
      if (row[i] === "#") c.fillRect(x0 + i * u, y0 + j * u, g, g);
      else if (row[i] === "+") c.fillRect(x0 + i * u + u * 0.22, y0 + j * u + u * 0.22, u * 0.42, u * 0.42);
    }
  });
}
function ring(c: C, x: number, y: number, r: number, lw: number) {
  c.lineWidth = lw;
  c.beginPath();
  c.arc(x, y, r, 0, Math.PI * 2);
  c.stroke();
}
function poly(c: C, x: number, y: number, n: number, r: number, rot: number, lw: number) {
  c.lineWidth = lw;
  c.lineJoin = "round";
  c.beginPath();
  for (let i = 0; i < n; i++) {
    const a = rot + (i / n) * Math.PI * 2;
    if (i) c.lineTo(x + r * Math.cos(a), y + r * Math.sin(a));
    else c.moveTo(x + r * Math.cos(a), y + r * Math.sin(a));
  }
  c.closePath();
  c.stroke();
}
function outline(c: C, x: number, y: number, w: number, h: number, r: number, lw: number) {
  c.lineWidth = lw;
  rrect(c, x, y, w, h, r);
  c.stroke();
}
function wavy(c: C, x: number, y: number, R: number, amp: number, n: number, lw: number) {
  c.lineWidth = lw;
  c.beginPath();
  for (let i = 0; i <= 480; i++) {
    const a = (i / 480) * Math.PI * 2, r = R + amp * Math.cos(n * a);
    if (i) c.lineTo(x + r * Math.cos(a), y + r * Math.sin(a));
    else c.moveTo(x + r * Math.cos(a), y + r * Math.sin(a));
  }
  c.closePath();
  c.stroke();
}
function diamond(c: C, x: number, y: number, hw: number, hh: number, lw: number) {
  c.lineWidth = lw;
  c.lineJoin = "round";
  c.beginPath();
  c.moveTo(x, y - hh);
  c.lineTo(x + hw, y);
  c.lineTo(x, y + hh);
  c.lineTo(x - hw, y);
  c.closePath();
  c.stroke();
}
const dot = (c: C, x: number, y: number, r: number) => {
  c.beginPath();
  c.arc(x, y, r, 0, Math.PI * 2);
  c.fill();
};

/** The stamp art for one finish of fonts and one passport (dates), in a 142 × 100 cell centred on 71, 50. */
function art(fonts: Fonts, v: PassportView): Record<StampKey, (c: C) => void> {
  const word = (c: C, text: string, x: number, y: number, size: number, o: { mono?: boolean; track?: number; align?: "left" | "center" } = {}) => {
    c.font = o.mono ? `500 ${size}px ${fonts.mono}` : `600 ${size}px ${fonts.sans}`;
    c.textBaseline = "alphabetic";
    spaced(c, text, x, y, o.track ?? 0, o.align ?? "center");
  };
  /** Letters round a circle: along the top reading clockwise, or along the bottom the right way up. */
  const arcText = (c: C, text: string, x: number, y: number, r: number, size: number, track: number, bottom = false) => {
    c.font = `500 ${size}px ${fonts.mono}`;
    c.textBaseline = "middle";
    const ch = [...text], ws = ch.map((q) => c.measureText(q).width);
    const total = ws.reduce((a, b) => a + b, 0) + track * (ch.length - 1);
    const dir = bottom ? -1 : 1;
    let a = (bottom ? Math.PI / 2 : -Math.PI / 2) - (dir * total) / (2 * r);
    ch.forEach((q, i) => {
      a += (dir * ws[i]) / (2 * r);
      c.save();
      c.translate(x + r * Math.cos(a), y + r * Math.sin(a));
      c.rotate(a + (bottom ? -Math.PI / 2 : Math.PI / 2));
      c.fillText(q, -ws[i] / 2, 0);
      c.restore();
      a += (dir * (ws[i] / 2 + track)) / r;
    });
    c.textBaseline = "alphabetic";
  };
  return {
    STAKER(c) {
      ring(c, 71, 50, 41, 2.6); ring(c, 71, 50, 37.4, 0.8); ring(c, 71, 50, 24, 0.9);
      arcText(c, "HYPE PASSPORT", 71, 50, 30.7, 5.1, 1.5);
      arcText(c, "10+ HYPE STAKED", 71, 50, 30.7, 5.1, 1.05, true);
      dot(c, 71 - 30.7, 50, 1.15); dot(c, 71 + 30.7, 50, 1.15);
      pix(c, PIX.STAKER, 71, 38.4, 1.45);
      word(c, "STAKER", 71, 58.6, 9, { track: 0.9 });
      word(c, dmy(v.issued), 71, 66.4, 4.3, { mono: true, track: 0.7 });
    },
    KHYPE(c) {
      poly(c, 71, 50, 6, 43, 0, 2.6); poly(c, 71, 50, 6, 39.2, 0, 0.8);
      pix(c, PIX.KHYPE, 71, 28.6, 1.22);
      word(c, "kHYPE", 71, 55.6, 15.5, { track: 0.2 });
      word(c, "LIQUID STAKED", 71, 64.4, 4.6, { mono: true, track: 0.9 });
      word(c, "10+ HELD", 71, 71.8, 4.6, { mono: true, track: 0.9 });
    },
    GENESIS(c) {
      outline(c, 17, 21, 108, 58, 6, 2.6); outline(c, 20.6, 24.6, 100.8, 50.8, 3.4, 0.8);
      word(c, "ENTRY · HYPERLIQUID", 71, 33.1, 4.6, { mono: true, track: 1.05 });
      c.fillRect(24.5, 36.4, 93, 0.6);
      pix(c, PIX.GENESIS, 37.6, 55.6, 1.5);
      word(c, "GENESIS", 52, 56.6, 14, { track: 0.4, align: "left" });
      word(c, "29 NOV 2024", 52.6, 67.2, 5.4, { mono: true, track: 0.85, align: "left" });
      pix(c, PIX.ARROW, 109.5, 65.4, 0.95);
    },
    VETERAN(c) {
      poly(c, 71, 50, 8, 43, Math.PI / 8, 2.6); poly(c, 71, 50, 8, 39.2, Math.PI / 8, 0.8);
      pix(c, PIX.VETERAN, 71, 24.6, 1.18);
      word(c, "VETERAN", 71, 39.8, 6, { mono: true, track: 1.9 });
      word(c, "365+", 71, 60.6, 17.5, { track: 0.2 });
      word(c, "DAYS ON HYPERLIQUID", 71, 69.6, 4.15, { mono: true, track: 0.65 });
    },
    TRADER(c) {
      outline(c, 14, 23, 114, 54, 27, 2.6); outline(c, 17.6, 26.6, 106.8, 46.8, 23.4, 0.8);
      pix(c, PIX.TRADER, 39.6, 50, 1.42);
      c.fillRect(54.6, 36.5, 0.7, 27);
      word(c, "TRADER", 60.4, 52.2, 13.2, { track: 0.5, align: "left" });
      word(c, "$1M+ VOLUME", 60.8, 61.6, 5.2, { mono: true, track: 0.85, align: "left" });
    },
    HYPURR(c) {
      wavy(c, 71, 50, 40.6, 1.35, 24, 2.2); ring(c, 71, 50, 35, 0.8);
      arcText(c, "HYPURR", 71, 50, 28.7, 6.2, 2.6);
      arcText(c, "HOLDER", 71, 50, 28.7, 6.2, 2.6, true);
      dot(c, 71 - 28.7, 50, 1.2); dot(c, 71 + 28.7, 50, 1.2);
      pix(c, PIX.HYPURR, 71, 50.4, 1.74);
    },
    KNTQ(c) {
      diamond(c, 71, 50, 50, 42, 2.6); diamond(c, 71, 50, 45.4, 38.1, 0.8);
      word(c, "1,000+", 71, 40.4, 5.4, { mono: true, track: 1 });
      word(c, "KNTQ", 71, 57.6, 15.5, { track: 0.6 });
      word(c, "HELD", 71, 66.6, 5.2, { mono: true, track: 1.6 });
      pix(c, PIX.GEM, 71 - 36.5, 50, 1.25); pix(c, PIX.GEM, 71 + 36.5, 50, 1.25);
    },
    SEASONED(c) {
      ring(c, 46, 50, 27.5, 2.2); ring(c, 46, 50, 24.6, 0.7);
      arcText(c, "SEASONED", 46, 50, 19.8, 4.6, 1.15);
      arcText(c, "HYPE PASSPORT", 46, 50, 19.8, 3.8, 0.5, true);
      word(c, "30+", 46, 54, 11.5, { track: 0.2 });
      word(c, "DAYS", 46, 60.6, 3.9, { mono: true, track: 0.9 });
      c.lineWidth = 1.5;
      c.lineCap = "round";
      for (let k = 0; k < 5; k++) {
        const yy = 50 + (k - 2) * 7.4;
        c.beginPath();
        for (let x = 78; x <= 128; x += 0.5) {
          const y = yy + 2.3 * Math.sin(((x - 78) / 13) * Math.PI * 2 + k * 0.5);
          if (x === 78) c.moveTo(x, y);
          else c.lineTo(x, y);
        }
        c.stroke();
      }
    },
  };
}

// Real rubber doesn't print evenly: a little less ink in patches, specks it missed, a scratch or two.
function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function wear(c: C, seed: number) {
  const rnd = mulberry(seed);
  c.save();
  c.globalCompositeOperation = "destination-out";
  for (let i = 0; i < 6; i++) {
    const x = 10 + rnd() * 122, y = 8 + rnd() * 84, r = 10 + rnd() * 24;
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(0,0,0,${(0.1 + rnd() * 0.18).toFixed(3)})`);
    g.addColorStop(1, "rgba(0,0,0,0)");
    c.fillStyle = g;
    c.fillRect(x - r, y - r, r * 2, r * 2);
  }
  c.fillStyle = "#000";
  for (let i = 0; i < 1400; i++) {
    const x = rnd() * 142, y = rnd() * 100, r = 0.1 + Math.pow(rnd(), 3) * 0.6;
    c.globalAlpha = 0.45 + rnd() * 0.55;
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.fill();
  }
  c.globalAlpha = 0.55;
  c.lineWidth = 0.35;
  c.strokeStyle = "#000";
  for (let i = 0; i < 3; i++) {
    const x = 20 + rnd() * 100, y = 15 + rnd() * 70, a = rnd() * Math.PI, l = 6 + rnd() * 14;
    c.beginPath();
    c.moveTo(x, y);
    c.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
    c.stroke();
  }
  c.restore();
}
/** All eight stamps in white on clear, four by two, for the glass to print in the finish's ink. */
function paintAtlas(canvas: HTMLCanvasElement, scale: number, fonts: Fonts, v: PassportView) {
  canvas.width = Math.round(142 * 4 * scale);
  canvas.height = Math.round(100 * 2 * scale);
  const c = canvas.getContext("2d");
  if (!c) return;
  const ART = art(fonts, v);
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, canvas.width, canvas.height);
  STAMPS.forEach((st, k) => {
    c.save();
    c.setTransform(scale, 0, 0, scale, (k % 4) * 142 * scale, Math.floor(k / 4) * 100 * scale);
    c.beginPath();
    c.rect(0, 0, 142, 100);
    c.clip();
    c.translate(71, 50);
    c.rotate((st.tilt * Math.PI) / 180);
    c.translate(-71, -50);
    c.fillStyle = c.strokeStyle = "#fff";
    c.shadowColor = "rgba(255,255,255,0.35)";
    c.shadowBlur = 0.9 * scale; // the ink bleeds a hair into the paper
    ART[st.key](c);
    c.shadowBlur = 0;
    wear(c, k * 7919 + 17);
    c.restore();
  });
}

// ------------------------------------------------------------------ the page's two layouts
type Cap = [number, number, number, number];
const grid = (cols: number, rows: number, x0: number, y0: number, w: number, gx: number, pitch: number): Cap[] => {
  const out: Cap[] = [];
  for (let r = 0; r < rows; r++) for (let q = 0; q < cols; q++) out.push([x0 + q * (w + gx), y0 + r * pitch, w, w / 1.42]);
  return out;
};
type PageLayout = {
  W: number; H: number; radius: number; pad: number; micro: [number, number]; hy: number; t1: number; t2: number; ry: number;
  right2: string; caps: Cap[]; c1: number; c2: number; c3: number; cy1: number; cy2: number; fy: number;
};
const WIDE: PageLayout = {
  W: 760, H: 488, radius: 30, pad: 40, micro: [12, 32], hy: 50, t1: 11, t2: 7.4, ry: 86, right2: "FROM YOUR HYPERLIQUID HISTORY",
  caps: grid(4, 2, 40, 106, 155, 20, 182), c1: 9.4, c2: 7.4, c3: 11.5, cy1: 22, cy2: 39, fy: 26,
};
const TALL: PageLayout = {
  W: 360, H: 790, radius: 26, pad: 24, micro: [10, 28], hy: 38, t1: 8.6, t2: 6, ry: 66, right2: "FROM HYPERLIQUID",
  caps: grid(2, 4, 24, 86, 146, 20, 172), c1: 8.6, c2: 6.8, c3: 11, cy1: 20, cy2: 36, fy: 22,
};
const INK: Record<FinishName, RGB> = { ink: [240, 240, 236], paper: [22, 22, 22] };

// ------------------------------------------------------------------ the bubbles (WebGL)
const FRAG = `precision highp float;
uniform sampler2D uPanel;
uniform sampler2D uAtlas;
uniform vec2 uRes;
uniform float uDpr;
uniform vec2 uSize;
uniform vec4 uA[8];
uniform vec4 uB[8];
uniform vec4 uC[8];
uniform vec2 uStampHalf[8];
uniform vec3 uInk;
uniform float uDark;
uniform vec3 uPointer;
uniform float uZoom;

// The same outline as the lens on the card: a capsule 1.42 times as wide as it is tall.
float pebble(vec2 q, vec2 h){
  float e = h.y * 0.96;
  vec2 p = vec2(max(abs(q.x) - (h.x - e), 0.0), abs(q.y));
  vec2 r = vec2(e, h.y);
  float R = length(p / r);
  float lg = length(p / (r * r));
  return lg > 1e-6 ? (R - 1.0) * R / lg : abs(q.y) - h.y;
}
// Into a bubble's own frame, stretched (or, with a negative stretch, squashed) along an angle.
vec2 toLocal(vec2 p, vec2 c, float st, float ang){
  vec2 q = p - c;
  float cs = cos(ang), sn = sin(ang);
  vec2 r = vec2(cs * q.x + sn * q.y, -sn * q.x + cs * q.y);
  r /= vec2(1.0 + st, 1.0 - 0.5 * st);
  return vec2(cs * r.x - sn * r.y, sn * r.x + cs * r.y);
}
float bubble(vec2 p, vec4 A, vec4 B){ return pebble(toLocal(p, A.xy, B.x, B.y), A.zw); }

// What lies under a bubble: the page, and the stamp pressed into it, inked or blind.
vec3 under(vec2 p, float idx, vec4 C, float blind, vec2 stampHalf){
  vec3 col = texture2D(uPanel, p / uSize).rgb;
  vec2 h = stampHalf * C.z;
  vec2 uv = (p - C.xy) / (2.0 * h) + 0.5;
  if (uv.x > 0.0 && uv.y > 0.0 && uv.x < 1.0 && uv.y < 1.0) {
    vec2 cell = vec2(mod(idx, 4.0), floor(idx / 4.0 + 0.001));
    vec2 auv = (cell + uv) / vec2(4.0, 2.0);
    float ink = texture2D(uAtlas, auv).a;
    if (blind > 0.5) {
      vec2 o = vec2(0.7) / (2.0 * h) / vec2(4.0, 2.0);
      float hi = texture2D(uAtlas, auv - o).a, lo = texture2D(uAtlas, auv + o).a;
      col += (hi - lo) * mix(0.1, 0.065, uDark) * C.w;
      col = mix(col, uInk, ink * mix(0.11, 0.07, uDark) * C.w);
    } else {
      col = mix(col, uInk, ink * 0.94 * C.w);
    }
  }
  return col;
}

void main(){
  vec2 f = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uDpr;
  float px = 1.0 / uDpr;
  float d = 1e5, idx = 0.0;
  vec4 A = uA[0], B = uB[0], C = uC[0];
  vec2 H = uStampHalf[0];
  for (int i = 0; i < 8; i++) {
    float di = bubble(f, uA[i], uB[i]);
    if (di < d) { d = di; idx = float(i); A = uA[i]; B = uB[i]; C = uC[i]; H = uStampHalf[i]; }
  }
  float b = A.w;
  float ds = bubble(f - vec2(0.0, 0.12 * b), A, B);
  float shadow = (1.0 - smoothstep(-0.2 * b, 0.45 * b, ds)) * mix(0.16, 0.34, uDark);
  if (d > 1.5 * px) { gl_FragColor = vec4(0.0, 0.0, 0.0, shadow); return; }

  vec2 e = vec2(0.5, 0.0);
  vec2 grad = vec2(bubble(f + e.xy, A, B) - bubble(f - e.xy, A, B), bubble(f + e.yx, A, B) - bubble(f - e.yx, A, B));
  vec2 n = grad / max(length(grad), 1e-5);
  float depth = max(-d, 0.0);
  // a dome: the middle magnified, the rim bending in what lies just outside, split into its colours
  float t = clamp(depth / (0.55 * b), 0.0, 1.0);
  float rim = (1.0 - t) * (1.0 - t);
  vec2 base = A.xy + (f - A.xy) / uZoom;
  vec2 off = n * b * 0.62 * rim;
  float k = 0.32;
  vec3 col;
  col.r = under(base + off * (1.0 - k), idx, C, B.w, H).r;
  col.g = under(base + off, idx, C, B.w, H).g;
  col.b = under(base + off * (1.0 + k), idx, C, B.w, H).b;

  float v = clamp(toLocal(f, A.xy, B.x, B.y).y / b, -1.0, 1.0);
  col = mix(col, vec3(1.0), mix(0.01, 0.018, uDark) + 0.016 * (0.5 - 0.5 * v));
  col += vec3(1.0) * rim * mix(0.02, 0.04, uDark);
  // the light sits top left, and swings toward the pointer when it comes near
  vec2 toP = uPointer.xy - A.xy;
  float pw = uPointer.z * exp(-length(toP) / (6.0 * b));
  vec2 Ld = normalize(mix(vec2(-0.5, -0.86), toP / max(length(toP), 0.35 * b), 0.85 * pw));
  float facing = max(dot(n, Ld), 0.0);
  float spec = pow(facing, 3.0) * exp(-depth / (b * 0.09));
  float bounce = pow(max(dot(n, -Ld), 0.0), 4.0) * exp(-depth / (b * 0.06));
  col += vec3(1.0) * (spec * mix(0.28, 0.4, uDark) + bounce * mix(0.1, 0.18, uDark));
  float s2 = sin(2.0 * atan(n.y, n.x));
  vec3 iri = mix(vec3(1.0, 0.45, 0.2), vec3(0.15, 0.82, 0.92), 0.5 - 0.5 * s2);
  float irr = exp(-pow((depth - 0.06 * b) / (0.045 * b), 2.0)) * (0.3 + 0.7 * abs(s2));
  col += (iri - vec3(0.5)) * irr * mix(0.1, 0.13, uDark);
  // a soft light under the pointer, as when you press on glass
  vec2 dp = f - uPointer.xy;
  col += vec3(1.0) * B.z * mix(0.06, 0.1, uDark) * exp(-dot(dp, dp) / (0.55 * b * b));
  float hair = exp(-pow((depth - 1.2) / 0.8, 2.0));
  col += vec3(1.0) * hair * (0.18 + 0.36 * facing) * mix(0.9, 1.0, uDark);
  float edge = exp(-pow((d + 0.35) / 0.8, 2.0));
  col = mix(col, vec3(0.0), edge * mix(0.42, 0.55, uDark));

  float a = smoothstep(px, -px, d);
  gl_FragColor = vec4(clamp(col, 0.0, 1.0) * a, a) + vec4(0.0, 0.0, 0.0, shadow) * (1.0 - a);
}`;
const NAMES = ["uPanel", "uAtlas", "uRes", "uDpr", "uSize", "uA", "uB", "uC", "uStampHalf", "uInk", "uDark", "uPointer", "uZoom"] as const;

export type StampsEls = { root: HTMLElement; face: HTMLCanvasElement; glass: HTMLCanvasElement; hits: HTMLElement };

export function createStamps(els: StampsEls, fonts: Fonts, reduced: boolean) {
  const { root, face, glass, hits: host } = els;
  const panelTex = document.createElement("canvas");
  const atlas = document.createElement("canvas");
  const prog = makeProgram(glass, FRAG, NAMES);
  const texPanel = prog?.texture(0) ?? null;
  const texAtlas = prog?.texture(1) ?? null;
  if (prog) {
    prog.gl.uniform1i(prog.U.uPanel, 0);
    prog.gl.uniform1i(prog.U.uAtlas, 1);
  }
  let SL: PageLayout = WIDE, s = 1, dpr = 1;
  let view: PassportView | null = null;
  let finish: FinishName = "ink";
  const got = (k: number) => !!view && view.stamps.includes(STAMPS[k].key);

  /** The page itself: paper or ink, its fine lines, the heading and each stamp's caption. With no
   * WebGL, the stamps are printed flat on it too. The glass's copy leaves the captions out, so no
   * stray letters bend into the bubbles. */
  function paintPage(canvas: HTMLCanvasElement, scale: number, flat: boolean, forGlass: boolean) {
    if (!view) return;
    const v = view;
    canvas.width = Math.round(SL.W * s * scale);
    canvas.height = Math.round(SL.H * s * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.scale(canvas.width / SL.W, canvas.height / SL.H);
    const F = FINISH[finish];
    const { W, H, pad } = SL;
    ctx.save();
    rrect(ctx, 0, 0, W, H, SL.radius);
    ctx.clip();
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, F.top);
    g.addColorStop(1, F.bottom);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    waves(ctx, F, W, H, 40, F.wave * 1.15);
    microtext(ctx, F, fonts, `PANTHEON · HYPE PASSPORT · ${v.wallet.toUpperCase()} · ${passportNo(v)} · `, W, H, SL.micro[0], SL.micro[1]);
    ctx.font = `500 ${SL.t1}px ${fonts.mono}`;
    ctx.fillStyle = rgba(F.fg, 0.72);
    spaced(ctx, "STAMPS", pad, SL.hy, SL.t1 * 0.27);
    spaced(ctx, `${STAMPS.filter((_, k) => got(k)).length} OF ${STAMPS.length}`, W - pad, SL.hy, SL.t1 * 0.2, "right");
    ctx.font = `500 ${SL.t2}px ${fonts.mono}`;
    ctx.fillStyle = rgba(F.fg, 0.36);
    spaced(ctx, "STAMPS · TAMPONS · SELLOS", pad, SL.hy + SL.t1 * 1.36, SL.t2 * 0.2);
    spaced(ctx, SL.right2, W - pad, SL.hy + SL.t1 * 1.36, SL.t2 * 0.2, "right");
    ctx.fillStyle = rgba(F.fg, F.line);
    ctx.fillRect(pad, SL.ry, W - 2 * pad, 1);
    SL.caps.forEach(([x, y, w, h], k) => {
      const st = STAMPS[k], has = got(k);
      if (flat) {
        // no glass on this device: print the stamps straight onto the page
        const tw = w * 0.94, th = h * 0.94;
        const ink = document.createElement("canvas");
        ink.width = Math.max(1, Math.round(tw * scale * s));
        ink.height = Math.max(1, Math.round(th * scale * s));
        const ic = ink.getContext("2d");
        if (ic) {
          ic.drawImage(atlas, (k % 4) * (atlas.width / 4), Math.floor(k / 4) * (atlas.height / 2), atlas.width / 4, atlas.height / 2, 0, 0, ink.width, ink.height);
          ic.globalCompositeOperation = "source-in";
          ic.fillStyle = rgba(INK[finish], 1);
          ic.fillRect(0, 0, ink.width, ink.height);
          ctx.save();
          ctx.globalAlpha = has ? 0.94 : 0.1;
          ctx.drawImage(ink, x + (w - tw) / 2, y + (h - th) / 2, tw, th);
          ctx.restore();
        }
      }
      if (forGlass) return;
      ctx.font = `500 ${SL.c1}px ${fonts.mono}`;
      ctx.fillStyle = rgba(F.fg, has ? 0.88 : 0.46);
      spaced(ctx, st.key, x + 2, y + h + SL.cy1, SL.c1 * 0.16);
      if (has) dot(ctx, x + w - 5, y + h + SL.cy1 - SL.c1 * 0.36, SL.c1 * 0.3);
      else {
        ctx.font = `500 ${SL.c2}px ${fonts.mono}`;
        ctx.fillStyle = rgba(F.fg, 0.4);
        spaced(ctx, "NOT YET", x + w - 2, y + h + SL.cy1, SL.c2 * 0.14, "right");
      }
      ctx.font = `400 ${SL.c3}px ${fonts.sans}`;
      ctx.fillStyle = rgba(F.fg, has ? 0.58 : 0.42);
      const caption = has ? st.have : st.need;
      ctx.fillText(caption, x + 2, y + h + SL.cy2, Math.min((SL.W - 2 * SL.pad) / (SL.W === WIDE.W ? 4 : 2) - 12, SL.W - SL.pad - x - 2));
    });
    ctx.font = `500 ${SL.t2}px ${fonts.mono}`;
    ctx.fillStyle = rgba(F.fg, 0.36);
    spaced(ctx, `ISSUED ${dmy(v.issued)} · PUBLIC REGISTRY`, pad, H - SL.fy, SL.t2 * 0.2);
    spaced(ctx, "02", W - pad, H - SL.fy, SL.t2 * 0.2, "right");
    ctx.restore();
    ctx.save();
    rrect(ctx, 0.5, 0.5, W - 1, H - 1, SL.radius - 0.5);
    ctx.strokeStyle = F.dark ? "rgba(255,255,255,0.10)" : "rgba(0,0,0,0.08)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

  // ---------------------------------------------------------------- the bubbles' motion
  // Each bubble: a size spring, a lean toward the pointer, a stretch that wobbles like jelly, a
  // sideways shake for "not yet", a glow under the finger, and its stamp's ink.
  const SB = STAMPS.map(() => ({ k: 1, vk: 0, lx: 0, ly: 0, vlx: 0, vly: 0, st: 0, vst: 0, ang: 0, sh: 0, vsh: 0, glow: 0, hover: 0, press: 0, t0: Infinity, ink: 0, scale: 1, hit: false, shown: false, from: 0.55, calm: 0 }));
  const SP = { x: -1e4, y: -1e4, z: 0, zt: 0 };
  let revealed = false, raf = 0, last = 0, onScreen = false;
  const easeOut = (u: number) => 1 - Math.pow(1 - clamp(u, 0, 1), 3);
  const capOf = (k: number) => {
    const [x, y, w, h] = SL.caps[k];
    return { cx: (x + w / 2) * s, cy: (y + h / 2) * s, hw: (w / 2) * s, hh: (h / 2) * s };
  };
  const insideCap = (k: number, px: number, py: number) => {
    const c = capOf(k), g = 1.04, e = c.hh * g;
    const qx = Math.max(Math.abs(px - c.cx) - (c.hw * g - e), 0), qy = Math.abs(py - c.cy);
    return Math.hypot(qx / e, qy / (c.hh * g)) <= 1;
  };
  function reveal(now: number) {
    revealed = true;
    SB.forEach((b, k) => {
      b.t0 = reduced ? -1e9 : now + 260 + k * 150;
      b.hit = reduced;
      b.shown = reduced;
    });
    kick();
  }
  function step(now: number, dt: number) {
    let busy = false;
    const steps = Math.max(1, Math.round(dt / (1 / 240)));
    const h = dt / steps;
    SP.z += (SP.zt - SP.z) * Math.min(1, dt * 6);
    if (Math.abs(SP.zt - SP.z) > 0.002) busy = true;
    SB.forEach((b, k) => {
      const c = capOf(k);
      const u = (now - b.t0) / 1000;
      if (got(k)) {
        if (!isFinite(b.t0)) {
          b.ink = 0;
          b.scale = 1;
        } else if (u < 0) {
          if (!b.shown) {
            b.ink = 0;
            b.scale = 1.06;
          }
          busy = true;
        } else {
          if (!b.hit) {
            // it lands: a thud the glass feels
            b.hit = true;
            b.from = b.shown ? 0.8 : 0.55;
            b.shown = true;
            if (!reduced && u < 0.3) {
              b.vk -= 1.9;
              b.ang = Math.PI / 2;
              b.vst -= 2.6;
              b.calm = now + 650;
            }
          }
          b.ink = b.from + (1 - b.from) * easeOut(u / 0.18);
          b.scale = 1 + 0.06 * (1 - easeOut(u / 0.24));
          if (u < 0.3) busy = true;
        }
      } else {
        b.ink = !isFinite(b.t0) || u < 0 ? 0 : easeOut(u / 0.6);
        b.scale = 1;
        if (isFinite(b.t0) && u < 0.6) busy = true;
      }
      const dx = SP.x - c.cx, dy = SP.y - c.cy, dist = Math.hypot(dx, dy);
      const wantK = 1 + 0.045 * b.hover - 0.045 * b.press;
      const wantLx = b.hover ? clamp(dx * 0.05, -4, 4) : 0, wantLy = b.hover ? clamp(dy * 0.05, -4, 4) : 0;
      const wantSt = b.hover && !b.press ? 0.035 * Math.min(1, dist / c.hh) : 0;
      if (b.hover && dist > 2 && now > b.calm) b.ang = Math.atan2(dy, dx); // not while a landing still wobbles
      for (let i = 0; i < steps; i++) {
        b.vk += (320 * (wantK - b.k) - 2 * Math.sqrt(320) * 0.42 * b.vk) * h;
        b.k += b.vk * h;
        b.vlx += (240 * (wantLx - b.lx) - 2 * Math.sqrt(240) * 0.5 * b.vlx) * h;
        b.lx += b.vlx * h;
        b.vly += (240 * (wantLy - b.ly) - 2 * Math.sqrt(240) * 0.5 * b.vly) * h;
        b.ly += b.vly * h;
        b.vst += (260 * (wantSt - b.st) - 2 * Math.sqrt(260) * 0.3 * b.vst) * h;
        b.st += b.vst * h;
        b.vsh += (900 * -b.sh - 2 * 30 * 0.16 * b.vsh) * h;
        b.sh += b.vsh * h;
      }
      const lit = b.hover || b.press ? 1 : 0;
      b.glow += (lit - b.glow) * Math.min(1, dt * 10);
      const moving =
        Math.abs(b.vk) + Math.abs(wantK - b.k) + Math.abs(b.vlx) + Math.abs(b.vly) + Math.abs(wantLx - b.lx) + Math.abs(wantLy - b.ly) +
        Math.abs(b.vst) + Math.abs(wantSt - b.st) + Math.abs(b.vsh) + Math.abs(b.sh);
      if (moving > 0.002 || Math.abs(lit - b.glow) > 0.003) busy = true;
    });
    return busy;
  }
  const UA = new Float32Array(32), UB = new Float32Array(32), UC = new Float32Array(32), UH = new Float32Array(16);
  function draw() {
    if (!prog) return;
    const { gl, U } = prog;
    const cw = Math.round(SL.W * s * dpr), ch = Math.round(SL.H * s * dpr);
    if (glass.width !== cw || glass.height !== ch) {
      glass.width = cw;
      glass.height = ch;
    }
    gl.viewport(0, 0, cw, ch);
    SB.forEach((b, k) => {
      const c = capOf(k);
      UA.set([c.cx + b.lx + b.sh, c.cy + b.ly, c.hw * b.k, c.hh * b.k], k * 4);
      UB.set([b.st, b.ang, b.glow, got(k) ? 0 : 1], k * 4);
      UC.set([c.cx, c.cy, b.scale, b.ink], k * 4);
      UH.set([c.hw * 0.94, c.hh * 0.94], k * 2);
    });
    gl.uniform2f(U.uRes, cw, ch);
    gl.uniform1f(U.uDpr, dpr);
    gl.uniform2f(U.uSize, SL.W * s, SL.H * s);
    gl.uniform4fv(U.uA, UA);
    gl.uniform4fv(U.uB, UB);
    gl.uniform4fv(U.uC, UC);
    gl.uniform2fv(U.uStampHalf, UH);
    const ink = INK[finish];
    gl.uniform3f(U.uInk, ink[0] / 255, ink[1] / 255, ink[2] / 255);
    gl.uniform1f(U.uDark, FINISH[finish].dark);
    gl.uniform3f(U.uPointer, SP.x, SP.y, SP.z);
    gl.uniform1f(U.uZoom, 1.12);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  function frame(now: number) {
    raf = 0;
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
    last = now;
    const busy = step(now, dt);
    draw();
    if (busy && onScreen) raf = requestAnimationFrame(frame);
  }
  function kick() {
    if (!raf) {
      last = 0;
      raf = requestAnimationFrame(frame);
    }
  }

  // ---------------------------------------------------------------- input
  /** Tapping a stamp you have stamps it again; one you don't have shakes its head. */
  function tap(k: number) {
    if (got(k)) {
      SB[k].t0 = performance.now() + 40;
      SB[k].hit = false;
    } else if (!reduced) SB[k].vsh += 260 * Math.max(s, 0.7);
    kick();
  }
  const hits = STAMPS.map((_, k) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.stamp = "";
    btn.addEventListener("click", () => tap(k));
    btn.addEventListener("focus", () => {
      SB[k].hover = 1;
      kick();
    });
    btn.addEventListener("blur", () => {
      SB[k].hover = 0;
      kick();
    });
    host.appendChild(btn);
    return btn;
  });
  const local = (e: PointerEvent): [number, number] => {
    const r = root.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  function point(x: number, y: number, present: boolean) {
    SP.x = x;
    SP.y = y;
    SP.zt = present ? 1 : 0;
    SB.forEach((b, k) => {
      b.hover = present && insideCap(k, x, y) ? 1 : 0;
    });
    kick();
  }
  const onMove = (e: PointerEvent) => {
    const [x, y] = local(e);
    point(x, y, e.pointerType === "mouse" || e.buttons > 0);
  };
  const onLeave = () => {
    SP.zt = 0;
    SB.forEach((b) => {
      b.hover = 0;
      b.press = 0;
    });
    kick();
  };
  const onDown = (e: PointerEvent) => {
    const [x, y] = local(e);
    point(x, y, true);
    SB.forEach((b, k) => {
      b.press = insideCap(k, x, y) ? 1 : 0;
    });
    kick();
  };
  const onUp = (e: PointerEvent) => {
    SB.forEach((b) => {
      b.press = 0;
    });
    if (e.pointerType !== "mouse") {
      SP.zt = 0;
      SB.forEach((b) => {
        b.hover = 0;
      });
    }
    kick();
  };
  root.addEventListener("pointermove", onMove);
  root.addEventListener("pointerleave", onLeave);
  root.addEventListener("pointerdown", onDown);
  root.addEventListener("pointerup", onUp);
  root.addEventListener("pointercancel", onUp);
  // The stamps come down the first time the page is well in view.
  const io = new IntersectionObserver(
    ([e]) => {
      onScreen = e.isIntersecting;
      if (e.isIntersecting && e.intersectionRatio > 0.3 && !revealed && view) reveal(performance.now());
      if (onScreen) kick();
    },
    { threshold: [0, 0.3, 0.6] },
  );
  io.observe(root);

  let atlasScale = 0;
  function labels() {
    hits.forEach((btn, k) => {
      const st = STAMPS[k];
      btn.setAttribute("aria-label", got(k) ? `${st.key} stamp, earned: ${st.have}` : `${st.key} stamp, not yet: ${st.need}`);
    });
  }
  function repaint() {
    if (!view) return;
    root.style.setProperty("--st-fg", finish === "ink" ? "#f4f4f2" : "#141414");
    paintPage(face, dpr, !prog, false);
    if (prog && texPanel) {
      paintPage(panelTex, Math.min(dpr * 1.35, 3.6), false, true);
      prog.upload(0, texPanel, panelTex);
    }
    labels();
    draw();
  }
  function paintStamps(force: boolean) {
    if (!view) return;
    const want = clamp(Math.round(dpr * 1.35 * s * 1.1 * 4) / 4, 2, 5);
    if (force || want !== atlasScale) {
      atlasScale = want;
      paintAtlas(atlas, atlasScale, fonts, view);
      if (prog && texAtlas) prog.upload(1, texAtlas, atlas);
    }
  }

  return {
    layout(lay: Layout) {
      const base = lay.tall ? TALL : WIDE;
      const measure = face.getContext("2d");
      if (measure) measure.font = `500 14px ${fonts.mono}`;
      SL = { ...base, caps: base.caps.map(([x, y, w, h], k): Cap => {
        const width = clamp((measure?.measureText(STAMPS[k].key).width ?? 60) + 44, 94, 132);
        const height = width / 1.42;
        return [x + (w - width) / 2, y + (h - height) / 2, width, height];
      }) };
      s = lay.s;
      dpr = lay.dpr;
      root.style.setProperty("--w", `${lay.W}px`);
      root.style.setProperty("--sh", `${SL.H * s}px`);
      root.style.setProperty("--radius", `${SL.radius * s}px`);
      SL.caps.forEach(([x, y, w, h], k) => {
        Object.assign(hits[k].style, { left: `${x * s}px`, top: `${y * s}px`, width: `${w * s}px`, height: `${h * s}px` });
      });
      paintStamps(false);
      repaint();
      if (revealed) kick();
      else if (onScreen && view) reveal(performance.now());
    },
    set(v: PassportView, f: FinishName) {
      const fresh = view === null;
      const dates = view && view.issued.getTime() !== v.issued.getTime();
      const stampsChanged = !!view && view.stamps.join() !== v.stamps.join();
      view = v;
      finish = f;
      if (fresh) return;
      if (dates) paintStamps(true);
      if (stampsChanged && revealed) reveal(performance.now());
      repaint();
    },
    destroy() {
      cancelAnimationFrame(raf);
      raf = 0;
      io.disconnect();
      root.removeEventListener("pointermove", onMove);
      root.removeEventListener("pointerleave", onLeave);
      root.removeEventListener("pointerdown", onDown);
      root.removeEventListener("pointerup", onUp);
      root.removeEventListener("pointercancel", onUp);
      hits.forEach((b) => b.remove());
      prog?.destroy();
    },
  };
}
