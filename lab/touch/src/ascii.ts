import type { HandImage } from "./raster";

/** Each candidate glyph rendered into one character cell, blurred and normalised for matching. */
export type Atlas = { cw: number; ch: number; chars: string[]; vecs: Float32Array[] };

function blur(src: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          s += src[yy * w + xx];
          n++;
        }
      }
      out[y * w + x] = s / n;
    }
  }
  return out;
}

function normalise(v: Float32Array): Float32Array {
  let m = 0;
  for (const x of v) m += x * x;
  m = Math.sqrt(m) || 1;
  return v.map((x) => x / m);
}

export function buildAtlas(chars: string, cw: number, ch: number, family: string, weight: number): Atlas {
  const cv = document.createElement("canvas");
  cv.width = cw;
  cv.height = ch;
  const g = cv.getContext("2d", { willReadFrequently: true })!;
  g.font = `${weight} 100px ${family}`;
  const adv = g.measureText("M").width / 100 || 0.6;
  const fontPx = cw / adv;
  g.font = `${weight} ${fontPx}px ${family}`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  const list = [...new Set(chars)].filter((c) => c !== " ");
  const vecs = list.map((c) => {
    g.clearRect(0, 0, cw, ch);
    g.fillText(c, cw / 2, ch / 2);
    const px = g.getImageData(0, 0, cw, ch).data;
    const v = new Float32Array(cw * ch);
    for (let i = 0; i < v.length; i++) v[i] = px[i * 4 + 3] / 255;
    return normalise(blur(v, cw, ch));
  });
  return { cw, ch, chars: list, vecs };
}

export type AsciiOpts = {
  cols: number;
  rows: number;
  minEdge: number; // edge pixels needed in a cell before it becomes an outline glyph
  minScore: number; // below this match score the outline cell falls back to "."
  minCover: number; // share of the cell inside the hand before it gets a fill glyph
  fill: string; // fill ramp, light → dark (index 0 is usually a space)
  gamma: number; // >1 keeps lit areas emptier
  style: string; // "outline" | "density" | "hybrid"
  ramp: string; // density ramp, light → dark
  floor: number; // minimum density inside the hand so lit areas keep their shape
  edgeMode: string; // "match" (glyph shape matching) | "orient" (stroke direction + position)
};

/** Turn one hand image into two text layers: outline glyphs and tone fill. */
export function toAscii(img: HandImage, atlas: Atlas, o: AsciiOpts): { edge: string; fill: string } {
  const { cw, ch } = atlas;
  const cell = new Float32Array(cw * ch);
  const edgeRows: string[] = [];
  const fillRows: string[] = [];
  for (let r = 0; r < o.rows; r++) {
    let er = "";
    let fr = "";
    for (let c = 0; c < o.cols; c++) {
      let edges = 0;
      let cover = 0;
      let tone = 0;
      for (let y = 0; y < ch; y++) {
        const row = (r * ch + y) * img.w + c * cw;
        for (let x = 0; x < cw; x++) {
          const i = row + x;
          const e = img.edge[i];
          cell[y * cw + x] = e;
          edges += e;
          if (img.height[i] !== -Infinity) {
            cover++;
            tone += img.shade[i];
          }
        }
      }
      if (o.style === "density" || (o.style === "hybrid" && edges < o.minEdge)) {
        const c = cover / (cw * ch);
        if (c < 0.12) {
          er += " ";
          fr += " ";
          continue;
        }
        const t = cover ? tone / cover : 0;
        const v = Math.min(1, c) * (o.floor + (1 - o.floor) * Math.pow(t, o.gamma));
        er += o.ramp[Math.min(o.ramp.length - 1, Math.round(v * (o.ramp.length - 1)))];
        fr += " ";
        continue;
      }
      if (edges >= o.minEdge && o.edgeMode === "orient") {
        er += orientGlyph(cell, cw, ch);
        fr += " ";
        continue;
      }
      if (edges >= o.minEdge) {
        const v = normalise(blur(cell, cw, ch));
        let best = -1;
        let bestChar = ".";
        for (let k = 0; k < atlas.chars.length; k++) {
          const g = atlas.vecs[k];
          let dot = 0;
          for (let i = 0; i < v.length; i++) dot += v[i] * g[i];
          if (dot > best) {
            best = dot;
            bestChar = atlas.chars[k];
          }
        }
        er += best >= o.minScore ? bestChar : ".";
        fr += " ";
      } else if (cover / (cw * ch) >= o.minCover) {
        const t = Math.pow(tone / cover, o.gamma);
        er += " ";
        fr += o.fill[Math.min(o.fill.length - 1, Math.floor(t * o.fill.length))];
      } else {
        er += " ";
        fr += " ";
      }
    }
    edgeRows.push(er);
    fillRows.push(fr);
  }
  return { edge: edgeRows.join("\n"), fill: fillRows.join("\n") };
}

/**
 * Pick an outline glyph from the stroke inside one cell: its direction (principal axis of the edge
 * pixels, in cell-normalised coordinates so "/" means corner to corner) and where it sits in the cell.
 */
export function orientGlyph(cell: Float32Array, cw: number, ch: number): string {
  let n = 0;
  let mu = 0;
  let mv = 0;
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      if (!cell[y * cw + x]) continue;
      n++;
      mu += (x + 0.5) / cw;
      mv += (y + 0.5) / ch;
    }
  }
  mu /= n;
  mv /= n;
  let suu = 0;
  let svv = 0;
  let suv = 0;
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      if (!cell[y * cw + x]) continue;
      const du = (x + 0.5) / cw - mu;
      const dv = (y + 0.5) / ch - mv;
      suu += du * du;
      svv += dv * dv;
      suv += du * dv;
    }
  }
  // Principal axis of the stroke; linearity = how line-like it is.
  const tr = suu + svv;
  const det = suu * svv - suv * suv;
  const l1 = tr / 2 + Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const l2 = tr - l1;
  const linear = l1 > 0 ? 1 - l2 / l1 : 0;
  const ang = (Math.atan2(2 * suv, suu - svv) / 2) * (180 / Math.PI); // -90..90, y down
  if (n < 4 || linear < 0.35) {
    // A speck or a tight curve: place a dot where the ink is.
    return mv < 0.4 ? "'" : mv > 0.6 ? "," : ".";
  }
  const a = Math.abs(ang);
  if (a < 22.5) return mv < 0.36 ? "¯" : mv > 0.64 ? "_" : "-";
  if (a > 67.5) return mu < 0.3 ? "(" : mu > 0.7 ? ")" : "|";
  return ang > 0 ? "\\" : "/";
}
