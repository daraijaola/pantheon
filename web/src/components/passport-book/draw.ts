// Drawing kit shared by the card and the stamps page: the two finishes, fonts, and the passport's
// fine print (guilloche, microtext). Everything is drawn in design units and scaled by the caller.

export type RGB = [number, number, number];
export type FinishName = "ink" | "paper";
export type Finish = {
  top: string;
  bottom: string;
  fg: RGB;
  text: number;
  label: number;
  line: number;
  guil: number;
  wave: number;
  micro: number;
  band: number;
  photo: string;
  photo2: string;
  dot: number;
  photoRule: number;
  sealFill: string;
  chip: number;
  dark: number;
};

export const FINISH: Record<FinishName, Finish> = {
  ink: {
    top: "#1b1b1b", bottom: "#0d0d0d",
    fg: [255, 255, 255], text: 0.94, label: 0.44, line: 0.1, guil: 0.05, wave: 0.028, micro: 0.22, band: 0.028,
    photo: "#1f1f1f", photo2: "#141414", dot: 0.94, photoRule: 0.14, sealFill: "rgba(255,255,255,0.05)", chip: 0.24, dark: 1,
  },
  paper: {
    top: "#fdfdfc", bottom: "#f1f1ee",
    fg: [20, 20, 20], text: 0.94, label: 0.5, line: 0.12, guil: 0.045, wave: 0.03, micro: 0.26, band: 0.03,
    photo: "#f0f0ed", photo2: "#e4e4e0", dot: 0.86, photoRule: 0.16, sealFill: "rgba(20,20,20,0.035)", chip: 0.26, dark: 0,
  },
};
/** The site's paper (globals.css --color-paper), seen through the glass past the card's edge. */
export const PAGE: RGB = [249, 249, 249];

export const rgba = (c: RGB, a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
export const smooth = (a: number, b: number, v: number) => {
  const x = clamp((v - a) / (b - a), 0, 1);
  return x * x * (3 - 2 * x);
};

/** The Geist faces the layout loads through next/font, by the family names it generated. */
export type Fonts = { sans: string; mono: string };
export function readFonts(): Fonts {
  const css = getComputedStyle(document.documentElement);
  const sans = css.getPropertyValue("--font-geist-sans").trim();
  const mono = css.getPropertyValue("--font-geist-mono").trim();
  return { sans: sans ? `${sans}, sans-serif` : "Geist, sans-serif", mono: mono ? `${mono}, monospace` : '"Geist Mono", monospace' };
}
export function loadFonts(f: Fonts) {
  return Promise.all(
    [`500 12px ${f.sans}`, `600 12px ${f.sans}`, `400 12px ${f.sans}`, `500 12px ${f.mono}`, `400 12px ${f.mono}`].map((q) => document.fonts.load(q)),
  ).catch(() => []);
}

export function rrect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Text with letter spacing (canvas letterSpacing isn't everywhere yet). Returns its width. */
export function spaced(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, sp: number, align: "left" | "right" | "center" = "left") {
  let w = 0;
  for (const ch of text) w += ctx.measureText(ch).width + sp;
  w -= sp;
  let cx = align === "right" ? x - w : align === "center" ? x - w / 2 : x;
  for (const ch of text) {
    ctx.fillText(ch, cx, y);
    cx += ctx.measureText(ch).width + sp;
  }
  return w;
}

// Lines drawn solid on a layer of their own, then laid down at one strength: where they cross they
// stay one faint line instead of piling up into dark knots.
let layerCanvas: HTMLCanvasElement | null = null;
export function layer(ctx: CanvasRenderingContext2D, alpha: number, drawFn: (o: CanvasRenderingContext2D) => void) {
  const c = ctx.canvas;
  const off = layerCanvas ?? (layerCanvas = document.createElement("canvas"));
  if (off.width !== c.width || off.height !== c.height) {
    off.width = c.width;
    off.height = c.height;
  }
  const o = off.getContext("2d");
  if (!o) return;
  o.setTransform(1, 0, 0, 1, 0, 0);
  o.clearRect(0, 0, off.width, off.height);
  o.setTransform(ctx.getTransform());
  drawFn(o);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = alpha;
  ctx.drawImage(off, 0, 0);
  ctx.restore();
}

/** Long fine waves across a page, like banknote paper. */
export function waves(ctx: CanvasRenderingContext2D, F: Finish, W: number, H: number, count: number, alpha: number) {
  layer(ctx, alpha, (o) => {
    o.lineWidth = 0.42;
    o.strokeStyle = rgba(F.fg, 1);
    for (let j = 0; j < count; j++) {
      o.beginPath();
      const y0 = (j / (count - 1)) * H;
      for (let x = -4; x <= W + 4; x += 4) {
        const y = y0 + 7 * Math.sin(x / 46 + j * 0.42) + 3 * Math.sin(x / 13.5 - j * 1.1);
        if (x === -4) o.moveTo(x, y);
        else o.lineTo(x, y);
      }
      o.stroke();
    }
  });
}

/** A rosette of fine looping lines. */
export function rosette(ctx: CanvasRenderingContext2D, F: Finish, cx: number, cy: number, R: number) {
  layer(ctx, F.guil, (o) => {
    o.lineWidth = 0.42;
    o.strokeStyle = rgba(F.fg, 1);
    for (let k = 0; k < 40; k++) {
      o.beginPath();
      const ph = (k / 40) * Math.PI * 2;
      for (let i = 0; i <= 900; i++) {
        const t = (i / 900) * Math.PI * 2;
        const r = R * (0.66 + 0.13 * Math.sin(9 * t + ph * 0.5) + 0.05 * Math.sin(22 * t - ph));
        const x = cx + r * Math.cos(t), y = cy + r * Math.sin(t) * 0.92;
        if (i) o.lineTo(x, y);
        else o.moveTo(x, y);
      }
      o.stroke();
    }
  });
}

/** Tiny text all round the edge: you only read it through the glass. */
export function microtext(ctx: CanvasRenderingContext2D, F: Finish, fonts: Fonts, run: string, W: number, H: number, inset: number, radius: number) {
  ctx.save();
  ctx.font = `500 4.6px ${fonts.mono}`;
  ctx.fillStyle = rgba(F.fg, F.micro);
  ctx.textBaseline = "middle";
  const along = (len: number, draw: (s: string) => void) => {
    let s = "";
    while (ctx.measureText(s).width < len) s += run;
    let lo = 0, hi = s.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ctx.measureText(s.slice(0, mid)).width <= len) lo = mid;
      else hi = mid - 1;
    }
    draw(s.slice(0, lo));
  };
  const x0 = radius, x1 = W - radius, y0 = radius, y1 = H - radius;
  along(x1 - x0, (s) => ctx.fillText(s, x0, inset));
  along(x1 - x0, (s) => ctx.fillText(s, x0, H - inset));
  along(y1 - y0, (s) => { ctx.save(); ctx.translate(inset, y1); ctx.rotate(-Math.PI / 2); ctx.fillText(s, 0, 0); ctx.restore(); });
  along(y1 - y0, (s) => { ctx.save(); ctx.translate(W - inset, y0); ctx.rotate(Math.PI / 2); ctx.fillText(s, 0, 0); ctx.restore(); });
  ctx.restore();
}

// ------------------------------------------------------------------ WebGL

export const VERT = "attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}";

/** A full-screen triangle program, or null when WebGL isn't there (the page then draws without glass). */
export function makeProgram<K extends string>(canvas: HTMLCanvasElement, frag: string, names: readonly K[]) {
  let gl: WebGLRenderingContext | null = null;
  try {
    gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: false });
  } catch {
    gl = null;
  }
  if (!gl) return null;
  const g = gl;
  const sh = (type: number, src: string) => {
    const o = g.createShader(type);
    if (!o) return null;
    g.shaderSource(o, src);
    g.compileShader(o);
    if (!g.getShaderParameter(o, g.COMPILE_STATUS)) {
      console.warn(g.getShaderInfoLog(o));
      return null;
    }
    return o;
  };
  const vs = sh(g.VERTEX_SHADER, VERT);
  const fs = sh(g.FRAGMENT_SHADER, frag) ?? sh(g.FRAGMENT_SHADER, frag.replace("precision highp float;", "precision mediump float;"));
  const pr = g.createProgram();
  if (!vs || !fs || !pr) return null;
  g.attachShader(pr, vs);
  g.attachShader(pr, fs);
  g.linkProgram(pr);
  if (!g.getProgramParameter(pr, g.LINK_STATUS)) return null;
  g.useProgram(pr);
  g.bindBuffer(g.ARRAY_BUFFER, g.createBuffer());
  g.bufferData(g.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), g.STATIC_DRAW);
  const loc = g.getAttribLocation(pr, "p");
  g.enableVertexAttribArray(loc);
  g.vertexAttribPointer(loc, 2, g.FLOAT, false, 0, 0);
  const U = {} as Record<K, WebGLUniformLocation | null>;
  for (const n of names) U[n] = g.getUniformLocation(pr, n);
  const onLost = (e: Event) => e.preventDefault();
  canvas.addEventListener("webglcontextlost", onLost);
  return {
    gl: g,
    U,
    texture(unit: number) {
      const t = g.createTexture();
      g.activeTexture(g.TEXTURE0 + unit);
      g.bindTexture(g.TEXTURE_2D, t);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
      return t;
    },
    upload(unit: number, t: WebGLTexture | null, src: HTMLCanvasElement) {
      g.activeTexture(g.TEXTURE0 + unit);
      g.bindTexture(g.TEXTURE_2D, t);
      g.pixelStorei(g.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL, false);
      g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, src);
    },
    destroy() {
      canvas.removeEventListener("webglcontextlost", onLost);
      g.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}
export type Program<K extends string> = NonNullable<ReturnType<typeof makeProgram<K>>>;
