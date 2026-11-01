// Draws DELPHI's orb and the bubbles onto one canvas with WebGL 1. Only the box around them is shaded
// each frame (scissor), so a small orb costs little even on a large screen.

import type { Orb } from "./orb-motion";
import { ORB_FRAGMENT, ORB_VERTEX } from "./orb-shader";

const UNIFORMS = ["uRes", "uDpr", "uTime", "uFade", "uK", "uKm", "uC", "uR", "uDrop", "uThink", "uEnergy", "uPulse", "uDots", "uMix", "uBloom", "uGlobe", "uProg", "uMainGrid", "uN", "uB", "uP", "uQ"] as const;
type Uniform = (typeof UNIFORMS)[number];

export type OrbFrame = {
  time: number;
  /** 0 to 1: the whole picture fades with it. */
  fade: number;
  orb: Orb;
  /** The main orb's grid type (see orb-shader.ts). */
  mainType: number;
  /** Bubbles in use, and their packed uniforms (4 floats each). */
  n: number;
  b: Float32Array;
  p: Float32Array;
  q: Float32Array;
  /** How far the orb's liquid reaches for a bubble (CSS px). */
  reach: number;
  /** Shade the whole canvas (a bubble is covering the screen). */
  full: boolean;
};

export class OrbRenderer {
  private constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly gl: WebGLRenderingContext,
    private readonly u: Record<Uniform, WebGLUniformLocation | null>,
  ) {}

  /** Null when the browser has no WebGL, or the shader won't build: the page then shows a still orb. */
  static create(canvas: HTMLCanvasElement): OrbRenderer | null {
    let gl: WebGLRenderingContext | null = null;
    try {
      gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: false, powerPreference: "high-performance" });
    } catch {
      gl = null;
    }
    if (!gl) return null;
    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type);
      if (!sh) return null;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      return gl.getShaderParameter(sh, gl.COMPILE_STATUS) ? sh : null;
    };
    const vs = compile(gl.VERTEX_SHADER, ORB_VERTEX);
    // Some phones only run fragment shaders at medium precision.
    const fs = compile(gl.FRAGMENT_SHADER, ORB_FRAGMENT) ?? compile(gl.FRAGMENT_SHADER, ORB_FRAGMENT.replace("precision highp float;", "precision mediump float;"));
    const prog = gl.createProgram();
    if (!vs || !fs || !prog) return null;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
    gl.useProgram(prog);
    // One triangle that covers the screen.
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const u = {} as Record<Uniform, WebGLUniformLocation | null>;
    for (const name of UNIFORMS) u[name] = gl.getUniformLocation(prog, name);
    gl.clearColor(0, 0, 0, 0);
    return new OrbRenderer(canvas, gl, u);
  }

  get lost() {
    return this.gl.isContextLost();
  }

  draw(f: OrbFrame, w: number, h: number, dpr: number) {
    const { gl, u, canvas } = this;
    const cw = Math.max(1, Math.round(w * dpr));
    const ch = Math.max(1, Math.round(h * dpr));
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }
    gl.viewport(0, 0, cw, ch);
    gl.disable(gl.SCISSOR_TEST);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const box = f.full ? { x0: 0, y0: 0, x1: w, y1: h } : bounds(f);
    if (!box || f.fade <= 0) return;
    const x0 = Math.max(0, Math.floor(box.x0 * dpr));
    const x1 = Math.min(cw, Math.ceil(box.x1 * dpr));
    const y0 = Math.max(0, Math.floor(box.y0 * dpr));
    const y1 = Math.min(ch, Math.ceil(box.y1 * dpr));
    if (x1 <= x0 || y1 <= y0) return;
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(x0, ch - y1, x1 - x0, y1 - y0);

    const o = f.orb;
    gl.uniform2f(u.uRes, cw, ch);
    gl.uniform1f(u.uDpr, dpr);
    gl.uniform1f(u.uTime, f.time);
    gl.uniform1f(u.uFade, f.fade);
    gl.uniform1f(u.uK, 14);
    gl.uniform1f(u.uKm, f.reach);
    gl.uniform2f(u.uC, o.cx, o.cy);
    gl.uniform1f(u.uR, o.r);
    gl.uniform1f(u.uDrop, o.drop);
    gl.uniform1f(u.uThink, o.think);
    gl.uniform1f(u.uEnergy, o.energy);
    gl.uniform1f(u.uPulse, o.pulse);
    gl.uniform1f(u.uDots, o.dots);
    gl.uniform1f(u.uMix, o.mix);
    gl.uniform3f(u.uBloom, o.bloom[0], o.bloom[1], o.bloom[2]);
    gl.uniform1f(u.uGlobe, o.globe);
    gl.uniform1f(u.uProg, o.prog);
    gl.uniform1f(u.uMainGrid, f.mainType);
    gl.uniform1f(u.uN, f.n);
    gl.uniform4fv(u.uB, f.b);
    gl.uniform4fv(u.uP, f.p);
    gl.uniform4fv(u.uQ, f.q);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  dispose() {
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

/** The box (CSS px) holding the orb, every bubble, their glow and their shadows. */
function bounds(f: OrbFrame) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const add = (x: number, y: number, r: number) => {
    if (r < 0.5) return;
    // The soft shadow fades out by about 1.3 radii, and sits a little low.
    const m = Math.max(r * 1.3, 24);
    x0 = Math.min(x0, x - r - m);
    x1 = Math.max(x1, x + r + m);
    y0 = Math.min(y0, y - r - m);
    y1 = Math.max(y1, y + r + m + r * 0.2);
  };
  add(f.orb.cx, f.orb.cy, f.orb.r);
  for (let i = 0; i < f.n; i++) add(f.b[i * 4], f.b[i * 4 + 1], f.b[i * 4 + 2]);
  // The orb reaching for a bubble can bridge the gap between them; it's inside this box already.
  return x1 > x0 ? { x0, y0, x1, y1 } : null;
}
