// A post image for X (1600 × 900, drawn at 2×), from the site's own pieces: the PANTHEON wordmark in
// our code type (solid ink with contract code knocked out), the code-drawn temple, and the site's
// hairline rails. Black and white only, and big enough to read in a phone feed.
import { GLYPHS, GLYPH_ROWS, TRACKING } from "../code-type/glyphs";
import { buildTemple, INK } from "../section3/temple";
import source from "../section3/code.sol.txt?raw";

const INK_C = "#171717";
const PAPER = "#f9f9f9";
const RULE = "#e3e3e3";
const MONO = '"Geist Mono", ui-monospace, monospace';
const code = source
  .slice(Math.max(0, source.indexOf("contract ")))
  .split("\n")
  .filter((l) => !l.trim().startsWith("//"))
  .join("")
  .replace(/\s+/g, "");

const W = 3200;
const H = 1800;
const M = 200; // the rails, like the site's

const c = document.createElement("canvas");
c.id = "post";
c.width = W;
c.height = H;
c.style.width = `${W / 2}px`;
document.body.append(c);
const g = c.getContext("2d")!;

/** A word in the code type: every letter pixel a solid block, with rows of code knocked out. */
function word(text: string, x0: number, y0: number, mod: number) {
  const per = 8;
  const charW = mod / per;
  const lineH = mod / 4;
  g.font = `600 ${charW / 0.6}px ${MONO}`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  let k = 0;
  let x = x0;
  [...text].forEach((ch, i) => {
    if (i) x += TRACKING * mod;
    const glyph = GLYPHS[ch];
    glyph.forEach((row, r) =>
      [...row].forEach((m, col) => {
        if (m !== "#") return;
        for (let sr = 0; sr < 4; sr++) {
          const px = x + col * mod;
          const py = y0 + r * mod + sr * lineH;
          g.globalAlpha = 1;
          g.fillStyle = INK_C;
          g.fillRect(px, py, mod + 0.6, lineH + 0.6);
          g.fillStyle = PAPER;
          g.globalAlpha = 0.8;
          for (let j = 0; j < per; j++) g.fillText(code[k++ % code.length], px + charW * (j + 0.5), py + lineH / 2);
        }
      }),
    );
    x += glyph[0].length * mod;
  });
  g.globalAlpha = 1;
}

/** Mono text with even letter spacing, laid out from its centre or its left edge. */
function spaced(text: string, x: number, y: number, size: number, align: "left" | "center" | "right", weight = 500) {
  g.font = `${weight} ${size}px ${MONO}`;
  g.textAlign = "left";
  g.textBaseline = "middle";
  g.fillStyle = INK_C;
  const step = size * 0.6 * 1.12;
  const width = text.length * step;
  let left = align === "left" ? x : align === "center" ? x - width / 2 : x - width;
  for (const ch of text) {
    g.fillText(ch, left, y);
    left += step;
  }
}

function draw() {
  g.fillStyle = PAPER;
  g.fillRect(0, 0, W, H);

  // the site's rails and two hairline rules
  g.fillStyle = RULE;
  g.fillRect(M, 0, 2, H);
  g.fillRect(W - M, 0, 2, H);
  const topRule = 330;
  const bottomRule = 1500;
  g.fillRect(M, topRule, W - 2 * M, 2);
  g.fillRect(M, bottomRule, W - 2 * M, 2);

  // the wordmark, top left, and where it lives, top right
  const mod = 13;
  word("PANTHEON", M + 90, (topRule - GLYPH_ROWS * mod) / 2, mod);
  spaced("LIVE ON ELYSIUM TESTNET", W - M - 90, topRule / 2, 56, "right");

  // the temple, centred between the rules
  const C = 300;
  const t = buildTemple(C, code);
  const tw = 1900;
  const cellW = tw / C;
  const fontPx = cellW / 0.6;
  const lineH = fontPx * 1.17;
  const th = t.rows * lineH;
  const ox = (W - tw) / 2;
  const oy = topRule + (bottomRule - topRule - th) / 2;
  g.font = `400 ${fontPx}px ${MONO}`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  for (const q of t.cells) {
    const x = ox + q.c * cellW;
    const y = oy + q.r * lineH;
    if (!q.line && q.d >= INK) {
      g.globalAlpha = 1;
      g.fillStyle = INK_C;
      g.fillRect(x, y, cellW + 0.5, lineH + 0.5);
      g.fillStyle = PAPER;
      g.globalAlpha = 0.42;
    } else {
      g.fillStyle = INK_C;
      g.globalAlpha = q.line ? 1 : Math.min(1, q.d * 1.05);
    }
    g.fillText(q.ch, x + cellW / 2, y + lineH / 2);
  }
  // the inscription on its clean band
  const { r0, rows } = t.frieze;
  const size = rows * lineH * 0.5;
  const text = "THE BEST OF ASCEND";
  const step = size * 0.6 * 1.85;
  const width = (text.length - 1) * step;
  g.globalAlpha = 1;
  g.fillStyle = PAPER;
  g.fillRect(W / 2 - width / 2 - step, oy + (r0 + 0.5) * lineH, width + 2 * step, (rows - 1) * lineH);
  g.fillStyle = INK_C;
  g.font = `500 ${size}px ${MONO}`;
  for (let j = 0; j < text.length; j++) g.fillText(text[j], W / 2 - width / 2 + j * step, oy + (r0 + rows / 2) * lineH);

  // what it does, in one line
  spaced("BUYS FILL THE BASKET. SELLS BURN $PNTH.", W / 2, (bottomRule + H) / 2, 76, "center");
}

/**
 * The teaser: ink background, the temple drawn in light code, whole at the roof and dissolving into
 * loose characters towards the ground, and one word under it.
 */
function teaser() {
  g.fillStyle = INK_C;
  g.fillRect(0, 0, W, H);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

  const C = 300;
  const t = buildTemple(C, code);
  const tw = 2000;
  const cellW = tw / C;
  const fontPx = cellW / 0.6;
  const lineH = fontPx * 1.17;
  const th = t.rows * lineH;
  const ox = (W - tw) / 2;
  const oy = (H - th) / 2 - 110;
  g.font = `400 ${fontPx}px ${MONO}`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  for (const q of t.cells) {
    // Solid from the roof down to the middle of the columns, then the stone falls away.
    const depth = q.r / t.rows;
    const keep = depth < 0.55 ? 1 : Math.max(0, 1 - (depth - 0.55) / 0.42);
    if (rnd() > keep) {
      if (rnd() < 0.18) {
        g.globalAlpha = 0.16;
        g.fillStyle = PAPER;
        g.fillText(q.ch, ox + q.c * cellW + cellW / 2, oy + (q.r + rnd() * 6) * lineH + lineH / 2);
      }
      continue;
    }
    const x = ox + q.c * cellW;
    const y = oy + q.r * lineH;
    if (!q.line && q.d >= INK) {
      g.globalAlpha = keep;
      g.fillStyle = PAPER;
      g.fillRect(x, y, cellW + 0.5, lineH + 0.5);
      g.fillStyle = INK_C;
      g.globalAlpha = 0.5 * keep;
    } else {
      g.fillStyle = PAPER;
      g.globalAlpha = (q.line ? 1 : Math.min(1, q.d * 1.05)) * keep;
    }
    g.fillText(q.ch, x + cellW / 2, y + lineH / 2);
  }
  const { r0, rows } = t.frieze;
  const size = rows * lineH * 0.5;
  const text = "THE BEST OF ASCEND";
  const step = size * 0.6 * 1.85;
  const width = (text.length - 1) * step;
  g.globalAlpha = 1;
  g.fillStyle = INK_C;
  g.fillRect(W / 2 - width / 2 - step, oy + (r0 + 0.5) * lineH, width + 2 * step, (rows - 1) * lineH);
  g.fillStyle = PAPER;
  g.font = `500 ${size}px ${MONO}`;
  for (let j = 0; j < text.length; j++) g.fillText(text[j], W / 2 - width / 2 + j * step, oy + (r0 + rows / 2) * lineH);

  g.font = `500 84px ${MONO}`;
  g.textAlign = "left";
  g.textBaseline = "middle";
  g.fillStyle = PAPER;
  const word = "SOON.";
  const stepW = 84 * 0.6 * 1.6;
  let x = W / 2 - (word.length * stepW) / 2;
  for (const ch of word) {
    g.fillText(ch, x, H - 190);
    x += stepW;
  }
}

const mode = new URLSearchParams(location.search).get("v");

document.fonts
  .load(`600 20px ${MONO}`)
  .then(() => document.fonts.load(`500 20px ${MONO}`))
  .then(() => document.fonts.load(`400 20px ${MONO}`))
  .then(() => {
    if (mode === "teaser") teaser();
    else draw();
    document.body.dataset.ready = "1";
  });
