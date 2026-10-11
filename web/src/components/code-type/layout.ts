import { GLYPHS, GLYPH_ROWS, LINE_GAP, SPACE, TRACKING } from "./glyphs";

export type HeadlineWord = { text: string; muted?: boolean; breakAfter?: boolean };

/** One lit module of the bitmap (a module renders as 2 code characters side by side). */
export type Module = { col: number; row: number; glyphRow: number; letter: number; muted: boolean };

export type HeadlineLayout = { cols: number; rows: number; modules: Module[]; lines: number };

type Line = HeadlineWord[];

function glyph(ch: string): string[] {
  const g = GLYPHS[ch];
  if (!g) throw new Error(`code-type: no glyph for "${ch}"`);
  return g;
}

function wordCols(word: string): number {
  const chars = [...word];
  return chars.reduce((sum, ch) => sum + glyph(ch)[0].length, 0) + TRACKING * (chars.length - 1);
}

function lineCols(line: Line): number {
  const gap = TRACKING + SPACE + TRACKING;
  return line.reduce((sum, w, i) => sum + wordCols(w.text) + (i ? gap : 0), 0);
}

/** Split at the author's preferred breaks, then greedily wrap each segment to maxCols. */
function wrap(words: HeadlineWord[], maxCols: number): Line[] {
  const segments: Line[] = [[]];
  for (const w of words) {
    segments[segments.length - 1].push(w);
    if (w.breakAfter) segments.push([]);
  }
  const lines: Line[] = [];
  for (const seg of segments.filter((s) => s.length)) {
    let cur: Line = [];
    for (const w of seg) {
      if (cur.length && lineCols([...cur, w]) > maxCols) {
        lines.push(cur);
        cur = [];
      }
      cur.push(w);
    }
    if (cur.length) lines.push(cur);
  }
  return lines;
}

function place(lines: Line[]): HeadlineLayout {
  const cols = Math.max(...lines.map(lineCols));
  const modules: Module[] = [];
  let letter = 0;
  lines.forEach((line, li) => {
    const top = li * (GLYPH_ROWS + LINE_GAP);
    let x = Math.floor((cols - lineCols(line)) / 2);
    line.forEach((word, wi) => {
      if (wi) x += TRACKING + SPACE + TRACKING;
      [...word.text].forEach((ch, ci) => {
        if (ci) x += TRACKING;
        const g = glyph(ch);
        g.forEach((bits, r) => {
          for (let c = 0; c < bits.length; c++) {
            if (bits[c] === "#") modules.push({ col: x + c, row: top + r, glyphRow: r, letter, muted: !!word.muted });
          }
        });
        x += g[0].length;
        letter++;
      });
    });
  });
  const rows = lines.length * GLYPH_ROWS + (lines.length - 1) * LINE_GAP;
  return { cols, rows, modules, lines: lines.length };
}

/**
 * Pick the line breaks that give the largest characters for the box.
 * A module is 2 characters wide and 1 tall, and characters are half as wide as tall, so modules are square.
 */
export function layoutHeadline(
  words: HeadlineWord[],
  box: { width: number; height: number },
  limits: { maxCharW: number },
): { layout: HeadlineLayout; charW: number } {
  const fit = (layout: HeadlineLayout) => ({
    layout,
    charW: Math.min(limits.maxCharW, box.width / (layout.cols * 2), box.height / (layout.rows * 2)),
  });
  const preferred = fit(place(wrap(words, Infinity)));
  const widest = Math.max(...words.map((w) => wordCols(w.text)));
  const total = lineCols(words);
  let best = preferred;
  for (let maxCols = widest; maxCols <= total + 4; maxCols += 2) {
    const c = fit(place(wrap(words, maxCols)));
    // Prefer fewer lines unless more lines buys clearly bigger type.
    if (c.charW > best.charW * 1.04 || (c.charW >= best.charW * 0.98 && c.layout.lines < best.layout.lines)) best = c;
  }
  // Keep the author's line breaks unless re-wrapping makes the type a lot bigger (small screens).
  return preferred.charW >= best.charW * 0.78 ? preferred : best;
}
