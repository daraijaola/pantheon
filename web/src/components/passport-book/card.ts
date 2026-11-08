// The Passport card: drawn on a canvas, floating, with a liquid-glass lens riding on it (WebGL).
// The lens is the iOS 26 tab-bar lens: a capsule 1.42 times as wide as it is tall that magnifies,
// bends what lies past its rim into the glass split into its colours, and stretches like jelly.

import { FINISH, PAGE, clamp, smooth, makeProgram, microtext, rgba, rosette, rrect, spaced, waves, type Finish, type FinishName, type Fonts } from "./draw";
import { TIER_NAMES, dmy, extraVotes, passportNo, shortWallet, type PassportView } from "./view";

/** Where the page is laid out: wide (760 × 520 design units) or tall (360 × 600), and its scale. */
export type Layout = { tall: boolean; W: number; s: number; dpr: number };

// PANTHEON in its bitmap face (components/code-type/glyphs.ts).
const GLYPHS: Record<string, string[]> = {
  A: [".#####.", "#######", "##...##", "##...##", "#######", "#######", "##...##", "##...##", "##...##", "##...##"],
  E: ["######", "######", "##....", "##....", "#####.", "#####.", "##....", "##....", "######", "######"],
  H: ["##...##", "##...##", "##...##", "##...##", "#######", "#######", "##...##", "##...##", "##...##", "##...##"],
  N: ["###...##", "####..##", "####..##", "##.##.##", "##.##.##", "##..####", "##..####", "##...###", "##...###", "##....##"],
  O: [".#####.", "#######", "##...##", "##...##", "##...##", "##...##", "##...##", "##...##", "#######", ".#####."],
  P: ["######.", "#######", "##...##", "##...##", "#######", "######.", "##.....", "##.....", "##.....", "##....."],
  T: ["######", "######", "..##..", "..##..", "..##..", "..##..", "..##..", "..##..", "..##..", "..##.."],
};
function wordmark(ctx: CanvasRenderingContext2D, x: number, y: number, m: number, color: string) {
  ctx.fillStyle = color;
  let cx = x;
  [..."PANTHEON"].forEach((ch, i) => {
    if (i) cx += m;
    const g = GLYPHS[ch];
    g.forEach((row, ry) => {
      for (let c = 0; c < row.length; ) {
        if (row[c] !== "#") {
          c++;
          continue;
        }
        let e = c;
        while (e < row.length && row[e] === "#") e++;
        ctx.fillRect(cx + c * m, y + ry * m, (e - c) * m, m);
        c = e;
      }
    });
    cx += g[0].length * m;
  });
}

type Ink = { F: Finish; fonts: Fonts; v: PassportView };
function label({ F, fonts }: Ink, ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size = 9.5) {
  ctx.font = `500 ${size}px ${fonts.mono}`;
  ctx.fillStyle = rgba(F.fg, F.label);
  spaced(ctx, text, x, y, size * 0.14);
}
function value({ F, fonts }: Ink, ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size = 16, mono = false, weight = 500) {
  ctx.font = `${weight} ${size}px ${mono ? fonts.mono : fonts.sans}`;
  ctx.fillStyle = rgba(F.fg, F.text);
  if (mono) spaced(ctx, text, x, y, size * 0.04);
  else ctx.fillText(text, x, y);
}

// ------------------------------------------------------------------ the photo
// A head and shoulders in halftone dots, the dot-matrix of the menu icons grown into a portrait, lit
// from the upper left. Generic on purpose: it stands in for whoever holds the wallet.
type V3 = [number, number, number];
const smin = (a: number, b: number, k: number) => {
  const h = clamp(0.5 + (0.5 * (b - a)) / k, 0, 1);
  return b * (1 - h) + a * h - k * h * (1 - h);
};
const mixv = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const unit = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
function bust(X: number, Y: number) {
  // In units of the photo's width, Y running down: a large head, a short neck, shoulders out of frame.
  const hcy = 0.47, ry = 0.31, dx = X - 0.5;
  const dy = (Y - hcy) / ry;
  const rx = 0.235 * (1 - 0.2 * smooth(0, 1, dy)) * (1 + 0.04 * smooth(0, 1, -dy));
  const qx = dx / rx, qy = dy;
  const qh = Math.hypot(qx, qy);
  const dSkull = (qh - 1) * Math.min(rx, ry);
  const ex = (Math.abs(dx) - 0.226) / 0.032, ey = (Y - 0.5) / 0.066;
  const dEar = (Math.hypot(ex, ey) - 1) * 0.032;
  const dHead = smin(dSkull, dEar, 0.015);
  // the body as a profile: the neck, the slope of the trapezius, the round of the shoulder
  const t1 = clamp((Y - 0.84) / 0.2, 0, 1);
  const wB = 0.125 + 0.355 * t1 * t1 * (3 - 2 * t1) + 0.05 * smooth(1.04, 1.3, Y);
  const dw = (0.355 * 6 * t1 * (1 - t1)) / 0.2;
  const dBody = Math.max((Math.abs(dx) - wB) / Math.sqrt(1 + dw * dw), 0.62 - Y);
  const d = smin(dHead, dBody, 0.035);
  const wEar = smooth(-0.01, 0.01, dSkull - dEar);
  const nHead = mixv([qx, qy, Math.sqrt(Math.max(0, 1 - qh * qh))], [Math.sign(dx) * 0.75, ey * 0.3, 0.6], wEar);
  const bx = clamp(dx / wB, -1, 1);
  const nBody: V3 = [bx, -0.55 * Math.tanh(dw * 0.8) * Math.abs(bx) - 0.08, Math.sqrt(1 - bx * bx) + 0.12];
  const wSh = smooth(0.86, 0.96, Y);
  const wBody = smooth(-0.02, 0.02, dHead - dBody);
  const N = unit(mixv(nHead, nBody, wBody));
  let lum = 0.14 + 0.86 * Math.max(0, N[0] * -0.5 + N[1] * -0.55 + N[2] * 0.67);
  // skin, hair above a hairline, a shirt open at the neck
  const hairline = hcy - 0.28 * ry + 0.34 * ry * (dx / 0.235) ** 2;
  const hair = (1 - wBody) * (1 - wEar) * smooth(0.012, -0.012, Y - hairline);
  const vHalf = 0.1 * (1 - (Y - 0.97) / 0.22);
  const vNeck = Y < 0.97 ? 1 : Y < 1.19 ? smooth(0.008, -0.008, Math.abs(dx) - vHalf) : 0;
  const shirt = wBody * wSh * (1 - vNeck);
  let albedo = (0.86 - 0.14 * wEar) * (1 - hair) + 0.28 * hair;
  albedo = albedo * (1 - shirt) + 0.48 * shirt;
  lum *= 1 - 0.45 * wBody * (1 - shirt) * (1 - smooth(hcy + ry * 0.9, hcy + ry * 1.5, Y)); // the chin shades the neck
  const rimLight = Math.pow(1 - N[2], 1.8) * Math.max(0, N[0]);
  return { d, bright: clamp(lum * albedo, 0, 1), rimLight };
}
function portrait(ctx: CanvasRenderingContext2D, F: Finish, x: number, y: number, w: number, h: number, r: number) {
  ctx.save();
  rrect(ctx, x, y, w, h, r);
  ctx.clip();
  const bg = ctx.createLinearGradient(0, y, 0, y + h);
  bg.addColorStop(0, F.photo);
  bg.addColorStop(1, F.photo2);
  ctx.fillStyle = bg;
  ctx.fillRect(x, y, w, h);
  const cols = 33;
  const p = w / cols;
  const rows = Math.ceil(h / p);
  const oy = (h - rows * p) / 2;
  const rMax = p * 0.54;
  ctx.fillStyle = rgba(F.fg, F.dot);
  ctx.beginPath();
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const X = (i + 0.5) / cols, Y = (oy + (j + 0.5) * p) / w;
      const b = bust(X, Y);
      const cov = clamp(0.5 - b.d * cols * 0.9, 0, 1);
      const glow = Math.exp(-((X - 0.64) ** 2 + (Y - 0.32) ** 2) / 0.09);
      let a: number;
      if (F.dark) a = cov * (0.04 + 0.9 * Math.pow(b.bright, 1.1) + 0.6 * b.rimLight) + (1 - cov) * (0.03 + 0.07 * glow);
      else {
        const edge = cov * (1 - smooth(0, 2.2 / cols, -b.d));
        a = cov * (0.08 + 0.82 * Math.pow(1 - b.bright, 1.2) + 0.22 * edge) + (1 - cov) * (0.02 + 0.02 * (1 - glow));
      }
      const rd = rMax * Math.sqrt(clamp(a, 0, 1));
      if (rd < 0.12) continue;
      const cx = x + (i + 0.5) * p, cy = y + oy + (j + 0.5) * p;
      ctx.moveTo(cx + rd, cy);
      ctx.arc(cx, cy, rd, 0, Math.PI * 2);
    }
  }
  ctx.fill();
  ctx.restore();
  ctx.save();
  rrect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, r);
  ctx.strokeStyle = rgba(F.fg, F.photoRule);
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}

// The seal: rings, a fine rosette and the tier, with its name running round the rim.
function seal({ F, fonts, v }: Ink, ctx: CanvasRenderingContext2D, cx: number, cy: number, R: number) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.fillStyle = F.dark ? "#161616" : "#f6f6f4";
  ctx.fill();
  ctx.fillStyle = F.sealFill;
  ctx.fill();
  ctx.strokeStyle = rgba(F.fg, 0.5);
  ctx.lineWidth = 0.8;
  for (const k of [1, 0.93, 0.62]) {
    ctx.beginPath();
    ctx.arc(cx, cy, R * k, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.lineWidth = 0.5;
  ctx.strokeStyle = rgba(F.fg, 0.28);
  for (let k = 0; k < 24; k++) {
    ctx.beginPath();
    for (let i = 0; i <= 240; i++) {
      const t = (i / 240) * Math.PI * 2;
      const r = R * (0.5 + 0.06 * Math.sin(12 * t + (k / 24) * Math.PI * 2));
      const x = cx + r * Math.cos(t), y = cy + r * Math.sin(t);
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    }
    ctx.stroke();
  }
  const text = `HYPE PASSPORT · TIER ${v.tier} · ${(TIER_NAMES[v.tier] ?? "").toUpperCase()} · `;
  ctx.font = `500 ${R * 0.13}px ${fonts.mono}`;
  ctx.fillStyle = rgba(F.fg, 0.62);
  ctx.textBaseline = "middle";
  for (let i = 0; i < text.length; i++) {
    const a = -Math.PI / 2 + (i / text.length) * Math.PI * 2;
    ctx.save();
    ctx.translate(cx + Math.cos(a) * R * 0.78, cy + Math.sin(a) * R * 0.78);
    ctx.rotate(a + Math.PI / 2);
    ctx.fillText(text[i], -ctx.measureText(text[i]).width / 2, 0);
    ctx.restore();
  }
  ctx.font = `600 ${R * 0.6}px ${fonts.sans}`;
  ctx.fillStyle = rgba(F.fg, 0.92);
  ctx.textBaseline = "alphabetic";
  const t = String(v.tier);
  ctx.fillText(t, cx - ctx.measureText(t).width / 2, cy + R * 0.22);
  ctx.restore();
}

function mrz({ F, fonts }: Ink, ctx: CanvasRenderingContext2D, x0: number, x1: number, y1: number, y2: number, size: number) {
  const lines = ["PUBLIC ELYSIUM REGISTRY RECORD", "DECORATIVE ART · NOT AN ID DOCUMENT"].map(line => line.padEnd(44, " "));
  ctx.font = `500 ${size}px ${fonts.mono}`;
  ctx.fillStyle = rgba(F.fg, 0.86);
  const adv = ctx.measureText("<").width;
  const sp = (x1 - x0 - 44 * adv) / 43;
  for (const [line, y] of [[lines[0], y1], [lines[1], y2]] as const) {
    let x = x0;
    for (const c of line) {
      ctx.fillText(c, x, y);
      x += adv + sp;
    }
  }
}

function header(ink: Ink, ctx: CanvasRenderingContext2D, x: number, y: number, m: number, size: number, sub: string, right: number, subSize: number, subY: number) {
  const { F, fonts } = ink;
  wordmark(ctx, x, y, m, rgba(F.fg, 0.95));
  ctx.font = `500 ${size}px ${fonts.mono}`;
  ctx.fillStyle = rgba(F.fg, 0.72);
  spaced(ctx, "HYPE PASSPORT", right, y + size * 1.27, size * 0.27, "right");
  ctx.font = `500 ${subSize}px ${fonts.mono}`;
  ctx.fillStyle = rgba(F.fg, 0.36);
  spaced(ctx, sub, right, subY, subSize * 0.2, "right");
}

// ------------------------------------------------------------------ the two layouts
type CardLayout = {
  W: number;
  H: number;
  radius: number;
  lens: [number, number];
  tour: [number, number][];
  seal: [number, number, number];
  draw: (ink: Ink, ctx: CanvasRenderingContext2D) => void;
};
const WIDE: CardLayout = {
  W: 760, H: 520, radius: 30, lens: [59, 41], seal: [204, 312, 36],
  tour: [[350, 262], [138, 196], [156, 74], [600, 150], [590, 350], [330, 447], [204, 312], [330, 186]],
  draw(ink, ctx) {
    const { F, v } = ink;
    const W = 760, H = 520;
    rosette(ctx, F, 560, 226, 250);
    waves(ctx, F, W, H, 26, F.wave);
    ctx.fillStyle = rgba(F.fg, F.band);
    ctx.fillRect(0, 404, W, H - 404);
    microtext(ctx, F, ink.fonts, `PANTHEON · HYPE PASSPORT · ${v.wallet.toUpperCase()} · ${passportNo(v)} · `, W, H, 12, 32);
    header(ink, ctx, 40, 36, 2.6, 11, "PASSPORT · PASSEPORT · PASAPORTE", 720, 7.4, 65);
    ctx.fillStyle = rgba(F.fg, F.line);
    ctx.fillRect(40, 86, 680, 1);
    ctx.fillRect(0, 404, W, 1);
    portrait(ctx, F, 40, 108, 172, 212, 14);
    seal(ink, ctx, 204, 312, 36);
    const x0 = 260;
    label(ink, ctx, "WALLET SUFFIX", x0, 120);
    value(ink, ctx, passportNo(v), x0, 142, 16, true);
    label(ink, ctx, "TYPE", x0 + 176, 120);
    value(ink, ctx, "P", x0 + 176, 142, 16, true);
    label(ink, ctx, "ISSUED BY", x0 + 268, 120);
    value(ink, ctx, "PANTHEON", x0 + 268, 142, 16, true);
    label(ink, ctx, "HOLDER · ELYSIUM WALLET", x0, 172);
    value(ink, ctx, shortWallet(v), x0, 194, 16, true);
    label(ink, ctx, "TIER", x0, 224);
    ctx.font = `500 68px ${ink.fonts.sans}`;
    ctx.fillStyle = rgba(F.fg, F.text);
    ctx.fillText(String(v.tier), x0 - 3, 290);
    const tw = ctx.measureText(String(v.tier)).width;
    value(ink, ctx, TIER_NAMES[v.tier] ?? "", x0 + tw + 14, 288, 30);
    ctx.font = `500 9px ${ink.fonts.mono}`;
    ctx.fillStyle = rgba(F.fg, F.label);
    spaced(ctx, `TIER ${v.tier} OF 3 · REGISTRY RECORD`, x0 + tw + 16, 262, 1.2);
    label(ink, ctx, "STAKING BOOST", x0, 322);
    value(ink, ctx, v.boost, x0, 345, 19);
    label(ink, ctx, "TRIALS VOTES", x0 + 150, 322);
    value(ink, ctx, `+${extraVotes(v)}`, x0 + 150, 345, 19);
    label(ink, ctx, "EXPIRES", x0 + 300, 322);
    value(ink, ctx, dmy(v.valid), x0 + 300, 345, 15, true);
    label(ink, ctx, "ISSUED", x0, 370);
    value(ink, ctx, dmy(v.issued), x0, 391, 13, true, 400);
    label(ink, ctx, "LINKED SINCE", x0 + 150, 370);
    value(ink, ctx, dmy(v.linked), x0 + 150, 391, 13, true, 400);
    label(ink, ctx, "STATUS", x0 + 300, 370);
    ctx.fillStyle = rgba(F.fg, F.text);
    ctx.beginPath();
    ctx.arc(x0 + 304, 386.5, 3.2, 0, Math.PI * 2);
    ctx.fill();
    value(ink, ctx, v.example ? "EXAMPLE" : (v.status ?? "Valid").toUpperCase(), x0 + 314, 391, 13, true, 500);
    mrz(ink, ctx, 40, 720, 446, 480, 15);
  },
};
const TALL: CardLayout = {
  W: 360, H: 600, radius: 26, lens: [40, 28], seal: [140, 228, 26],
  tour: [[228, 130], [86, 142], [104, 52], [140, 228], [120, 312], [180, 402], [180, 548]],
  draw(ink, ctx) {
    const { F, v } = ink;
    const W = 360, H = 600;
    rosette(ctx, F, 250, 250, 190);
    waves(ctx, F, W, H, 26, F.wave);
    ctx.fillStyle = rgba(F.fg, F.band);
    ctx.fillRect(0, 506, W, H - 506);
    microtext(ctx, F, ink.fonts, `PANTHEON · HYPE PASSPORT · ${v.wallet.toUpperCase()} · ${passportNo(v)} · `, W, H, 10, 28);
    header(ink, ctx, 24, 28, 1.9, 8.6, "PASSPORT · PASSEPORT", 336, 6, 50);
    ctx.fillStyle = rgba(F.fg, F.line);
    ctx.fillRect(24, 66, 312, 1);
    ctx.fillRect(0, 506, W, 1);
    portrait(ctx, F, 24, 84, 124, 154, 12);
    seal(ink, ctx, 140, 228, 26);
    const x0 = 168;
    label(ink, ctx, "TIER", x0, 98, 8.4);
    ctx.font = `500 56px ${ink.fonts.sans}`;
    ctx.fillStyle = rgba(F.fg, F.text);
    ctx.fillText(String(v.tier), x0 - 2, 152);
    const tw = ctx.measureText(String(v.tier)).width;
    value(ink, ctx, TIER_NAMES[v.tier] ?? "", x0 + tw + 10, 150, 22);
    label(ink, ctx, "STAKING BOOST", x0, 184, 8.4);
    value(ink, ctx, v.boost, x0, 204, 17);
    label(ink, ctx, "VOTES", x0 + 92, 184, 8.4);
    value(ink, ctx, `+${extraVotes(v)}`, x0 + 92, 204, 17);
    label(ink, ctx, "STATUS", x0, 226, 8.4);
    ctx.fillStyle = rgba(F.fg, F.text);
    ctx.beginPath();
    ctx.arc(x0 + 3.5, 237.5, 3, 0, Math.PI * 2);
    ctx.fill();
    value(ink, ctx, v.example ? "EXAMPLE" : (v.status ?? "Valid").toUpperCase(), x0 + 12, 242, 12, true);
    label(ink, ctx, "WALLET SUFFIX", 24, 274, 8.4);
    value(ink, ctx, passportNo(v), 24, 294, 14, true);
    label(ink, ctx, "ISSUED BY", 196, 274, 8.4);
    value(ink, ctx, "PANTHEON", 196, 294, 14, true);
    label(ink, ctx, "HOLDER · ELYSIUM WALLET", 24, 322, 8.4);
    value(ink, ctx, shortWallet(v), 24, 342, 14, true);
    label(ink, ctx, "EXPIRES", 24, 370, 8.4);
    value(ink, ctx, dmy(v.valid), 24, 390, 13, true);
    label(ink, ctx, "LINKED SINCE", 196, 370, 8.4);
    value(ink, ctx, dmy(v.linked), 196, 390, 13, true, 400);
    label(ink, ctx, "ISSUED", 24, 418, 8.4);
    value(ink, ctx, dmy(v.issued), 24, 438, 13, true, 400);
    mrz(ink, ctx, 22, 338, 542, 572, 10.2);
  },
};

// ------------------------------------------------------------------ the glass (WebGL)
const FRAG = `precision highp float;
uniform sampler2D uTex;
uniform vec2 uRes;
uniform float uDpr;
uniform float uM;
uniform vec2 uCard;
uniform vec2 uC;
uniform vec2 uHalf;
uniform float uAngle;
uniform float uStretch;
uniform float uZoom;
uniform float uAlpha;
uniform float uDark;
uniform vec3 uPage;
uniform vec2 uTilt;
uniform vec3 uSeal;
uniform float uRadius;

float sdRoundBox(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
float sdCard(vec2 p){ return sdRoundBox(p - uCard * 0.5, uCard * 0.5, uRadius); }

// The lens in its own frame: stretched along the way it moves, thinner across it.
vec2 local(vec2 f){
  vec2 p = f - uC;
  float c = cos(uAngle), s = sin(uAngle);
  vec2 q = vec2(c * p.x + s * p.y, -s * p.x + c * p.y);
  q /= vec2(1.0 + uStretch, 1.0 - 0.5 * uStretch);
  return vec2(c * q.x - s * q.y, s * q.x + c * q.y);
}
// The outline of the iOS tab-bar lens, traced off a screenshot: a capsule 1.42 times as wide as it is
// tall, its ends very nearly half-circles. An implicit ellipse turned into a distance.
float pebble(vec2 q, vec2 h){
  float e = h.y * 0.96;
  vec2 p = vec2(max(abs(q.x) - (h.x - e), 0.0), abs(q.y));
  vec2 r = vec2(e, h.y);
  float R = length(p / r);
  float lg = length(p / (r * r));
  return lg > 1e-6 ? (R - 1.0) * R / lg : abs(q.y) - h.y;
}
float lens(vec2 f){ return pebble(local(f), uHalf); }

// What lies under the glass: the card, or the page round it (darker in the card's shadow).
vec3 under(vec2 f){
  vec2 cp = f - vec2(uM);
  vec2 uv = cp / uCard;
  vec4 t = (uv.x >= 0.0 && uv.y >= 0.0 && uv.x <= 1.0 && uv.y <= 1.0) ? texture2D(uTex, uv) : vec4(0.0);
  float sh = 1.0 - smoothstep(-6.0, 44.0, sdCard(cp - vec2(0.0, 20.0)) + 10.0);
  return mix(uPage * (1.0 - 0.18 * sh), t.rgb, t.a);
}

void main(){
  vec2 f = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uDpr;
  vec2 cp = f - vec2(uM);
  float px = 1.0 / uDpr;

  // the card's own sheen, a soft band that moves as it tilts, and the foil seal
  float onCard = smoothstep(px, -px, sdCard(cp));
  vec2 uv = cp / uCard - 0.5;
  float along = dot(uv, normalize(vec2(0.9, 0.55)));
  float band = exp(-pow((along - 0.05 - uTilt.x * 0.32 - uTilt.y * 0.18) / 0.15, 2.0));
  float gloss = band * mix(0.03, 0.065, uDark) * onCard;
  float sd = length(cp - uSeal.xy);
  float inSeal = smoothstep(uSeal.z + px, uSeal.z - px, sd);
  float ang = atan(cp.y - uSeal.y, cp.x - uSeal.x);
  float foil = pow(0.5 + 0.5 * sin(ang * 2.0 + uTilt.x * 5.0 - uTilt.y * 3.0 + sd * 0.16), 3.0);
  float sheen = gloss + inSeal * foil * mix(0.12, 0.26, uDark);
  vec4 below = vec4(vec3(sheen), sheen);

  float b = uHalf.y;
  float d = lens(f);
  float ds = lens(f - vec2(0.0, 0.1 * b));
  float shadow = (1.0 - smoothstep(-0.15 * b, 0.55 * b, ds)) * mix(0.16, 0.3, uDark) * uAlpha;
  if (d > 1.5 * px && shadow < 0.002) { gl_FragColor = below; return; }

  vec2 e = vec2(0.5, 0.0);
  vec2 grad = vec2(lens(f + e.xy) - lens(f - e.xy), lens(f + e.yx) - lens(f - e.yx));
  vec2 n = grad / max(length(grad), 1e-5);
  float depth = max(-d, 0.0);
  // the middle magnified; the rim bends in what lies just past it, split into its colours
  float t = clamp(depth / (0.5 * b), 0.0, 1.0);
  float rim = (1.0 - t) * (1.0 - t);
  vec2 base = uC + (f - uC) / uZoom;
  vec2 off = n * b * 0.7 * rim;
  float k = 0.32;
  vec3 col;
  col.r = under(base + off * (1.0 - k)).r;
  col.g = under(base + off).g;
  col.b = under(base + off * (1.0 + k)).b;

  float v = clamp(local(f).y / b, -1.0, 1.0);
  col = mix(col, vec3(1.0), mix(0.012, 0.03, uDark) + 0.018 * (0.5 - 0.5 * v));
  col += vec3(1.0) * rim * mix(0.025, 0.055, uDark);
  vec2 Ld = normalize(vec2(-0.5 + uTilt.x * 0.7, -0.86 + uTilt.y * 0.5));
  float facing = max(dot(n, Ld), 0.0);
  float spec = pow(facing, 3.0) * exp(-depth / (b * 0.085));
  float bounce = pow(max(dot(n, -Ld), 0.0), 4.0) * exp(-depth / (b * 0.055));
  col += vec3(1.0) * (spec * mix(0.26, 0.38, uDark) + bounce * mix(0.1, 0.18, uDark));
  float s2 = sin(2.0 * atan(n.y, n.x));
  vec3 iri = mix(vec3(1.0, 0.45, 0.2), vec3(0.15, 0.82, 0.92), 0.5 - 0.5 * s2);
  float irr = exp(-pow((depth - 0.055 * b) / (0.04 * b), 2.0)) * (0.3 + 0.7 * abs(s2));
  col += (iri - vec3(0.5)) * irr * mix(0.16, 0.24, uDark);
  float hair = exp(-pow((depth - 1.2) / 0.8, 2.0));
  col += vec3(1.0) * hair * (0.18 + 0.36 * facing) * mix(0.9, 1.0, uDark);
  float edge = exp(-pow((d + 0.35) / 0.8, 2.0));
  col = mix(col, vec3(0.0), edge * mix(0.42, 0.55, uDark));

  float a = smoothstep(px, -px, d) * uAlpha;
  vec4 outside = below + vec4(0.0, 0.0, 0.0, shadow * (1.0 - smoothstep(px, -px, d))) * (1.0 - below.a);
  gl_FragColor = vec4(clamp(col, 0.0, 1.0) * a, a) + outside * (1.0 - a);
}`;
const NAMES = ["uTex", "uRes", "uDpr", "uM", "uCard", "uC", "uHalf", "uAngle", "uStretch", "uZoom", "uAlpha", "uDark", "uPage", "uTilt", "uSeal", "uRadius"] as const;

export type CardEls = { scene: HTMLElement; card: HTMLElement; face: HTMLCanvasElement; glass: HTMLCanvasElement; floor: HTMLElement };

export function createCard(els: CardEls, fonts: Fonts, reduced: boolean) {
  const { scene, card, face, glass, floor } = els;
  const lensTex = document.createElement("canvas");
  const prog = makeProgram(glass, FRAG, NAMES);
  const tex = prog?.texture(0) ?? null;
  if (prog) prog.gl.uniform1i(prog.U.uTex, 0);

  let L: CardLayout = WIDE, W = 760, H = 520, s = 1, M = 147, dpr = 1;
  let view: PassportView | null = null;
  let finish: FinishName = "ink";

  function paint(canvas: HTMLCanvasElement, scale: number) {
    if (!view) return;
    canvas.width = Math.round(W * scale);
    canvas.height = Math.round(H * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.scale(canvas.width / L.W, canvas.height / L.H);
    const F = FINISH[finish];
    ctx.save();
    rrect(ctx, 0, 0, L.W, L.H, L.radius);
    ctx.clip();
    const g = ctx.createLinearGradient(0, 0, 0, L.H);
    g.addColorStop(0, F.top);
    g.addColorStop(1, F.bottom);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, L.W, L.H);
    L.draw({ F, fonts, v: view }, ctx);
    ctx.restore();
    ctx.save();
    rrect(ctx, 0.5, 0.5, L.W - 1, L.H - 1, L.radius - 0.5);
    ctx.strokeStyle = F.dark ? "rgba(255,255,255,0.10)" : "rgba(0,0,0,0.08)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }
  function repaint() {
    paint(face, dpr);
    paint(lensTex, Math.min(dpr * 1.35, 3.6));
    if (prog && tex) prog.upload(0, tex, lensTex);
  }

  // ---------------------------------------------------------------- motion
  const S = { x: 0, y: 0, vx: 0, vy: 0, sx: 0, sy: 0, svx: 0, svy: 0, k: 0.6, vk: 0, a: 0, tx: 0, ty: 0, press: 0, hover: false, lastMove: -1e9, tourAt: 0, tourI: 0, rx: 0, ry: 0, trx: 0, try: 0 };
  let started = false;
  const toCard = (e: PointerEvent): [number, number] => {
    const r = card.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H];
  };
  function aim(x: number, y: number, inside = false) {
    const f = inside ? 1.08 : 0.8; // a pointer may take the glass a little over the edge, as the iOS lens overhangs its bar
    const hx = L.lens[0] * s * f, hy = L.lens[1] * s * f;
    S.tx = clamp(x, hx, W - hx);
    S.ty = clamp(y, hy, H - hy);
  }
  function tour(now: number) {
    const p = L.tour[S.tourI % L.tour.length];
    aim(p[0] * s, p[1] * s, true);
    S.tourI++;
    S.tourAt = now + 2600;
  }
  const onEnter = (e: PointerEvent) => {
    if (e.pointerType !== "mouse") return;
    S.hover = true;
    card.dataset.lensing = "";
  };
  const onLeave = (e: PointerEvent) => {
    if (e.pointerType === "mouse") {
      S.hover = false;
      delete card.dataset.lensing;
      S.lastMove = performance.now();
      aim(S.tx, S.ty, true);
    }
    S.trx = S.try = 0;
  };
  const onMove = (e: PointerEvent) => {
    const [x, y] = toCard(e);
    S.lastMove = performance.now();
    if (e.pointerType === "mouse" || e.buttons) aim(x, y);
    S.trx = clamp((0.5 - y / H) * 2, -1, 1);
    S.try = clamp((x / W - 0.5) * 2, -1, 1);
  };
  const onDown = (e: PointerEvent) => {
    const [x, y] = toCard(e);
    S.press = 1;
    S.lastMove = performance.now();
    aim(x, y);
    card.setPointerCapture?.(e.pointerId);
  };
  const onUp = () => {
    S.press = 0;
    S.lastMove = performance.now();
    if (!S.hover) aim(S.tx, S.ty, true);
  };
  const onKey = (e: KeyboardEvent) => {
    const step = 24 * s;
    const k = ({ ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] } as Record<string, [number, number]>)[e.key];
    if (!k) return;
    e.preventDefault();
    S.lastMove = performance.now();
    aim(S.tx + k[0], S.ty + k[1]);
  };
  card.addEventListener("pointerenter", onEnter);
  card.addEventListener("pointerleave", onLeave);
  card.addEventListener("pointermove", onMove);
  card.addEventListener("pointerdown", onDown);
  card.addEventListener("pointerup", onUp);
  card.addEventListener("pointercancel", onUp);
  card.addEventListener("keydown", onKey);

  let last = 0, raf = 0, visible = true, alive = true;
  const io = new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
  });
  io.observe(scene);
  function frame(now: number) {
    raf = alive ? requestAnimationFrame(frame) : 0;
    if (!visible || !view || document.hidden) {
      last = 0;
      return;
    }
    const t = now / 1000;
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
    last = now;
    if (!started) {
      started = true;
      const p = L.tour[0];
      S.x = S.tx = p[0] * s;
      S.y = S.ty = p[1] * s;
      S.tourAt = now + 2600;
      S.tourI = 1;
    }
    // When no one is steering, the glass looks round the passport on its own.
    const idle = !S.hover && !S.press && now - S.lastMove > 3200;
    if (idle && !reduced && now > S.tourAt) tour(now);
    const steps = Math.max(1, Math.round(dt / (1 / 240)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      // position: a quick spring that just overshoots
      const kp = S.hover || S.press ? 340 : 120, cp = 2 * Math.sqrt(kp) * (S.hover || S.press ? 0.86 : 0.8);
      S.vx += (kp * (S.tx - S.x) - cp * S.vx) * h;
      S.vy += (kp * (S.ty - S.y) - cp * S.vy) * h;
      S.x += S.vx * h;
      S.y += S.vy * h;
      // shape: stretches with speed and wobbles back when it stops (an underdamped spring)
      const sp = Math.hypot(S.vx, S.vy);
      const want = reduced ? 0 : Math.min(sp / (3200 * Math.max(s, 0.6)), 0.12);
      const dirx = sp > 1e-3 ? S.vx / sp : 1, diry = sp > 1e-3 ? S.vy / sp : 0;
      S.svx += (210 * (dirx * want - S.sx) - 9 * S.svx) * h;
      S.svy += (210 * (diry * want - S.sy) - 9 * S.svy) * h;
      S.sx += S.svx * h;
      S.sy += S.svy * h;
      // size: grows when pressed; appears with a little bounce
      S.vk += (260 * (1 + 0.05 * S.press - S.k) - 15 * S.vk) * h;
      S.k += S.vk * h;
      S.a += (1 - S.a) * Math.min(1, h * 5);
      // the card leans toward the pointer
      const ik = idle || reduced ? 0 : 1;
      S.rx += (S.trx * ik - S.rx) * Math.min(1, h * 6);
      S.ry += (S.try * ik - S.ry) * Math.min(1, h * 6);
    }
    const fy = reduced ? 0 : Math.sin(t * 1.05) * 4;
    const rx = reduced ? 0 : S.rx * 6 + Math.sin(t * 0.7) * 0.8;
    const ry = reduced ? 0 : S.ry * 8 + Math.sin(t * 0.53 + 1) * 1.2;
    card.style.setProperty("--rx", `${rx.toFixed(3)}deg`);
    card.style.setProperty("--ry", `${ry.toFixed(3)}deg`);
    card.style.setProperty("--fy", `${(-6 + fy).toFixed(2)}px`);
    floor.style.setProperty("--fs", (1 - fy * 0.012).toFixed(3));
    floor.style.setProperty("--fo", (0.9 - fy * 0.03).toFixed(3));
    draw(rx / 8, ry / 10);
  }
  function draw(tiltX: number, tiltY: number) {
    if (!prog) return;
    const { gl, U } = prog;
    const cw = Math.round((W + 2 * M) * dpr), ch = Math.round((H + 2 * M) * dpr);
    if (glass.width !== cw || glass.height !== ch) {
      glass.width = cw;
      glass.height = ch;
    }
    gl.viewport(0, 0, cw, ch);
    const F = FINISH[finish];
    const st = Math.hypot(S.sx, S.sy);
    const ang = st > 1e-4 ? Math.atan2(S.sy, S.sx) : 0;
    // a stretch that has swung past zero squashes the other way: keep its sign
    const sign = S.sx * Math.cos(ang) + S.sy * Math.sin(ang) >= 0 ? 1 : -1;
    gl.uniform2f(U.uRes, cw, ch);
    gl.uniform1f(U.uDpr, dpr);
    gl.uniform1f(U.uM, M);
    gl.uniform2f(U.uCard, W, H);
    gl.uniform2f(U.uC, S.x + M, S.y + M);
    gl.uniform2f(U.uHalf, L.lens[0] * s * S.k, L.lens[1] * s * S.k);
    gl.uniform1f(U.uAngle, ang);
    gl.uniform1f(U.uStretch, st * sign);
    gl.uniform1f(U.uZoom, 1.15);
    gl.uniform1f(U.uAlpha, S.a);
    gl.uniform1f(U.uDark, F.dark);
    gl.uniform3f(U.uPage, PAGE[0] / 255, PAGE[1] / 255, PAGE[2] / 255);
    gl.uniform2f(U.uTilt, tiltY, tiltX);
    gl.uniform3f(U.uSeal, L.seal[0] * s, L.seal[1] * s, L.seal[2] * s);
    gl.uniform1f(U.uRadius, L.radius * s);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  return {
    /** Lay the card out (and draw it) for the page's layout. */
    layout(lay: Layout) {
      L = lay.tall ? TALL : WIDE;
      W = lay.W;
      s = lay.s;
      H = L.H * s;
      dpr = lay.dpr;
      M = Math.round(Math.max(L.lens[0], L.lens[1]) * s * 1.5); // room for the glass to hang over the edge
      scene.style.setProperty("--w", `${W}px`);
      scene.style.setProperty("--h", `${H}px`);
      card.style.setProperty("--radius", `${L.radius * s}px`);
      Object.assign(glass.style, { left: `${-M}px`, top: `${-M}px`, width: `${W + 2 * M}px`, height: `${H + 2 * M}px` });
      repaint();
      started = false;
      if (!raf) raf = requestAnimationFrame(frame);
    },
    set(v: PassportView, f: FinishName) {
      const fresh = view === null;
      view = v;
      finish = f;
      if (!fresh) repaint();
    },
    destroy() {
      alive = false;
      cancelAnimationFrame(raf);
      io.disconnect();
      card.removeEventListener("pointerenter", onEnter);
      card.removeEventListener("pointerleave", onLeave);
      card.removeEventListener("pointermove", onMove);
      card.removeEventListener("pointerdown", onDown);
      card.removeEventListener("pointerup", onUp);
      card.removeEventListener("pointercancel", onUp);
      card.removeEventListener("keydown", onKey);
      prog?.destroy();
    },
  };
}
