// A portrait drawn in our contract code, in the site's style: every cell of the person is one
// character, darker where the picture is darker; the deepest shadows become solid ink with the
// character knocked out (like the hero lettering and the temple). No glitch: a still portrait.

export type Variant = "light" | "dark";
const INK = "#171717";
const PAPER = "#f9f9f9";
const SOLID = 0.8; // darkness at which a cell turns solid
const MONO = '"Geist Mono", ui-monospace, monospace';

type Cell = { alpha: number; tone: number; line: number };

/**
 * Each grid cell of the prepared portrait (tools/tonemap.py: red = tone after local contrast,
 * green = the show's drawn lines, alpha = the person): its average tone, its strongest line,
 * and how much of the cell is the person.
 */
function sample(img: HTMLImageElement, cols: number, rows: number): Cell[] {
  const S = 1000;
  const c = document.createElement("canvas");
  c.width = S;
  c.height = S;
  const g = c.getContext("2d", { willReadFrequently: true })!;
  g.drawImage(img, 0, 0, S, S);
  const px = g.getImageData(0, 0, S, S).data;
  const cells: Cell[] = [];
  for (let r = 0; r < rows; r++) {
    for (let q = 0; q < cols; q++) {
      const x0 = Math.floor((q * S) / cols);
      const x1 = Math.floor(((q + 1) * S) / cols);
      const y0 = Math.floor((r * S) / rows);
      const y1 = Math.floor(((r + 1) * S) / rows);
      let sum = 0;
      let wsum = 0;
      let line = 0;
      let a = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * S + x) * 4;
          const al = px[i + 3] / 255;
          sum += (px[i] / 255) * al;
          wsum += al;
          if (al > 0.5) line = Math.max(line, px[i + 1] / 255);
          a += al;
          n++;
        }
      }
      cells.push({ alpha: a / n, tone: wsum > 0 ? sum / wsum : 1, line });
    }
  }
  // Same contrast for every portrait, squeezed a little so skin stays a light grey, not white.
  const tones = cells.filter((k) => k.alpha > 0.5).map((k) => k.tone).sort((p, q) => p - q);
  const lo = tones[Math.floor(tones.length * 0.02)] ?? 0;
  const hi = tones[Math.floor(tones.length * 0.98)] ?? 1;
  for (const k of cells) k.tone = 0.08 + 0.84 * Math.min(1, Math.max(0, (k.tone - lo) / Math.max(0.05, hi - lo)));
  return cells;
}

export function drawPortrait(img: HTMLImageElement, code: string, variant: Variant, size = 1000, cols = 170): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext("2d")!;
  const cellW = size / cols;
  const fontPx = cellW / 0.6;
  const lineH = fontPx * 1.17;
  const rows = Math.floor(size / lineH);
  const cells = sample(img, cols, rows);
  const bg = variant === "light" ? PAPER : INK;
  const fg = variant === "light" ? INK : PAPER;
  g.fillStyle = bg;
  g.fillRect(0, 0, size, size);
  g.font = `500 ${fontPx}px ${MONO}`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  const y0 = (size - rows * lineH) / 2;
  let k = 0;
  cells.forEach((cell, i) => {
    if (cell.alpha < 0.62) return; // background (and soft cut-out edges): left empty
    const r = Math.floor(i / cols);
    const q = i % cols;
    // light: ink where the picture is dark, and the drawn lines darker still.
    // dark: light code where the picture is bright, and the drawn lines left dark.
    const line = cell.line > 0.3 ? cell.line : 0;
    const strength =
      variant === "light" ? Math.max(Math.pow(1 - cell.tone, 1.05), line ? 0.45 + 0.5 * line : 0) : cell.tone * (1 - 0.8 * line);
    const cover = 1; // crisp edges: a cell is either the person or not
    const x = q * cellW;
    const y = y0 + r * lineH;
    const ch = code[k++ % code.length];
    if (strength >= SOLID) {
      g.globalAlpha = cover;
      g.fillStyle = fg;
      g.fillRect(x, y, cellW + 0.4, lineH + 0.4);
      g.globalAlpha = 0.42 * cover;
      g.fillStyle = bg;
    } else {
      g.globalAlpha = (0.1 + 0.9 * strength) * cover;
      g.fillStyle = fg;
    }
    g.fillText(ch, x + cellW / 2, y + lineH / 2);
  });
  g.globalAlpha = 1;
  return canvas;
}
