// The Pantheon, drawn in code: a temple front shaded like an engraving on a character grid.
// Light comes from the left. Every cell gets a darkness: light cells are faint characters of our
// contract code, mid-tones are darker characters, and the deepest shadow becomes solid ink with the
// code knocked out (the hero's code type). Ten columns, one per coin in the basket, stand in
// front of a shadowed porch so each can fall and rise on its own when a vote swaps that coin.

export type Cell = {
  r: number;
  c: number;
  ch: string; // contract character (or a drawn line, see `line`)
  d: number; // darkness 0..1
  part: number; // 0..9 = that coin's column, -1 = the rest of the building
  behind: number; // for column cells: darkness of the porch behind it (shown while the column is down)
  line?: boolean; // a drawn edge (_ . - ' ¯ @) rather than code
};

export type Temple = {
  cols: number;
  rows: number;
  cells: Cell[];
  columnX: number[]; // centre of each column, as a fraction of the width
  frieze: { r0: number; rows: number }; // the light band that carries the inscription
  partRows: { top: number; bottom: number }; // row span of a column (capital to plinth)
  partCols: [number, number][]; // column span of each column, capital included
};

export const COLUMNS = 10;
/** Darkness at which a cell turns to solid ink with the character knocked out. */
export const INK = 0.82;

// Grid rows per grid column: the temple is about 0.53 × as tall as it is wide.
const ROWS_PER_COL = 0.27;

// Shadows: the recessed pediment and the porch behind the columns are solid ink.
const TYMPANUM = 0.95;
const PORCH = 0.95;

// The hero's P (10 rows × 7 modules; a module is 2 characters wide), lit, in the dark pediment.
const P_MARK = ["######.", "#######", "##...##", "##...##", "#######", "######.", "##.....", "##.....", "##.....", "##....."];

export function buildTemple(C: number, code: string): Temple {
  const R = Math.round(C * ROWS_PER_COL);
  const N = R * C;
  const dark = new Float32Array(N).fill(-1);
  const part = new Int8Array(N).fill(-1);
  const behind = new Float32Array(N);
  const line: (string | undefined)[] = new Array(N);
  const at = (r: number, c: number) => r * C + c;
  const ok = (r: number, c: number) => r >= 0 && r < R && c >= 0 && c < C;
  const paint = (r: number, c: number, d: number, p = -1, ln?: string) => {
    if (!ok(r, c)) return;
    const i = at(r, c);
    if (p >= 0 && part[i] < 0) behind[i] = Math.max(0, dark[i]);
    dark[i] = d;
    part[i] = p;
    line[i] = ln;
  };
  const span = (r: number, c0: number, c1: number, d: number, p = -1) => {
    for (let c = c0; c <= c1; c++) paint(r, c, d, p);
  };
  const x = (f: number) => Math.round(f * (C - 1));
  const mid = (C - 1) / 2;

  // ── vertical stack ──
  const ped = Math.round(R * 0.2); // pediment rows, apex at row 0
  const cornice = ped; // 2 rows
  const shadow = cornice + 2; // the cornice's shadow on the frieze
  const friezeR0 = shadow + 1;
  const friezeRows = Math.max(3, Math.round(R * 0.075));
  const architrave = friezeR0 + friezeRows; // 2 rows
  const porch0 = architrave + 2; // porch, capitals and shafts start here
  const stepRows = 6; // three steps: a lit tread and a shaded riser each
  const step0 = R - stepRows;
  const plinth = step0 - 1;
  const torus = plinth - 1;

  // ── pediment: a fine raking line, the lit raking cornice, its shadow, then the recessed tympanum ──
  const pc0 = x(0.02);
  const pc1 = x(0.98);
  const half = mid - pc0;
  const glyph = (f: number) => (f < 0.2 ? "¯" : f < 0.4 ? "'" : f < 0.6 ? "-" : f < 0.8 ? "." : "_");
  const RAKE = 1.8; // the lit raking cornice, in rows under the line
  // Darkness of a cell from how much of it lies in the lit cornice and how much in the dark recess,
  // so the shallow slope shades smoothly instead of stepping.
  const cover = (a: number, b: number, r: number) => Math.max(0, Math.min(b, r + 1) - Math.max(a, r));
  for (let c = pc0; c <= pc1; c++) {
    const y = (Math.abs(c - mid) / half) * (ped - 0.15);
    const row = Math.floor(y);
    paint(row, c, 1, -1, glyph(y - row));
    for (let r = row + 1; r < ped; r++) paint(r, c, 0.2 * cover(y, y + RAKE, r) + TYMPANUM * cover(y + RAKE, 1e9, r));
  }
  const pTop = Math.max(3, Math.round((ped - P_MARK.length) / 2 + 1.6));
  const pLeft = Math.round(mid - P_MARK[0].length);
  P_MARK.forEach((row, gy) =>
    [...row].forEach((m, gx) => {
      if (m === "#") for (let k = 0; k < 2; k++) paint(pTop + gy, pLeft + gx * 2 + k, 0.1);
    }),
  );

  // ── entablature: cornice, its shadow, the light frieze, the architrave ──
  span(cornice, x(0.012), x(0.988), 0.2);
  span(cornice + 1, x(0.018), x(0.982), 0.3);
  span(shadow, x(0.035), x(0.965), 0.92);
  for (let r = friezeR0; r < architrave; r++) span(r, x(0.04), x(0.96), 0.09);
  span(architrave, x(0.04), x(0.96), 0.3);
  span(architrave + 1, x(0.045), x(0.955), 0.45);

  // ── the ten columns, standing in front of the shadowed porch ──
  const w = Math.max(5, Math.round(C * 0.042));
  const s0 = x(0.075);
  const s1 = x(0.925);
  const gap = (s1 - s0 + 1 - COLUMNS * w) / (COLUMNS - 1);
  const starts = Array.from({ length: COLUMNS }, (_, i) => Math.round(s0 + i * (w + gap)));
  // the porch, in shadow behind the columns
  for (let r = porch0; r < step0; r++) span(r, starts[0] - 2, starts[COLUMNS - 1] + w + 1, PORCH);
  const columnX: number[] = [];
  const partCols: [number, number][] = [];
  starts.forEach((c0, i) => {
    const c1 = c0 + w - 1;
    columnX.push((c0 + c1 + 1) / 2 / C);
    partCols.push([c0 - 3, c1 + 3]);
    // capital: abacus (with volutes), its shadow, the echinus
    span(porch0, c0 - 3, c1 + 3, 0.15, i);
    paint(porch0, c0 - 3, 1, i, "@");
    paint(porch0, c1 + 3, 1, i, "@");
    span(porch0 + 1, c0 - 2, c1 + 2, 0.86, i);
    span(porch0 + 2, c0 - 1, c1 + 1, 0.35, i);
    // shaft: a lit cylinder with flutes
    for (let r = porch0 + 3; r < torus; r++) {
      for (let j = 0; j < w; j++) {
        const nx = (2 * (j + 0.5)) / w - 1;
        const nz = Math.sqrt(Math.max(0, 1 - nx * nx));
        const light = Math.max(0, -0.55 * nx + 0.8 * nz);
        const flute = j % 3 === 1 ? 0.07 : 0;
        paint(r, c0 + j, Math.min(0.78, 0.04 + 0.8 * (1 - light) + flute), i);
      }
    }
    // base: torus, plinth
    span(torus, c0 - 1, c1 + 1, 0.18, i);
    span(plinth, c0 - 2, c1 + 2, 0.3, i);
  });

  // ── three steps, each a lit tread over a shaded riser ──
  const widths = [0.035, 0.02, 0.005];
  widths.forEach((f, s) => {
    span(step0 + s * 2, x(f), x(1 - f), 0.12);
    span(step0 + s * 2 + 1, x(f), x(1 - f), 0.5 + s * 0.06);
  });

  // ── to cells: each painted position takes the next character of the contract ──
  const cells: Cell[] = [];
  let k = 0;
  for (let r = 0; r < R; r++) {
    for (let c = 0; c < C; c++) {
      const i = at(r, c);
      if (dark[i] < 0.06) continue;
      const ln = line[i];
      cells.push({ r, c, ch: ln ?? code[k++ % code.length], d: dark[i], part: part[i], behind: behind[i], line: ln !== undefined });
    }
  }

  return {
    cols: C,
    rows: R,
    cells,
    columnX,
    frieze: { r0: friezeR0, rows: friezeRows },
    partRows: { top: porch0, bottom: plinth },
    partCols,
  };
}
