// Brand images for X, drawn with the site's own pieces: the P from our code type (solid ink with
// our contract code knocked out) for the profile picture, and the code-drawn temple for the banner.
import { GLYPHS } from "../code-type/glyphs";
import { buildTemple, INK } from "../section3/temple";
import source from "../section3/code.sol.txt?raw";

const INK_C = "#171717";
const PAPER = "#f9f9f9";
const code = source
  .slice(Math.max(0, source.indexOf("contract ")))
  .split("\n")
  .filter((l) => !l.trim().startsWith("//"))
  .join("")
  .replace(/\s+/g, "");
const MONO = '"Geist Mono", ui-monospace, monospace';

function canvas(id: string, w: number, h: number) {
  const c = document.createElement("canvas");
  c.id = id;
  c.width = w;
  c.height = h;
  c.style.width = `${w / 4}px`;
  c.style.margin = "12px";
  document.body.append(c);
  return c.getContext("2d")!;
}

/** The P, centred: every letter pixel is a solid block with rows of code knocked out of it. */
function pfp(id: string, bg: string, fg: string, glitch: boolean) {
  const S = 1000;
  const g = canvas(id, S, S);
  g.fillStyle = bg;
  g.fillRect(0, 0, S, S);
  const P = GLYPHS.P;
  const rows = P.length;
  const cols = P[0].length;
  const mod = Math.floor((S * 0.56) / rows); // letter pixel size
  const x0 = Math.round((S - cols * mod) / 2 + mod * 0.15);
  const y0 = Math.round((S - rows * mod) / 2);
  const per = 8; // characters across one letter pixel
  const charW = mod / per;
  const lineH = mod / 4;
  g.font = `600 ${charW / 0.6}px ${MONO}`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  let k = 0;
  // Two slices of the letter slip sideways, like the hero's glitch, with a faint echo.
  const slips = glitch ? [{ y: 3.25, h: 0.5, dx: mod * 0.55 }, { y: 7.5, h: 0.25, dx: -mod * 0.35 }] : [];
  const draw = (alpha: number, dxAll: number) => {
    P.forEach((row, r) =>
      [...row].forEach((m, c) => {
        if (m !== "#") return;
        for (let sr = 0; sr < 4; sr++) {
          const ry = r + sr / 4;
          const slip = slips.find((s) => ry >= s.y && ry < s.y + s.h);
          const x = x0 + c * mod + (slip?.dx ?? 0) + dxAll;
          const y = y0 + r * mod + sr * lineH;
          g.globalAlpha = alpha;
          g.fillStyle = fg;
          g.fillRect(x, y, mod + 0.6, lineH + 0.6);
          g.fillStyle = bg;
          g.globalAlpha = alpha * 0.85;
          for (let i = 0; i < per; i++) g.fillText(code[k++ % code.length], x + charW * (i + 0.5), y + lineH / 2);
        }
      }),
    );
  };
  if (glitch) draw(0.16, mod * 0.4);
  draw(1, 0);
  g.globalAlpha = 1;
}

/** The temple from section 03 across a 1500 × 500 banner (drawn at 2×). */
function banner(id: string) {
  const W = 3000;
  const H = 1000;
  const g = canvas(id, W, H);
  g.fillStyle = PAPER;
  g.fillRect(0, 0, W, H);
  const C = 300;
  const t = buildTemple(C, code);
  const tw = 1480; // keeps the whole temple inside the 3:1 frame, with room above and below
  const cellW = tw / C;
  const fontPx = cellW / 0.6;
  const lineH = fontPx * 1.17;
  const th = t.rows * lineH;
  const ox = (W - tw) / 2;
  const oy = (H - th) / 2;
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
  // the inscription on a clean band
  const { r0, rows } = t.frieze;
  const size = rows * lineH * 0.5;
  const text = "THE BEST OF ASCEND";
  const step = size * 0.6 * 1.85;
  const width = (text.length - 1) * step;
  const cx = W / 2;
  g.globalAlpha = 1;
  g.fillStyle = PAPER;
  g.fillRect(cx - width / 2 - step, oy + (r0 + 0.5) * lineH, width + 2 * step, (rows - 1) * lineH);
  g.fillStyle = INK_C;
  g.font = `500 ${size}px ${MONO}`;
  for (let j = 0; j < text.length; j++) g.fillText(text[j], cx - width / 2 + j * step, oy + (r0 + rows / 2) * lineH);
}

document.fonts.load(`600 20px ${MONO}`).then(() => document.fonts.load(`400 20px ${MONO}`)).then(() => {
  pfp("pfp-dark", INK_C, PAPER, false);
  pfp("pfp-dark-glitch", INK_C, PAPER, true);
  pfp("pfp-light", PAPER, INK_C, false);
  banner("banner");
  document.body.dataset.ready = "1";
});
