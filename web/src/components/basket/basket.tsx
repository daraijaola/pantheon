"use client";

// Section 03 · The basket. The page's closing image: the Pantheon drawn in our contract code,
// one column per coin in the basket. Every few seconds a vote swaps one of the three voted-in
// coins (its column glitches, falls and rises again with the new name). Then the two actions.

import { useEffect, useRef } from "react";
import { advanceRatio, cssColor, fitCanvas, monoFamily, prefersReducedMotion, SCRAMBLE, watchActive } from "@/components/code-type/runtime";
import A from "next/link";
import { decrypt, ease, HypeMark, span, type Logos } from "@/components/showcase/kit";
import sc from "@/components/showcase/showcase.module.css";
import b from "./basket.module.css";
import { buildTemple, COLUMNS, INK, type Temple } from "./temple";

type Coin = { name: string; weight: number; alt?: string }; // alt = the coin a vote swaps in
const COINS: Coin[] = [
  { name: "HELIOS", weight: 18 },
  { name: "AETHER", weight: 15 },
  { name: "NYX", weight: 13 },
  { name: "KRONOS", weight: 10 },
  { name: "ATLAS", weight: 9, alt: "ORION" },
  { name: "SELENE", weight: 8 },
  { name: "EOS", weight: 7, alt: "IRIS" },
  { name: "HYPERION", weight: 7 },
  { name: "THEIA", weight: 7 },
  { name: "RHEA", weight: 6, alt: "THEMIS" },
];
const VOTED = COINS.flatMap((c, i) => (c.alt ? [i] : []));
const INSCRIPTION = "THE BEST OF ASCEND";

const CELL_W = 3.7; // target character width (about The Touch's); the grid has 180–300 columns
const FPS = 24;
const BUILD = 1500; // the temple rises from the steps to the apex
const JITTER = 160;
const DECRYPT = 240; // each character scrambles this long before it settles
const SETTLED = BUILD + JITTER + DECRYPT + 400; // from here on, frames copy the finished building
const FIRST_VOTE = 3800; // after the build
const VOTE_EVERY = 6500;
// One vote: glitch, fall (top to bottom), rise again (bottom to top) with the new name.
const GLITCH = 450;
const FALL = 400;
const RISE = 800;
const VOTE_LEN = GLITCH + FALL + RISE;

export function Basket({ code, logos = "mono" }: { code: string; logos?: Logos }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nameRefs = useRef<(HTMLElement | null)[]>([]);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;

    const reduce = prefersReducedMotion();
    const ink = cssColor("--color-ink", "#171717");
    const paper = cssColor("--color-paper", "#f9f9f9");
    const scramble = () => SCRAMBLE[(Math.random() * SCRAMBLE.length) | 0];
    let family = monoFamily();
    let ctx = canvas.getContext("2d")!;
    // The finished building is drawn once into `still`; frames copy it and redraw only what moves.
    const still = document.createElement("canvas");
    let sctx = still.getContext("2d")!;
    let stillKey = "";
    let temple: Temple | null = null;
    let reveal: number[] = [];
    let near: number[][] = []; // per column: the cells a vote redraws (column, capital and the porch around it)
    let W = 0;
    let H = 0;
    let cellW = 0;
    let lineH = 0;
    let fontPx = 0;
    let builtAt = -1; // when the build started (first time on screen)
    let active = false;
    let raf = 0;
    let last = 0;
    // How many times each voted column has been swapped (odd = showing its other coin).
    const gen = new Array<number>(COLUMNS).fill(0);
    const nameOf = (i: number, g = gen[i]) => (g % 2 && COINS[i].alt ? COINS[i].alt! : COINS[i].name);

    const layout = () => {
      W = wrap.clientWidth;
      const C = Math.max(180, Math.min(300, Math.round(W / CELL_W)));
      cellW = W / C;
      fontPx = cellW / advanceRatio(ctx, family, 400);
      lineH = fontPx * 1.17;
      temple = buildTemple(C, code);
      const { rows: R, cells, partRows, partCols } = temple;
      H = R * lineH;
      reveal = cells.map((q) => ((R - 1 - q.r) / (R - 1)) * BUILD + Math.random() * JITTER);
      near = partCols.map(([c0, c1]) =>
        cells.flatMap((q, i) => (q.r >= partRows.top && q.r <= partRows.bottom && q.c >= c0 - 4 && q.c <= c1 + 4 ? [i] : [])),
      );
      ctx = fitCanvas(canvas, W, H);
      sctx = fitCanvas(still, W, H);
      stillKey = "";
      wrap.querySelectorAll<HTMLElement>("[data-slot]").forEach((el) => {
        el.style.left = `${temple!.columnX[Number(el.dataset.slot)] * 100}%`;
      });
    };

    const charOf = (i: number) => {
      const q = temple!.cells[i];
      // A swapped-in coin's column is built from a different stretch of the contract.
      return !q.line && q.part >= 0 && gen[q.part] % 2 ? code[(i * 7 + 131) % code.length] : q.ch;
    };

    const cell = (g: CanvasRenderingContext2D, i: number, ch: string, d: number, dx = 0, fade = 1) => {
      const q = temple!.cells[i];
      const x = q.c * cellW + dx;
      const y = q.r * lineH;
      if (q.line) {
        g.globalAlpha = fade;
        g.fillStyle = ink;
      } else if (d >= INK) {
        g.globalAlpha = fade;
        g.fillStyle = ink;
        g.fillRect(x, y, cellW + 0.4, lineH + 0.4);
        g.globalAlpha = 0.42 * fade;
        g.fillStyle = paper;
      } else {
        g.globalAlpha = Math.min(1, d * 1.05) * fade;
        g.fillStyle = ink;
      }
      g.fillText(ch, x + cellW / 2, y + lineH / 2);
    };

    const font = (g: CanvasRenderingContext2D) => {
      g.font = `400 ${fontPx}px ${family}`;
      g.textAlign = "center";
      g.textBaseline = "middle";
    };

    // The inscription on the frieze, on a clean band, letter-spaced like a carving.
    const inscription = (g: CanvasRenderingContext2D, p: number) => {
      if (p <= 0 || !temple) return;
      const { r0, rows } = temple.frieze;
      const size = Math.max(10, rows * lineH * 0.5);
      const text = decrypt(INSCRIPTION, p * 1.25);
      const step = size * 0.6 * 1.85;
      const width = (text.length - 1) * step;
      const x0 = W / 2 - width / 2;
      const y = (r0 + rows / 2) * lineH;
      g.globalAlpha = 1;
      g.fillStyle = paper;
      g.fillRect(x0 - step, (r0 + 0.5) * lineH, width + 2 * step, (rows - 1) * lineH);
      g.font = `500 ${size}px ${family}`;
      g.fillStyle = ink;
      g.globalAlpha = ease(p);
      for (let j = 0; j < text.length; j++) g.fillText(text[j], x0 + j * step, y);
      font(g);
    };

    const renderStill = () => {
      const key = `${W}|${gen.join("")}`;
      if (key === stillKey || !temple) return;
      stillKey = key;
      sctx.clearRect(0, 0, W, H);
      font(sctx);
      temple.cells.forEach((q, i) => cell(sctx, i, charOf(i), q.d));
      inscription(sctx, 1);
      sctx.globalAlpha = 1;
    };

    /** The vote in progress at time t (ms since the build started), if any. */
    const voteAt = (t: number) => {
      const since = t - BUILD - FIRST_VOTE;
      if (reduce || since < 0) return null;
      const n = Math.floor(since / VOTE_EVERY);
      return { slot: VOTED[n % VOTED.length], round: n, ts: since - n * VOTE_EVERY };
    };

    const draw = (now: number) => {
      if (!temple) return;
      const t = reduce ? 1e9 : builtAt < 0 ? -1 : now - builtAt;
      const vote = voteAt(t);
      if (vote) {
        VOTED.forEach((i, k) => {
          const done = vote.round >= k ? Math.floor((vote.round - k) / VOTED.length) + 1 : 0;
          gen[i] = done - (i === vote.slot && vote.ts < GLITCH + FALL ? 1 : 0);
        });
      }
      ctx.clearRect(0, 0, W, H);
      font(ctx);

      if (t < SETTLED) {
        // The build: rows appear from the steps up, each character decrypting as it lands.
        if (t >= 0)
          temple.cells.forEach((q, i) => {
            const tr = t - reveal[i];
            if (tr >= 0) cell(ctx, i, tr < DECRYPT && !q.line ? scramble() : q.ch, q.d);
          });
        inscription(ctx, span(t, BUILD * 0.55, BUILD * 0.55 + 700));
      } else {
        renderStill();
        ctx.globalAlpha = 1;
        ctx.drawImage(still, 0, 0, W, H);
        // A calm flicker: a few characters re-encrypt for a frame.
        if (!reduce) {
          const n = temple.cells.length;
          for (let f = 0; f < Math.ceil(n * 0.0007); f++) {
            const i = (Math.random() * n) | 0;
            const q = temple.cells[i];
            if (q.line) continue;
            ctx.clearRect(q.c * cellW, q.r * lineH, cellW, lineH);
            cell(ctx, i, scramble(), q.d);
          }
        }
        // A vote: the column glitches, falls away from the top, then rises again as the new coin.
        if (vote && vote.ts < VOTE_LEN) {
          const { slot, ts } = vote;
          const [c0, c1] = temple.partCols[slot];
          const { top, bottom } = temple.partRows;
          ctx.clearRect((c0 - 4) * cellW, top * lineH, (c1 - c0 + 9) * cellW, (bottom - top + 1) * lineH);
          const shift = new Map<number, number>();
          for (const i of near[slot]) {
            const q = temple.cells[i];
            if (q.part !== slot) {
              cell(ctx, i, q.ch, q.d);
              continue;
            }
            const fromTop = (q.r - top) / (bottom - top);
            let shown = true;
            let ch = charOf(i);
            let dx = 0;
            let fade = 1;
            if (ts < GLITCH + FALL) {
              if (ts >= GLITCH && fromTop < (ts - GLITCH) / FALL) shown = false;
              if (!shift.has(q.r)) shift.set(q.r, Math.random() < 0.3 ? (Math.random() < 0.5 ? -1 : 1) * (1 + ((Math.random() * 3) | 0)) : 0);
              dx = shift.get(q.r)! * cellW;
              if (!q.line && Math.random() < 0.35) ch = scramble();
              fade = 0.55 + 0.45 * Math.random();
            } else {
              const p = (ts - GLITCH - FALL) / RISE;
              if (1 - fromTop > p) shown = false;
              else if (!q.line && 1 - fromTop > p - 0.18) ch = scramble();
            }
            if (shown) cell(ctx, i, ch, q.d, dx, fade);
            else if (q.behind >= 0.06) cell(ctx, i, q.ch, q.behind);
          }
        }
      }
      ctx.globalAlpha = 1;

      // Coin names under the columns: decrypt in after the build; a vote re-types one.
      const lp = reduce ? 1 : span(t, BUILD, BUILD + 700);
      COINS.forEach((_, i) => {
        let text = lp >= 1 ? nameOf(i) : lp > 0 ? decrypt(nameOf(i), lp) : "";
        if (vote && i === vote.slot && vote.ts < VOTE_LEN) {
          const { ts } = vote;
          if (ts < GLITCH) text = decrypt(nameOf(i), 1 - (ts / GLITCH) * 0.5);
          else text = decrypt(nameOf(i, gen[i] + (ts < GLITCH + FALL ? 1 : 0)), span(ts, GLITCH, GLITCH + FALL + RISE * 0.6));
        }
        for (const el of [nameRefs.current[i], nameRefs.current[i + COLUMNS]]) if (el && el.textContent !== text) el.textContent = text;
      });
      wrap.dataset.voting = vote && vote.ts < VOTE_LEN ? String(vote.slot) : "";
      wrap.dataset.ready = lp > 0 ? "1" : "";
    };

    const tick = (now: number) => {
      raf = 0;
      if (!active) return;
      if (now - last >= 1000 / FPS) {
        last = now;
        draw(now);
      }
      raf = requestAnimationFrame(tick);
    };
    const start = () => {
      if (!raf && active && temple && !reduce) raf = requestAnimationFrame(tick);
    };

    let cancelled = false;
    document.fonts
      .load(`400 8px ${family}`)
      .catch(() => [])
      .then(() => {
        if (cancelled) return;
        family = monoFamily();
        layout();
        draw(performance.now());
        start();
      });

    // The build starts the first time a good part of the temple is on screen.
    const seen = new IntersectionObserver(
      ([e]) => {
        if (!e.isIntersecting || builtAt >= 0) return;
        builtAt = performance.now();
        seen.disconnect();
      },
      { threshold: 0.3 },
    );
    seen.observe(wrap);
    const ro = new ResizeObserver(() => {
      if (!temple || wrap.clientWidth === W) return;
      layout();
      draw(performance.now());
    });
    ro.observe(wrap);
    const stopWatch = watchActive(wrap, (on) => {
      active = on;
      start();
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      seen.disconnect();
      ro.disconnect();
      stopWatch();
    };
  }, [code]);

  const label = (i: number) => (
    <>
      <b ref={(el) => void (nameRefs.current[i] = el)}>{COINS[i].name}</b>
      <small>
        {COINS[i].alt && <HypeMark logos={logos} size={11} />}
        {COINS[i].weight}%
      </small>
    </>
  );

  return (
    <section id="basket" className={sc.section} aria-labelledby="basket-title">
      <header className={sc.head}>
        <p className={sc.eyebrow}>
          <span>{"//"}</span> The basket <span>{"\\\\"}</span>
        </p>
        <h2 id="basket-title" className={sc.h2}>
          Up to ten coins hold it up.
          <br />
          <span>Earned, not bought.</span>
        </h2>
        <p className={sc.sub}>
          They earn their place by trading on Ascend, and a coin DELPHI flags can never get in. Soon, HYPE Passport holders will vote three in each week. No coin can be more than 20%.
        </p>
      </header>

      <div className={b.stage}>
        <div ref={wrapRef} className={b.temple}>
          <canvas ref={canvasRef} className={b.canvas} aria-hidden="true" />
          <ol className={b.labels} aria-label="Example basket">
            {COINS.map((c, i) => (
              <li key={c.name} className={b.label} style={{ left: `${((i + 0.5) / COLUMNS) * 84 + 8}%` }} data-slot={i}>
                {label(i)}
              </li>
            ))}
          </ol>
        </div>
        <ol className={b.list} aria-hidden="true">
          {COINS.map((c, i) => (
            <li key={c.name} data-slot={i}>
              <b ref={(el) => void (nameRefs.current[i + COLUMNS] = el)}>{c.name}</b>
              <small>
                {c.alt && <HypeMark logos={logos} size={11} />}
                {c.weight}%
              </small>
            </li>
          ))}
        </ol>
        <p className={b.key}>
          Example basket. <HypeMark logos={logos} size={12} /> marks the seats HYPE Passport holders will vote on.
        </p>
      </div>

      <div className={b.cta}>
        <A className={b.btnInk} href="/get">
          Get $PNTH
        </A>
        <A className={b.btnGhost} href="/passport/get">
          Get a HYPE Passport
        </A>
      </div>
    </section>
  );
}
