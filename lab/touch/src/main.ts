import "./style.css";
import { ADAM, GOD, placeHand } from "./model";
import { rasterise, type HandImage } from "./raster";
import { buildAtlas, toAscii, type Atlas } from "./ascii";

// ───────────────────────── parameters (every one is a slider in the panel) ─────────────────────────
const P = {
  view: "ascii",
  style: "outline",
  edgeMode: "orient",
  phase: 0.5, // where in the breathing loop the still preview sits
  cols: 288,
  sceneH: 380,
  cw: 8,
  scale: 2.9,
  adamAngle: -16,
  godAngle: 7,
  centerY: 160,
  adamDy: 6,
  gap: 18,
  breath: 22,
  sway: 1.2,
  blend: 6,
  crease: 5,
  edgeW: 0,
  fadeIn: 0.03, // arms fade to nothing over this share of the width at each edge
  fadeOut: 0.24,
  lx: -0.4,
  ly: -0.65,
  lz: 0.65,
  minEdge: 2,
  minScore: 0.2,
  minCover: 0.5,
  gamma: 1.8,
  edgeSet: "-_¯|/\\()",
  adamFill: "  ..::-",
  godFill: " .:10",
  fillAlpha: 0.5,
  adamRamp: " .:-=+*#%@",
  godRamp: " .:-=+10#$",
  floor: 0.28,
  // playback + glitch (God's hand only)
  frames: 36,
  loopS: 7,
  // calm state
  scramble: 0.004,
  flip: 0.05,
  echoX: 1.5,
  echoA: 0.12,
  // bursts
  burstMin: 2.5,
  burstMax: 5,
  burstLen: 0.45,
  burstScramble: 0.09,
  sliceRate: 0.6,
  burstEchoX: 4,
  burstEchoA: 0.24,
};
type Key = keyof typeof P;

const SPECS: (
  | { h: string }
  | { k: Key; min: number; max: number; step: number }
  | { k: Key; options: string[] }
  | { k: Key; text: true }
)[] = [
  { h: "view" },
  { k: "view", options: ["shade", "edges", "ascii", "final"] },
  { k: "phase", min: 0, max: 1, step: 0.01 },
  { k: "style", options: ["outline", "density", "hybrid"] },
  { k: "edgeMode", options: ["orient", "match"] },
  { h: "grid" },
  { k: "cols", min: 180, max: 400, step: 4 },
  { k: "sceneH", min: 240, max: 480, step: 10 },
  { k: "cw", min: 4, max: 12, step: 1 },
  { h: "pose" },
  { k: "scale", min: 1.5, max: 3.6, step: 0.05 },
  { k: "adamAngle", min: -40, max: 10, step: 0.5 },
  { k: "godAngle", min: -15, max: 30, step: 0.5 },
  { k: "centerY", min: 80, max: 320, step: 2 },
  { k: "adamDy", min: -40, max: 40, step: 1 },
  { k: "gap", min: 0, max: 80, step: 1 },
  { k: "breath", min: 0, max: 60, step: 1 },
  { k: "sway", min: 0, max: 4, step: 0.1 },
  { h: "surface" },
  { k: "blend", min: 0, max: 24, step: 0.5 },
  { k: "crease", min: 1, max: 20, step: 0.5 },
  { k: "edgeW", min: 0, max: 4, step: 1 },
  { k: "fadeIn", min: 0, max: 0.5, step: 0.01 },
  { k: "fadeOut", min: 0, max: 0.6, step: 0.01 },
  { k: "lx", min: -1, max: 1, step: 0.05 },
  { k: "ly", min: -1, max: 1, step: 0.05 },
  { k: "lz", min: 0.1, max: 1.5, step: 0.05 },
  { h: "characters" },
  { k: "minEdge", min: 1, max: 16, step: 1 },
  { k: "minScore", min: 0, max: 0.9, step: 0.01 },
  { k: "minCover", min: 0.1, max: 0.95, step: 0.05 },
  { k: "gamma", min: 0.5, max: 3, step: 0.05 },
  { k: "edgeSet", text: true },
  { k: "adamFill", text: true },
  { k: "godFill", text: true },
  { k: "fillAlpha", min: 0.1, max: 1, step: 0.05 },
  { k: "adamRamp", text: true },
  { k: "godRamp", text: true },
  { k: "floor", min: 0, max: 0.8, step: 0.01 },
  { h: "motion + glitch" },
  { k: "frames", min: 8, max: 96, step: 4 },
  { k: "loopS", min: 2, max: 14, step: 0.5 },
  { k: "scramble", min: 0, max: 0.1, step: 0.001 },
  { k: "flip", min: 0, max: 0.5, step: 0.01 },
  { k: "echoX", min: 0, max: 6, step: 0.5 },
  { k: "echoA", min: 0, max: 0.5, step: 0.01 },
  { k: "burstMin", min: 0.5, max: 8, step: 0.5 },
  { k: "burstMax", min: 1, max: 12, step: 0.5 },
  { k: "burstLen", min: 0.1, max: 1.5, step: 0.05 },
  { k: "burstScramble", min: 0, max: 0.4, step: 0.01 },
  { k: "sliceRate", min: 0, max: 1, step: 0.05 },
  { k: "burstEchoX", min: 0, max: 10, step: 0.5 },
  { k: "burstEchoA", min: 0, max: 0.6, step: 0.01 },
];

// ───────────────────────── panel ─────────────────────────
const panel = document.querySelector<HTMLElement>("#panel")!;
for (const s of SPECS) {
  if ("h" in s) {
    const h = document.createElement("h3");
    h.textContent = s.h;
    panel.append(h);
    continue;
  }
  const label = document.createElement("label");
  label.append(Object.assign(document.createElement("span"), { textContent: s.k }));
  if ("options" in s) {
    const sel = document.createElement("select");
    for (const o of s.options) sel.append(new Option(o, o, false, P[s.k] === o));
    sel.onchange = () => set(s.k, sel.value);
    label.append(sel);
  } else if ("text" in s) {
    const inp = Object.assign(document.createElement("input"), { type: "text", value: String(P[s.k]) });
    inp.onchange = () => set(s.k, inp.value);
    label.append(inp);
  } else {
    const inp = Object.assign(document.createElement("input"), {
      type: "range",
      min: String(s.min),
      max: String(s.max),
      step: String(s.step),
      value: String(P[s.k]),
    });
    const out = document.createElement("output");
    out.textContent = String(P[s.k]);
    inp.oninput = () => {
      out.textContent = inp.value;
      set(s.k, Number(inp.value));
    };
    label.append(inp, out);
  }
  panel.append(label);
}
const btn = (text: string, fn: () => void, ghost = false) => {
  const b = Object.assign(document.createElement("button"), { textContent: text, onclick: fn });
  if (ghost) b.className = "ghost";
  panel.append(b);
};
btn("Bake + play", () => bake().then(() => set("view", "final")));
btn("Save frames", () => save(), true);
btn("Copy params", () => navigator.clipboard.writeText(JSON.stringify(P, null, 2)), true);

function set(k: Key, v: string | number) {
  (P as Record<Key, string | number>)[k] = v;
  if (k !== "view" || v !== "final") baked = null;
  schedule();
}

// ───────────────────────── geometry of the grid ─────────────────────────
const SCENE_W = 1112;
const FAMILY = '"Geist Mono", monospace';
const canvas = document.querySelector<HTMLCanvasElement>("#view")!;
const status = document.querySelector<HTMLElement>("#status")!;
let ctx = canvas.getContext("2d")!;
let adv = 0.6;

function grid() {
  const charW = SCENE_W / P.cols;
  const fontPx = charW / adv;
  const lineH = fontPx * 1.17;
  const rows = Math.floor(P.sceneH / lineH);
  const cw = P.cw;
  const ch = Math.round((cw * lineH) / charW);
  return { charW, fontPx, lineH, rows, cols: P.cols, cw, ch, sx: cw / charW, sy: ch / lineH };
}

function fit(w: number, h: number) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// ───────────────────────── one frame of the scene ─────────────────────────
type Layer = { edge: string; fill: string };
type Frame = { adam: Layer; god: Layer };

function renderImages(phase: number) {
  const g = grid();
  const breath = 0.5 + 0.5 * Math.sin(2 * Math.PI * phase);
  const sway = Math.sin(2 * Math.PI * phase + 1.1);
  const gap = P.gap + P.breath * breath;
  const cx = SCENE_W / 2;
  const light = (() => {
    const m = Math.hypot(P.lx, P.ly, P.lz);
    return [P.lx / m, P.ly / m, P.lz / m] as [number, number, number];
  })();
  const opts = { w: g.cols * g.cw, h: g.rows * g.ch, sx: g.sx, sy: g.sy, blend: P.blend, crease: P.crease, edgeW: P.edgeW, light };
  const adam = rasterise(
    placeHand(ADAM, { scale: P.scale, angle: P.adamAngle + sway * P.sway, mirror: false, tipX: cx - gap / 2, tipY: P.centerY + P.adamDy }),
    opts,
  );
  const god = rasterise(
    placeHand(GOD, { scale: P.scale, angle: P.godAngle - sway * P.sway * 0.5, mirror: true, tipX: cx + gap / 2, tipY: P.centerY }),
    opts,
  );
  return { g, adam, god };
}

let atlas: { key: string; a: Atlas } | null = null;
function getAtlas(cw: number, ch: number): Atlas {
  const key = `${P.edgeSet}|${cw}|${ch}`;
  if (!atlas || atlas.key !== key) atlas = { key, a: buildAtlas(P.edgeSet, cw, ch, FAMILY, 400) };
  return atlas.a;
}

function asciiFrame(phase: number): { g: ReturnType<typeof grid>; frame: Frame } {
  const { g, adam, god } = renderImages(phase);
  const a = getAtlas(g.cw, g.ch);
  const base = { cols: g.cols, rows: g.rows, minEdge: P.minEdge, minScore: P.minScore, minCover: P.minCover, gamma: P.gamma, style: P.style, floor: P.floor, edgeMode: P.edgeMode };
  return {
    g,
    frame: {
      adam: toAscii(adam, a, { ...base, fill: P.adamFill, ramp: P.adamRamp }),
      god: toAscii(god, a, { ...base, fill: P.godFill, ramp: P.godRamp }),
    },
  };
}

// ───────────────────────── drawing ─────────────────────────
function drawImage(g: ReturnType<typeof grid>, imgs: HandImage[], mode: "shade" | "edges") {
  const w = g.cols * g.cw;
  const h = g.rows * g.ch;
  const off = new OffscreenCanvas(w, h);
  const o = off.getContext("2d")!;
  const data = o.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    let v = 249;
    for (const img of imgs) {
      if (img.height[i] === -Infinity) continue;
      v = mode === "shade" ? Math.round(235 - 200 * img.shade[i]) : img.edge[i] ? 23 : Math.min(v, 236);
    }
    data.data[i * 4] = data.data[i * 4 + 1] = data.data[i * 4 + 2] = v;
    data.data[i * 4 + 3] = 255;
  }
  o.putImageData(data, 0, 0);
  fit(SCENE_W, g.rows * g.lineH);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(off, 0, 0, SCENE_W, g.rows * g.lineH);
}

// The arms fade out toward the frame edges so the eye goes to the fingertips.
function fade(col: number, cols: number): number {
  const x = Math.min(col, cols - 1 - col) / cols; // 0 at the edge, 0.5 at the centre
  if (x <= P.fadeIn) return 0;
  if (x >= P.fadeOut) return 1;
  const t = (x - P.fadeIn) / (P.fadeOut - P.fadeIn);
  return t * t * (3 - 2 * t);
}

function drawText(g: ReturnType<typeof grid>, text: string, alpha: number, dx = 0) {
  const lines = text.split("\n");
  for (let r = 0; r < lines.length; r++) {
    const line = lines[r];
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      if (ch === " ") continue;
      const a = alpha * fade(c, line.length);
      if (a < 0.02) continue;
      ctx.globalAlpha = a;
      ctx.fillText(ch, (c + 0.5) * g.charW + dx, (r + 0.5) * g.lineH);
    }
  }
  ctx.globalAlpha = 1;
}

function beginText(g: ReturnType<typeof grid>) {
  fit(SCENE_W, g.rows * g.lineH);
  ctx.clearRect(0, 0, SCENE_W, g.rows * g.lineH);
  ctx.font = `400 ${g.fontPx}px ${FAMILY}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#171717";
}

function drawFrame(g: ReturnType<typeof grid>, f: Frame, glitch: Glitch | null) {
  beginText(g);
  if (glitch) {
    // God first (with echo), then Adam on top. Bursts push the echo further and make it stronger.
    const echoX = (glitch.burst ? P.burstEchoX : P.echoX) * g.charW;
    const echoA = glitch.burst ? P.burstEchoA : P.echoA;
    for (const [dx, a] of [[echoX, echoA], [0, 1]] as const) {
      if (a <= 0) continue;
      drawShifted(g, f.god.fill, a * P.fillAlpha, dx, glitch);
      drawShifted(g, f.god.edge, a, dx, glitch);
    }
  } else {
    drawText(g, f.god.fill, P.fillAlpha);
    drawText(g, f.god.edge, 1);
  }
  drawText(g, f.adam.fill, P.fillAlpha);
  drawText(g, f.adam.edge, 1);
}

// ───────────────────────── glitch (God's hand only) ─────────────────────────
type Slice = { r0: number; n: number; shift: number; until: number; drop: boolean };
type Glitch = { slices: Slice[]; now: number; burst: boolean };
const SCRAMBLE = "{}[]()<>/\\|=+-*&%$#@!?;:0123456789abcdefx";

function drawShifted(g: ReturnType<typeof grid>, text: string, alpha: number, dx: number, gl: Glitch) {
  const lines = text.split("\n");
  for (let r = 0; r < lines.length; r++) {
    const sl = gl.slices.find((s) => r >= s.r0 && r < s.r0 + s.n);
    const line = lines[r];
    for (let c = 0; c < line.length; c++) {
      const src = sl ? c - sl.shift : c;
      if (src < 0 || src >= line.length) continue;
      let ch = line[src];
      if (ch === " " || (sl?.drop && Math.random() < 0.3)) continue;
      if (ch === "0" || ch === "1") {
        if (Math.random() < P.flip) ch = ch === "0" ? "1" : "0";
      }
      if (Math.random() < (gl.burst ? P.burstScramble : P.scramble)) ch = SCRAMBLE[(Math.random() * SCRAMBLE.length) | 0];
      const a = alpha * fade(c, line.length);
      if (a < 0.02) continue;
      ctx.globalAlpha = a;
      ctx.fillText(ch, (c + 0.5) * g.charW + dx, (r + 0.5) * g.lineH);
    }
  }
  ctx.globalAlpha = 1;
}

// ───────────────────────── bake, play, save ─────────────────────────
let baked: { g: ReturnType<typeof grid>; frames: Frame[] } | null = null;

async function bake() {
  const frames: Frame[] = [];
  let g = grid();
  const t0 = performance.now();
  for (let i = 0; i < P.frames; i++) {
    const r = asciiFrame(i / P.frames);
    g = r.g;
    frames.push(r.frame);
    status.textContent = `baking ${i + 1}/${P.frames}…`;
    await new Promise((res) => setTimeout(res, 0));
  }
  baked = { g, frames };
  status.textContent = `baked ${frames.length} frames in ${Math.round(performance.now() - t0)} ms`;
}

async function save() {
  if (!baked) await bake();
  const b = baked!;
  const payload = {
    cols: b.g.cols,
    rows: b.g.rows,
    loopMs: P.loopS * 1000,
    params: P,
    frames: b.frames.map((f) => ({ ae: f.adam.edge, af: f.adam.fill, ge: f.god.edge, gf: f.god.fill })),
  };
  const res = await fetch("/__save?name=touch-frames.json", { method: "POST", body: JSON.stringify(payload) });
  status.textContent = `saved: ${JSON.stringify(await res.json())}`;
}

let slices: Slice[] = [];
let burstAt = 0;
let burstUntil = 0;
let playStart = performance.now();
let lastTick = 0;
let playToken = 0;
function startPlay() {
  const token = ++playToken;
  playStart = performance.now();
  const loop = (now: number) => {
    if (token !== playToken) return;
    play(now);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
function play(now: number) {
  if (P.view !== "final" || !baked) return;
  if (now - lastTick < 1000 / 15) return;
  lastTick = now;
  const n = baked.frames.length;
  const idx = Math.floor((((now - playStart) / (P.loopS * 1000)) % 1) * n);
  slices = slices.filter((s) => s.until > now);
  // Calm most of the time; a short burst every few seconds.
  if (now >= burstAt) {
    burstUntil = now + P.burstLen * 1000;
    burstAt = now + (P.burstMin + Math.random() * (P.burstMax - P.burstMin)) * 1000;
  }
  const burst = now < burstUntil;
  if (burst && Math.random() < P.sliceRate) {
    slices.push({
      r0: (Math.random() * baked.g.rows) | 0,
      n: 1 + ((Math.random() * 4) | 0),
      shift: (Math.random() < 0.5 ? -1 : 1) * (2 + ((Math.random() * 8) | 0)),
      until: now + 70 + Math.random() * 190,
      drop: Math.random() < 0.25,
    });
  }
  drawFrame(baked.g, baked.frames[idx], { slices, now, burst });
}

// ───────────────────────── render on change ─────────────────────────
let pending = 0;
function schedule() {
  cancelAnimationFrame(pending);
  pending = requestAnimationFrame(async () => {
    const t0 = performance.now();
    if (P.view === "final") {
      if (!baked) await bake();
      startPlay();
      return;
    }
    if (P.view === "shade" || P.view === "edges") {
      const { g, adam, god } = renderImages(P.phase);
      drawImage(g, [god, adam], P.view);
      status.textContent = `${P.view} · ${g.cols}×${g.rows} cells · raster ${g.cols * g.cw}×${g.rows * g.ch} · ${Math.round(performance.now() - t0)} ms`;
      return;
    }
    const { g, frame } = asciiFrame(P.phase);
    drawFrame(g, frame, null);
    status.textContent = `ascii · ${g.cols}×${g.rows} cells · font ${g.fontPx.toFixed(2)}px · ${Math.round(performance.now() - t0)} ms`;
  });
}

document.fonts.load(`400 16px ${FAMILY}`).then(() => {
  const m = document.createElement("canvas").getContext("2d")!;
  m.font = `400 100px ${FAMILY}`;
  adv = m.measureText("M").width / 100;
  schedule();
});

// Let the browser tool drive the lab: window.lab.set("scale", 2.8), window.lab.P, window.lab.bake()
Object.assign(window, { lab: { P, set, bake, save } });
