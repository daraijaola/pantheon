// Section 01 · The Index, take 2: three small scenes, one idea each, plain words, round numbers.
// All monochrome ink on paper, drawn in Geist Mono at 60fps; motion uses easing and fades, never pops.

export const MONO = '"Geist Mono", ui-monospace, monospace';
const SCRAMBLE = "{}[]()<>/\\|=+-*&%$#@!?;:0123456789abcdefx";
const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const clamp01 = (t: number) => Math.max(0, Math.min(1, t));
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const glyph = () => SCRAMBLE[(Math.random() * SCRAMBLE.length) | 0];
const window01 = (t: number, a: number, b: number) => clamp01((t - a) / (b - a));

export interface Scene {
  draw(ctx: CanvasRenderingContext2D, now: number): void;
}

// ───────────────────────── 1. Every trade pays 1% ─────────────────────────
// A $100 trade as a 10×10 grid of dots (one square = $1). One square lifts out and splits in two.
export class SplitScene implements Scene {
  private cycle = 4600;
  private t0 = performance.now();
  private pick = 55;
  private w: number;
  private h: number;
  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
  }

  draw(ctx: CanvasRenderingContext2D, now: number) {
    const { w, h } = this;
    let t = now - this.t0;
    if (t > this.cycle) {
      this.t0 = now;
      t = 0;
      this.pick = (Math.random() * 100) | 0;
    }
    ctx.clearRect(0, 0, w, h);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const gx = 22;
    const gy = 44;
    const step = 13;
    const pr = (this.pick / 10) | 0;
    const pc = this.pick % 10;
    const cellX = gx + pc * step;
    const cellY = gy + pr * step;

    ctx.fillStyle = "#171717";
    ctx.font = `500 10px ${MONO}`;
    ctx.textAlign = "left";
    ctx.globalAlpha = 0.45;
    ctx.fillText("A $100 TRADE", gx - 4, 22);
    ctx.fillText("1 square = $1", gx - 4, gy + 10 * step + 10);
    ctx.textAlign = "center";

    // The grid.
    ctx.font = `400 12px ${MONO}`;
    const lift = window01(t, 900, 1700);
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 10; c++) {
        const isFee = r === pr && c === pc;
        if (isFee && lift > 0) continue;
        ctx.globalAlpha = isFee ? 0.35 + 0.65 * window01(t, 300, 700) : 0.35;
        ctx.fillText(isFee && t > 300 ? (t < 700 ? glyph() : "■") : "·", gx + c * step, gy + r * step);
      }
    }

    // The fee square: lifts to the split point, then becomes two halves.
    const splitX = gx + 10 * step + 34;
    const splitY = gy + 4.5 * step;
    const aY = splitY - 36;
    const bY = splitY + 36;
    const labelX = splitX + 34;
    const fade = 1 - window01(t, this.cycle - 700, this.cycle);
    if (lift > 0 && t < 2300) {
      const k = easeInOut(lift);
      ctx.globalAlpha = 1;
      ctx.font = `600 12px ${MONO}`;
      ctx.fillText("■", cellX + (splitX - cellX) * k, cellY + (splitY - cellY) * k);
    }
    const split = window01(t, 1700, 2500);
    if (split > 0) {
      const k = easeInOut(split);
      ctx.font = `600 12px ${MONO}`;
      ctx.globalAlpha = fade;
      ctx.fillText("▪", splitX + (labelX - 12 - splitX) * k, splitY + (aY - splitY) * k);
      ctx.fillText("▪", splitX + (labelX - 12 - splitX) * k, splitY + (bY - splitY) * k);
      // Guide lines.
      ctx.strokeStyle = "#171717";
      ctx.setLineDash([1, 4]);
      ctx.lineCap = "round";
      ctx.globalAlpha = 0.3 * fade * window01(t, 1500, 1900);
      ctx.beginPath();
      ctx.moveTo(splitX, splitY);
      ctx.lineTo(splitX, aY);
      ctx.lineTo(labelX - 20, aY);
      ctx.moveTo(splitX, splitY);
      ctx.lineTo(splitX, bY);
      ctx.lineTo(labelX - 20, bY);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // Labels.
    const show = window01(t, 2300, 2700) * fade;
    if (show > 0) {
      ctx.textAlign = "left";
      ctx.font = `500 10px ${MONO}`;
      ctx.globalAlpha = show * 0.5;
      ctx.fillText("ASCEND", labelX, aY - 9);
      ctx.fillText("PANTHEON", labelX, bY - 9);
      ctx.font = `500 15px ${MONO}`;
      ctx.globalAlpha = show * 0.55;
      ctx.fillText(show < 1 ? scrambleTo("50¢", show) : "50¢", labelX, aY + 8);
      ctx.globalAlpha = show;
      ctx.fillText(show < 1 ? scrambleTo("50¢", show) : "50¢", labelX, bY + 8);
      ctx.textAlign = "center";
    }
    ctx.globalAlpha = 1;
  }
}

function scrambleTo(text: string, p: number) {
  const reveal = Math.floor(text.length * p);
  let out = "";
  for (let i = 0; i < text.length; i++) out += i < reveal ? text[i] : glyph();
  return out;
}

// ───────────────────────── 2. Buys fill the basket ─────────────────────────
// Ten numbered slots. Coins fall in and stack; the oldest drip out to the stakers.
type Coin = { col: number; t0: number; dur: number };
type Drip = { col: number; t0: number };
export class BasketScene implements Scene {
  private stacks = [5, 4, 4, 3, 3, 3, 2, 2, 2, 2];
  private weights = [18, 15, 13, 10, 9, 8, 7, 7, 7, 6];
  private coins: Coin[] = [];
  private drips: Drip[] = [];
  private nextCoin = performance.now() + 400;
  private nextDrip = performance.now() + 1600;
  private landed = new Array(10).fill(-1e9);
  private w: number;
  private h: number;
  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
  }

  draw(ctx: CanvasRenderingContext2D, now: number) {
    const { w, h } = this;
    ctx.clearRect(0, 0, w, h);
    const left = 34;
    const colW = 22;
    const base = h - 62;
    const rowH = 12.5;
    const top = 26;
    const colX = (c: number) => left + c * colW;

    // Spawn: one coin at a time, into a slot weighted like the basket.
    if (now >= this.nextCoin) {
      let r = Math.random() * 100;
      let c = 0;
      while (c < 9 && (r -= this.weights[c]) > 0) c++;
      this.coins.push({ col: c, t0: now, dur: 650 + (base - this.stacks[c] * rowH - top) * 2.2 });
      this.nextCoin = now + rnd(520, 780);
    }
    if (now >= this.nextDrip) {
      const tall = this.stacks.map((s, i) => [s, i]).sort((a, b) => b[0] - a[0]);
      const c = tall[(Math.random() * 3) | 0][1];
      if (this.stacks[c] > 2) {
        this.stacks[c]--;
        this.drips.push({ col: c, t0: now });
      }
      this.nextDrip = now + rnd(700, 1100);
    }

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#171717";

    // Labels.
    ctx.font = `500 10px ${MONO}`;
    ctx.textAlign = "left";
    ctx.globalAlpha = 0.45;
    ctx.fillText("FROM BUYS", left - 12, 14);
    ctx.fillText("THE BASKET · 10 BEST COINS", left - 12, h - 14);
    ctx.textAlign = "right";
    ctx.fillText("STAKERS", w - 4, base + 2);
    ctx.textAlign = "center";

    // Basket outline: a bracket around the slots.
    ctx.strokeStyle = "#171717";
    ctx.globalAlpha = 0.2;
    ctx.beginPath();
    ctx.moveTo(left - 12, base - 92);
    ctx.lineTo(left - 12, base + 12);
    ctx.lineTo(colX(9) + 12, base + 12);
    ctx.lineTo(colX(9) + 12, base - 92);
    ctx.stroke();

    // Stacks.
    ctx.font = `500 12px ${MONO}`;
    for (let c = 0; c < 10; c++) {
      const flash = clamp01(1 - (now - this.landed[c]) / 400);
      for (let k = 0; k < this.stacks[c]; k++) {
        const isTop = k === this.stacks[c] - 1;
        ctx.globalAlpha = 0.55 + (isTop ? 0.45 * flash : 0) + k * 0.02;
        ctx.fillText(isTop && flash > 0.6 ? glyph() : "$", colX(c), base - k * rowH);
      }
      ctx.font = `400 9px ${MONO}`;
      ctx.globalAlpha = 0.35;
      ctx.fillText(String(c + 1).padStart(2, "0"), colX(c), base + 26);
      ctx.font = `500 12px ${MONO}`;
    }

    // Falling coins.
    ctx.font = `600 12px ${MONO}`;
    this.coins = this.coins.filter((coin) => {
      const k = clamp01((now - coin.t0) / coin.dur);
      const y = top + (base - this.stacks[coin.col] * rowH - top) * (k * k); // gravity-ish
      ctx.globalAlpha = Math.min(1, k * 4);
      ctx.fillText("$", colX(coin.col), y);
      if (k >= 1) {
        this.stacks[coin.col] = Math.min(8, this.stacks[coin.col] + 1);
        this.landed[coin.col] = now;
        return false;
      }
      return true;
    });

    // Drips to the stakers: a dot slides out along the base line.
    ctx.font = `600 12px ${MONO}`;
    this.drips = this.drips.filter((d) => {
      const k = clamp01((now - d.t0) / 1100);
      const x0 = colX(d.col);
      const x1 = w - 62;
      ctx.globalAlpha = (1 - k) * 0.9;
      ctx.fillText("•", x0 + (x1 - x0) * easeOut(k), base + 2);
      return k < 1;
    });
    ctx.globalAlpha = 1;
  }
}

// ───────────────────────── 3. Sells burn PNTH ─────────────────────────
// A big "P" in the hero's code type. With every sell a few of its pixels break off,
// scramble and vanish. It visibly shrinks; the loop rebuilds it after a pause.
const P = ["######.", "#######", "##...##", "##...##", "#######", "######.", "##.....", "##.....", "##.....", "##....."];
type Px = { x: number; y: number; alive: boolean; burnT: number; vx: number; vy: number };
export class BurnScene implements Scene {
  private px: Px[] = [];
  private t0 = performance.now();
  private cycle = 7000;
  private burns = [1200, 2300, 3400, 4500];
  private fired = 0;
  private w: number;
  private h: number;
  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.reset();
  }

  private reset() {
    this.px = [];
    P.forEach((row, y) => [...row].forEach((c, x) => c === "#" && this.px.push({ x, y, alive: true, burnT: 0, vx: 0, vy: 0 })));
    this.fired = 0;
  }

  draw(ctx: CanvasRenderingContext2D, now: number) {
    const { w, h } = this;
    let t = now - this.t0;
    if (t > this.cycle) {
      this.t0 = now;
      t = 0;
      this.reset();
    }
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#171717";
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.font = `500 10px ${MONO}`;
    ctx.globalAlpha = 0.45;
    ctx.fillText("FROM SELLS", 12, 14);
    ctx.fillText("PNTH SUPPLY", 12, h - 14);

    // Each sell burns a cluster of pixels from the outside in.
    while (this.fired < this.burns.length && t >= this.burns[this.fired]) {
      const alive = this.px.filter((p) => p.alive);
      alive.sort((a, b) => b.x + b.y * 0.3 - (a.x + a.y * 0.3) + rnd(-2, 2));
      for (const p of alive.slice(0, 4)) {
        p.alive = false;
        p.burnT = now;
        p.vx = rnd(10, 40);
        p.vy = rnd(-50, -20);
      }
      this.fired++;
    }

    const mod = 13;
    const ox = (w - 7 * mod) / 2;
    const oy = (h - 10 * mod) / 2 + 2;
    const appear = window01(t, 0, 700);
    const fade = 1 - window01(t, this.cycle - 900, this.cycle - 200);
    ctx.textAlign = "center";
    for (const p of this.px) {
      const x = ox + p.x * mod;
      const y = oy + p.y * mod;
      if (p.alive) {
        const a = appear * fade;
        if (a <= 0) continue;
        // Ink block with a code character knocked out, like the hero heading.
        ctx.globalAlpha = a;
        ctx.fillRect(x, y, mod + 0.5, mod + 0.5);
        ctx.fillStyle = "#f9f9f9";
        ctx.font = `500 9px ${MONO}`;
        ctx.globalAlpha = a * 0.55;
        ctx.fillText(appear < 1 ? glyph() : "01PNTH"[(p.x + p.y) % 6], x + mod / 2, y + mod / 2);
        ctx.fillStyle = "#171717";
      } else {
        const k = clamp01((now - p.burnT) / 900);
        if (k >= 1) continue;
        ctx.font = `500 11px ${MONO}`;
        ctx.globalAlpha = (1 - k) * 0.9;
        ctx.fillText(glyph(), x + mod / 2 + p.vx * k, y + mod / 2 + p.vy * easeOut(k));
      }
    }
    ctx.globalAlpha = 1;
  }
}
