import type { PlacedChain } from "./model";

/** A hand rendered into a high-resolution pixel grid: height field, shading and outline. */
export type HandImage = {
  w: number;
  h: number;
  height: Float32Array; // -Infinity where empty
  shade: Float32Array; // 0 = lit, 1 = dark
  edge: Uint8Array; // 1 on the outline (silhouette or where one part passes in front of another)
};

// Polynomial smooth max: blends surfaces whose heights are within k of each other (joints, knuckles),
// keeps a hard step where one part clearly sits in front of another (that step becomes a crease line).
function smax(a: number, b: number, k: number): number {
  if (a === -Infinity) return b;
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.max(a, b) + h * h * k * 0.25;
}

export type RasterOpts = {
  w: number;
  h: number;
  sx: number; // pixels per scene unit, horizontally
  sy: number; // pixels per scene unit, vertically
  blend: number; // smooth-max radius in pixels
  crease: number; // height step (px) that counts as a crease
  edgeW: number; // extra outline thickness in pixels (0 = 1px line)
  light: [number, number, number];
};

export function rasterise(chains: PlacedChain[], o: RasterOpts): HandImage {
  const { w, h, sx, sy } = o;
  const height = new Float32Array(w * h).fill(-Infinity);
  const part = new Float32Array(w * h).fill(-Infinity);
  const s = (sx + sy) / 2; // radii/heights use the mean scale

  // Segments of one chain (a finger, the arm) join with a plain max: their joint spheres already match,
  // so the surface stays smooth. Different chains blend with a smooth max (finger into palm, palm into wrist).
  for (const { caps: chain, blend } of chains) {
    part.fill(-Infinity);
    const k = Math.max(o.blend, (blend ?? 0) * ((sx + sy) / 2));
    let px0 = w;
    let px1 = 0;
    let py0 = h;
    let py1 = 0;
    for (const c of chain) {
    const ax = c.ax * sx;
    const ay = c.ay * sy;
    const bx = c.bx * sx;
    const by = c.by * sy;
    const ra = c.ra * s;
    const rb = c.rb * s;
    const z = c.z * s;
    const r = Math.max(ra, rb);
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - r));
    const x1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx) + r));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by) - r));
    const y1 = Math.min(h - 1, Math.ceil(Math.max(ay, by) + r));
    const vx = bx - ax;
    const vy = by - ay;
    const l2 = vx * vx + vy * vy || 1;
    for (let y = y0; y <= y1; y++) {
      const py = y + 0.5;
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5;
        const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / l2));
        const rr = ra + (rb - ra) * t;
        const dx = px - (ax + t * vx);
        const dy = py - (ay + t * vy);
        const d2 = dx * dx + dy * dy;
        if (d2 >= rr * rr) continue;
        const hp = z + Math.sqrt(rr * rr - d2);
        const i = y * w + x;
        if (hp > part[i]) part[i] = hp;
      }
    }
    px0 = Math.min(px0, x0);
    px1 = Math.max(px1, x1);
    py0 = Math.min(py0, y0);
    py1 = Math.max(py1, y1);
    }
    for (let y = py0; y <= py1; y++) {
      for (let x = px0; x <= px1; x++) {
        const i = y * w + x;
        if (part[i] !== -Infinity) height[i] = smax(height[i], part[i], k);
      }
    }
  }

  // Shading from the height field's normals (central differences), outline from discontinuities.
  const shade = new Float32Array(w * h);
  const edge = new Uint8Array(w * h);
  const [lx, ly, lz] = o.light;
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? -Infinity : height[y * w + x]);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const hc = height[i];
      if (hc === -Infinity) continue;
      const l = at(x - 1, y);
      const rgt = at(x + 1, y);
      const u = at(x, y - 1);
      const d = at(x, y + 1);
      // Silhouette: a neighbour is empty. Crease: a neighbour is clearly lower (we are the front part).
      if (l === -Infinity || rgt === -Infinity || u === -Infinity || d === -Infinity) edge[i] = 1;
      else if (hc - l > o.crease || hc - rgt > o.crease || hc - u > o.crease || hc - d > o.crease) edge[i] = 1;
      // Gradient (skip across steps so creases don't wreck the normal).
      const gx = (Number.isFinite(rgt) && Math.abs(rgt - hc) < o.crease ? rgt : hc) - (Number.isFinite(l) && Math.abs(l - hc) < o.crease ? l : hc);
      const gy = (Number.isFinite(d) && Math.abs(d - hc) < o.crease ? d : hc) - (Number.isFinite(u) && Math.abs(u - hc) < o.crease ? u : hc);
      const nx = -gx / 2;
      const ny = -gy / 2;
      const m = Math.hypot(nx, ny, 1);
      const diffuse = Math.max(0, (nx * lx + ny * ly + lz) / m);
      shade[i] = 1 - diffuse;
    }
  }
  // Thicken the outline so each character cell sees a solid stroke, not a hairline.
  let out = edge;
  for (let pass = 0; pass < o.edgeW; pass++) {
    const next = out.slice();
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (out[i] || height[i] === -Infinity) continue;
        if (out[i - 1] || out[i + 1] || out[i - w] || out[i + w]) next[i] = 1;
      }
    }
    out = next;
  }
  return { w, h, height, shade, edge: out };
}
