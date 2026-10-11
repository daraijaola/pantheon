// Section 01 · The Index — "Buys build the basket. Sells burn the supply."
// A live, scroll-revealed circuit drawn on canvas at 60fps. Structure (cards, paths, seats) is crisp
// and still; the moving things (fee glyphs) glide freely between pixels with easing, never snapping
// to a grid. Every number follows the real fee math: 1% per trade, half to Ascend, half to us.

export const SCENE_W = 1112;
export const SCENE_H = 480;

const SCRAMBLE = "{}[]()<>/\\|=+-*&%$#@!?;:0123456789abcdefx";
const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const clamp01 = (t: number) => Math.max(0, Math.min(1, t));
const fmt = (n: number, d = 2) => n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

type Pt = [number, number];
type Box = { x: number; y: number; w: number; h: number };

// ───────── layout (scene units = CSS px at the 1112px column) ─────────
const BUY: Box = { x: 0, y: 130, w: 210, h: 64 };
const COV: Box = { x: 300, y: 130, w: 190, h: 64 };
const ASC: Box = { x: 300, y: 290, w: 190, h: 64 };
const SELL: Box = { x: 0, y: 380, w: 210, h: 64 };
const BURN: Box = { x: 556, y: 372, w: 330, h: 80 };
const BASKET: Box = { x: 556, y: 28, w: 330, h: 268 };
const STAKE: Box = { x: 930, y: 130, w: 182, h: 64 };
const SPLIT_A: Pt = [262, 162];
const SPLIT_B: Pt = [262, 412];
const ASC_Y = ASC.y + ASC.h / 2;
const SELL_Y = SELL.y + SELL.h / 2;
const ROW0 = BASKET.y + 52;
const ROW_H = 21;
const TRUNK_IN = 524;
const TRUNK_OUT = 908;

export const SEATS = [
  ["HELIOS", 18.4],
  ["AETHER", 15.2],
  ["NYX", 12.7],
  ["ARGO", 10.1],
  ["THEMIS", 8.6],
  ["IRIS", 8.0],
  ["ORION", 7.4],
  ["ECHO", 6.9],
  ["ATLAS", 6.6],
  ["KRONOS", 6.1],
] as const;
const rowY = (i: number) => ROW0 + i * ROW_H;

// Static paths (drawn as dotted lines, revealed in order).
const PATHS: { pts: Pt[]; at: [number, number] }[] = [
  { pts: [[BUY.x + BUY.w, 162], SPLIT_A, [COV.x, 162]], at: [0.08, 0.26] },
  { pts: [SPLIT_A, [262, ASC_Y], [ASC.x, ASC_Y]], at: [0.2, 0.36] },
  { pts: [[COV.x + COV.w, 162], [TRUNK_IN, 162]], at: [0.3, 0.38] },
  { pts: [[TRUNK_IN, rowY(0)], [TRUNK_IN, rowY(9)]], at: [0.34, 0.5] },
  ...SEATS.map((_, i) => ({ pts: [[TRUNK_IN, rowY(i)], [BASKET.x, rowY(i)]] as Pt[], at: [0.38 + i * 0.012, 0.46 + i * 0.012] as [number, number] })),
  ...SEATS.map((_, i) => ({ pts: [[BASKET.x + BASKET.w, rowY(i)], [TRUNK_OUT, rowY(i)]] as Pt[], at: [0.56, 0.62] as [number, number] })),
  { pts: [[TRUNK_OUT, rowY(0)], [TRUNK_OUT, rowY(9)]], at: [0.58, 0.64] },
  { pts: [[TRUNK_OUT, 162], [STAKE.x, 162]], at: [0.6, 0.66] },
  { pts: [[SELL.x + SELL.w, SELL_Y], SPLIT_B, [BURN.x, SELL_Y]], at: [0.68, 0.86] },
  { pts: [SPLIT_B, [262, ASC_Y]], at: [0.74, 0.86] },
];

// Cards appear at these reveal points.
const CARD_AT = { buy: 0.02, cov: 0.24, asc: 0.32, basket: 0.38, stake: 0.62, sell: 0.66, burn: 0.8 };

// ───────── helpers ─────────
function polyLen(pts: Pt[]): number[] {
  const acc = [0];
  for (let i = 1; i < pts.length; i++) acc.push(acc[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return acc;
}
function pointAt(pts: Pt[], acc: number[], t: number): Pt {
  const L = acc[acc.length - 1] * t;
  let i = 1;
  while (i < acc.length - 1 && acc[i] < L) i++;
  const seg = acc[i] - acc[i - 1] || 1;
  const k = (L - acc[i - 1]) / seg;
  return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * k, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * k];
}
/** Text that decrypts: characters past `p` show as random glyphs (spaces stay). */
function decrypt(text: string, p: number): string {
  if (p >= 1) return text;
  const reveal = Math.floor(text.length * p);
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    out += i < reveal || c === " " ? c : SCRAMBLE[(Math.random() * SCRAMBLE.length) | 0];
  }
  return out;
}

// ───────── live state ─────────
type Particle = {
  pts: Pt[];
  acc: number[];
  t0: number;
  dur: number;
  glyph: string;
  trail: Pt[];
  onArrive?: () => void;
};
type Ash = { x: number; y: number; vx: number; vy: number; t0: number; life: number };
type Text = { value: string; t0: number }; // a card value that decrypts when it changes

export class FlowScene {
  reveal = 0; // 0..1 scroll-driven, only ever grows
  private parts: Particle[] = [];
  private ash: Ash[] = [];
  private nextBuy = 0;
  private nextSell = 0;
  private nextDrip = 0;
  private started = false;
  // running totals (shown with eased counters)
  private toAscend = 6104.1;
  private toBasket = 5812.4;
  private toStakers = 2018.44;
  private burned = 3481920;
  private shown = { asc: 6104.1, bas: 5812.4, stk: 2018.44, burn: 3481920 };
  private buyText: Text = { value: "", t0: 0 };
  private feeText: Text = { value: "", t0: 0 };
  private sellText: Text = { value: "", t0: 0 };
  private sellFeeText: Text = { value: "", t0: 0 };
  private seatFlash = new Array(SEATS.length).fill(-1e9);

  private family: string;
  constructor(family: string) {
    this.family = family;
  }

  private spawn(pts: Pt[], now: number, dur: number, glyph: string, onArrive?: () => void) {
    this.parts.push({ pts, acc: polyLen(pts), t0: now, dur, glyph, trail: [], onArrive });
  }

  private buy(now: number) {
    const amount = Math.round(rnd(200, 5000) * 100) / 100;
    const fee = amount * 0.01;
    this.buyText = { value: `${fmt(amount)} USDC`, t0: now };
    this.feeText = { value: `fee ${fmt(fee)}`, t0: now };
    const n = 4;
    for (let k = 0; k < n; k++) {
      const toCov = k % 2 === 0;
      const share = fee / n;
      const start: Pt = [BUY.x + BUY.w, 162];
      const path: Pt[] = toCov ? [start, SPLIT_A, [COV.x, 162]] : [start, SPLIT_A, [262, ASC_Y], [ASC.x, ASC_Y]];
      this.spawn(path, now + 300 + k * 140, toCov ? 760 : 980, "$", () => {
        if (!toCov) {
          this.toAscend += share;
          return;
        }
        // From the Covenant into a seat, weighted by the basket.
        let r = Math.random() * 100;
        let i = 0;
        while (i < SEATS.length - 1 && (r -= SEATS[i][1]) > 0) i++;
        const t = performance.now();
        this.spawn(
          [[COV.x + COV.w, 162], [TRUNK_IN, 162], [TRUNK_IN, rowY(i)], [BASKET.x, rowY(i)]],
          t + 120,
          650 + Math.abs(rowY(i) - 162) * 1.4,
          "$",
          () => {
            this.toBasket += share;
            this.seatFlash[i] = performance.now();
          },
        );
      });
    }
  }

  private sell(now: number) {
    const amount = Math.round(rnd(2000, 60000));
    const fee = amount * 0.01;
    this.sellText = { value: `${fmt(amount, 0)} PNTH`, t0: now };
    this.sellFeeText = { value: `fee ${fmt(fee, 0)}`, t0: now };
    const n = 4;
    for (let k = 0; k < n; k++) {
      const toBurn = k % 2 === 0;
      const share = fee / n;
      const start: Pt = [SELL.x + SELL.w, SELL_Y];
      const path: Pt[] = toBurn ? [start, SPLIT_B, [BURN.x, SELL_Y]] : [start, SPLIT_B, [262, ASC_Y], [ASC.x, ASC_Y]];
      this.spawn(path, now + 300 + k * 140, toBurn ? 1100 : 900, "#", () => {
        if (!toBurn) return; // Ascend's half of a sell fee stays PNTH; we only count USDC above
        this.burned += share;
        const t = performance.now();
        // The PNTH glyph dissolves where it enters the panel: scrambled fragments drift in and fade.
        for (let a = 0; a < 6; a++) {
          this.ash.push({ x: BURN.x + rnd(4, 14), y: SELL_Y + rnd(-6, 6), vx: rnd(18, 60), vy: rnd(-22, 22), t0: t, life: rnd(500, 900) });
        }
      });
    }
  }

  private drip(now: number) {
    const i = (Math.random() * SEATS.length) | 0;
    const amount = rnd(0.4, 2.4);
    this.spawn([[BASKET.x + BASKET.w, rowY(i)], [TRUNK_OUT, rowY(i)], [TRUNK_OUT, 162], [STAKE.x, 162]], now, 900 + Math.abs(rowY(i) - 162) * 1.2, "•", () => {
      this.toStakers += amount;
    });
  }

  update(now: number, dt: number, live: boolean) {
    if (live && !this.started) {
      this.started = true;
      this.nextBuy = now + 300;
      this.nextSell = now + 1700;
      this.nextDrip = now + 900;
      this.buyText = { value: "1,250.00 USDC", t0: now };
      this.feeText = { value: "fee 12.50", t0: now };
      this.sellText = { value: "18,400 PNTH", t0: now };
      this.sellFeeText = { value: "fee 184", t0: now };
    }
    if (this.started && live) {
      if (now >= this.nextBuy) {
        this.buy(now);
        this.nextBuy = now + rnd(2300, 3200);
      }
      if (now >= this.nextSell) {
        this.sell(now);
        this.nextSell = now + rnd(3000, 4200);
      }
      if (now >= this.nextDrip) {
        this.drip(now);
        this.nextDrip = now + rnd(700, 1300);
      }
    }
    // Move particles; fire arrivals.
    for (const p of this.parts) {
      const t = clamp01((now - p.t0) / p.dur);
      if (t <= 0) continue;
      const pos = pointAt(p.pts, p.acc, easeInOut(t));
      p.trail.unshift(pos);
      if (p.trail.length > 5) p.trail.pop();
      if (t >= 1 && p.onArrive) {
        const f = p.onArrive;
        p.onArrive = undefined;
        f();
      }
    }
    this.parts = this.parts.filter((p) => now - p.t0 < p.dur + 120);
    this.ash = this.ash.filter((a) => now - a.t0 < a.life);
    // Ease the counters toward their targets.
    const k = 1 - Math.exp(-dt / 220);
    this.shown.asc += (this.toAscend - this.shown.asc) * k;
    this.shown.bas += (this.toBasket - this.shown.bas) * k;
    this.shown.stk += (this.toStakers - this.shown.stk) * k;
    this.shown.burn += (this.burned - this.shown.burn) * k;
  }

  draw(ctx: CanvasRenderingContext2D, now: number, ink: string) {
    const R = this.reveal;
    const f = this.family;
    ctx.clearRect(0, 0, SCENE_W, SCENE_H);
    ctx.textBaseline = "middle";
    ctx.lineCap = "round";

    // Paths: dotted hairlines that draw themselves along their length.
    ctx.strokeStyle = ink;
    ctx.lineWidth = 1;
    ctx.setLineDash([1, 4]);
    ctx.globalAlpha = 0.32;
    for (const p of PATHS) {
      const k = clamp01((R - p.at[0]) / (p.at[1] - p.at[0]));
      if (k <= 0) continue;
      const acc = polyLen(p.pts);
      const L = acc[acc.length - 1] * easeInOut(k);
      ctx.beginPath();
      ctx.moveTo(p.pts[0][0], p.pts[0][1]);
      for (let i = 1; i < p.pts.length; i++) {
        if (acc[i] <= L) ctx.lineTo(p.pts[i][0], p.pts[i][1]);
        else {
          const [x, y] = pointAt(p.pts, acc, L / acc[acc.length - 1]);
          ctx.lineTo(x, y);
          break;
        }
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
    // Split nodes.
    for (const [pt, at] of [[SPLIT_A, 0.16], [SPLIT_B, 0.76]] as const) {
      const k = clamp01((R - at) / 0.06);
      if (!k) continue;
      ctx.globalAlpha = k;
      ctx.fillStyle = ink;
      ctx.beginPath();
      ctx.arc(pt[0], pt[1], 2.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // Cards.
    const card = (b: Box, at: number, label: string, value: string, sub: string, valueT0 = 0) => {
      const k = clamp01((R - at) / 0.08);
      if (!k) return;
      const lift = (1 - easeInOut(k)) * 8;
      ctx.globalAlpha = k;
      ctx.strokeStyle = ink;
      ctx.globalAlpha = k * 0.14;
      ctx.beginPath();
      ctx.roundRect(b.x + 0.5, b.y + 0.5 + lift, b.w - 1, b.h - 1, 10);
      ctx.stroke();
      ctx.fillStyle = ink;
      ctx.font = `500 10px ${f}`;
      ctx.globalAlpha = k * 0.5;
      ctx.fillText(decrypt(label, k * 1.4), b.x + 14, b.y + 16 + lift);
      ctx.font = `500 14px ${f}`;
      ctx.globalAlpha = k;
      const vp = valueT0 ? clamp01((now - valueT0) / 380) : 1;
      ctx.fillText(decrypt(value, Math.min(vp, k * 1.4)), b.x + 14, b.y + 36 + lift);
      ctx.font = `400 10px ${f}`;
      ctx.globalAlpha = k * 0.45;
      ctx.fillText(sub, b.x + 14, b.y + b.h - 13 + lift);
    };
    card(BUY, CARD_AT.buy, "BUY", this.buyText.value || "1,250.00 USDC", this.feeText.value || "fee 12.50", this.buyText.t0);
    card(COV, CARD_AT.cov, "COVENANT · NO OWNER", `$ ${fmt(this.shown.bas)}`, "half of each fee → basket");
    card(ASC, CARD_AT.asc, "ASCEND", `$ ${fmt(this.shown.asc)}`, "the other half");
    card(STAKE, CARD_AT.stake, "STAKERS", `$ ${fmt(this.shown.stk)}`, "basket coins, streamed");
    card(SELL, CARD_AT.sell, "SELL", this.sellText.value || "18,400 PNTH", this.sellFeeText.value || "fee 184", this.sellText.t0);
    // Burned: the counter is the hero of this panel.
    const kn = clamp01((R - CARD_AT.burn) / 0.08);
    if (kn) {
      const b = BURN;
      const lift = (1 - easeInOut(kn)) * 8;
      ctx.strokeStyle = ink;
      ctx.globalAlpha = kn * 0.14;
      ctx.beginPath();
      ctx.roundRect(b.x + 0.5, b.y + 0.5 + lift, b.w - 1, b.h - 1, 12);
      ctx.stroke();
      ctx.fillStyle = ink;
      ctx.font = `500 10px ${f}`;
      ctx.globalAlpha = kn * 0.5;
      ctx.fillText(decrypt("BURNED · GONE FOR GOOD", kn * 1.4), b.x + 16, b.y + 18 + lift);
      ctx.textAlign = "right";
      ctx.fillText(decrypt("PNTH", kn * 1.4), b.x + b.w - 16, b.y + 18 + lift);
      ctx.textAlign = "left";
      ctx.font = `500 26px ${f}`;
      ctx.globalAlpha = kn;
      ctx.fillText(decrypt(fmt(this.shown.burn, 0), kn * 1.4), b.x + 16, b.y + 52 + lift);
    }

    // Basket: a panel of 10 seats with weight bars made of characters.
    const kb = clamp01((R - CARD_AT.basket) / 0.08);
    if (kb) {
      const b = BASKET;
      ctx.strokeStyle = ink;
      ctx.globalAlpha = kb * 0.14;
      ctx.beginPath();
      ctx.roundRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1, 12);
      ctx.stroke();
      ctx.fillStyle = ink;
      ctx.font = `500 10px ${f}`;
      ctx.globalAlpha = kb * 0.5;
      ctx.fillText(decrypt("BASKET · LOCKED", kb * 1.4), b.x + 16, b.y + 22);
      ctx.textAlign = "right";
      ctx.fillText(decrypt("WEIGHT", kb * 1.4), b.x + b.w - 16, b.y + 22);
      ctx.textAlign = "left";
      SEATS.forEach(([name, w], i) => {
        const k = clamp01((R - (CARD_AT.basket + 0.02 + i * 0.012)) / 0.06);
        if (!k) return;
        const y = rowY(i);
        const flash = clamp01(1 - (now - this.seatFlash[i]) / 500);
        const bars = 14;
        const filled = Math.round((w / 20) * bars * easeInOut(k));
        ctx.font = `400 11px ${f}`;
        ctx.globalAlpha = k * 0.4;
        ctx.fillText(String(i + 1).padStart(2, "0"), b.x + 16, y);
        ctx.globalAlpha = k * (0.75 + 0.25 * flash);
        ctx.font = `${flash > 0 ? 600 : 500} 11px ${f}`;
        ctx.fillText(decrypt(name, k * 1.3), b.x + 44, y);
        ctx.font = `400 11px ${f}`;
        const bar = "#".repeat(filled) + "·".repeat(bars - filled);
        ctx.globalAlpha = k * (0.55 + 0.45 * flash);
        ctx.fillText(flash > 0.6 ? decrypt(bar, 0.85) : bar, b.x + 124, y);
        ctx.textAlign = "right";
        ctx.globalAlpha = k * 0.6;
        ctx.fillText(`${w.toFixed(1)}%`, b.x + b.w - 16, y);
        ctx.textAlign = "left";
      });
    }

    // Moving fee glyphs, each with a short fading trail.
    ctx.font = `600 13px ${f}`;
    ctx.textAlign = "center";
    ctx.fillStyle = ink;
    for (const p of this.parts) {
      p.trail.forEach(([x, y], j) => {
        ctx.globalAlpha = j === 0 ? 1 : 0.14 / j;
        ctx.fillText(p.glyph, x, y);
      });
    }
    // Burned PNTH: fragments that scramble and drift up into nothing.
    ctx.font = `500 11px ${f}`;
    for (const a of this.ash) {
      const t = (now - a.t0) / a.life;
      ctx.globalAlpha = (1 - t) * 0.8;
      ctx.fillText(SCRAMBLE[(Math.random() * SCRAMBLE.length) | 0], a.x + a.vx * t, a.y + a.vy * t * 1.4);
    }
    ctx.textAlign = "left";
    ctx.globalAlpha = 1;
  }
}
