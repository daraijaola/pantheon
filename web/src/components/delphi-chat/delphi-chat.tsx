"use client";

// DELPHI's chat. One orb is DELPHI. Before the first question it sits above the composer and listens:
// each key you type lifts its light. Ask, and it flies beside your question and thinks. When her answer
// streams in, it shrinks to a bead and writes it, word by word, each word inked as the orb passes over
// it; at a line's end it drops to the next line first, so it never crosses what it just wrote. Then it
// rests at the end of the answer until the next question lifts it.
// Answers stream from /api/ask-delphi (src/app/api/ask-delphi/route.ts).

import Link from "next/link";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { CodeWordmark } from "@/components/code-type/code-wordmark";
import { blocks, LABEL, nextWord, plain, shortHash, type Block, type Piece, type Verdict } from "./format";
import { AGAIN, CHECK, COPY, DOWN, PLUS, Pixels, SEND, STOP } from "./glyphs";
import { ChatOrb } from "./orb";
import s from "./delphi-chat.module.css";

type Coin = { symbol: string | null; token: string; verdict: Verdict; market: "ascend" | "kalos" | "perpme" };
type Turn = {
  id: number;
  question: string;
  /** Her answer as written on the page so far: always cut at a word. */
  text: string;
  coins: Coin[];
  /** The transactions in her data for this answer (lowercase): the only hashes drawn as proof links. */
  proofs: ReadonlySet<string>;
  status: "thinking" | "writing" | "done" | "error";
  error?: string;
  /** When it was asked (performance.now). */
  at: number;
};

const THINK_MIN = 1.4; // seconds she thinks, however fast the answer comes
const CPS = 38; // characters a second she writes at; faster only when the answer is far ahead of her
const LINE_EVERY = 2200; // ms each thinking line stays
const RECENT = 6; // earlier questions and answers sent with each question (the server keeps 12 messages at most)
const R = { hero: 56, heroPhone: 46, think: 20, pen: 7.5, rest: 7 };

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const smooth = (a: number, b: number, v: number) => {
  const x = clamp((v - a) / (b - a), 0, 1);
  return x * x * (3 - 2 * x);
};
const voice = (t: number) => clamp(0.5 + 0.32 * Math.sin(t * 2.1) * Math.sin(t * 0.73 + 1) + 0.22 * Math.sin(t * 5.3 + 0.4) * Math.sin(t * 1.7) + 0.12 * Math.sin(t * 9.1), 0, 1);

/** What she says while she thinks: about the coin, once the server has said which one it is. */
function thinking(coins: Coin[]): string[] {
  const c = coins[0]?.symbol;
  return c
    ? ["Reading the chain", `Opening ${c}’s report`, "Checking the transactions", "Linking each claim to its transaction"]
    : ["Reading the chain", "Looking through every coin", "Weighing it up"];
}

const ERRORS: Record<string, string> = {
  RATE_LIMITED: "You’re asking faster than I can read. Wait a minute, then ask again.",
  HOUR_LIMIT: "You’ve asked me a lot this hour. Wait a while, then ask again.",
  FAILED: "I couldn’t answer that just now.",
  STOPPED: "Stopped here.",
};

export function DelphiChat({ explorer, suggestions }: { explorer: string; suggestions: string[] }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [stuck, setStuck] = useState(true);
  const [copied, setCopied] = useState<number | null>(null);
  const [shared, setShared] = useState<number | null>(null);
  const [noGL, setNoGL] = useState(false);
  const [lift, setLift] = useState(0);
  const [clock, setClock] = useState(0);
  const started = turns.length > 0;
  const busy = turns.some((t) => t.status === "thinking" || t.status === "writing");

  const canvas = useRef<HTMLCanvasElement>(null);
  const bead = useRef<HTMLDivElement>(null);
  const heroSpot = useRef<HTMLDivElement>(null);
  const empty = useRef<HTMLDivElement>(null);
  const dock = useRef<HTMLDivElement>(null);
  const suggestionRow = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const page = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const spots = useRef(new Map<number, HTMLSpanElement | null>());
  const answers = useRef(new Map<number, HTMLDivElement | null>());
  const nextId = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const busyRef = useRef(false);

  // What the animation reads, kept current without restarting it.
  const live = useRef({
    turns: [] as Turn[],
    full: new Map<number, string>(), // everything received, per answer
    sigs: new Map<number, string>(), // her signature on each whole answer, sent back with it
    ended: new Set<number>(), // answers whose stream is over
    errors: new Map<number, string>(), // why an answer failed, if it did
    pen: { id: -1, end: 0, start: 0, delay: 0, dur: 0, tail: 0 },
    keys: [] as number[], // when keys were typed (seconds), so the orb can hear them
    stuck: true,
    inked: null as HTMLElement | null,
  });
  useEffect(() => {
    live.current.turns = turns;
  }, [turns]);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  const setTurn = (id: number, f: (t: Turn) => Turn) => setTurns((ts) => ts.map((t) => (t.id === id ? f(t) : t)));

  // ------------------------------------------------------------------ asking
  const ask = async (question: string, without?: number) => {
    const q = question.trim();
    if (!q || busyRef.current) return;
    busyRef.current = true;
    const id = ++nextId.current;
    const L = live.current;
    // Her earlier answers go back exactly as they came, with her signature: the server ignores any
    // answer without one, so nobody can put words in her mouth.
    const history = turns
      .filter((t) => t.status === "done" && t.id !== without)
      .slice(-RECENT)
      .flatMap((t) => [
        { role: "user" as const, content: t.question },
        { role: "assistant" as const, content: L.full.get(t.id) ?? t.text, sig: L.sigs.get(t.id) },
      ]);
    L.full.set(id, "");
    L.ended.delete(id);
    L.stuck = true;
    setStuck(true);
    setDraft("");
    setTurns((ts) => [
      ...ts.filter((t) => t.id !== without),
      { id, question: q, text: "", coins: [], proofs: new Set(), status: "thinking", at: performance.now() },
    ]);

    const ctrl = new AbortController();
    abort.current = ctrl;
    try {
      const res = await fetch("/api/ask-delphi", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [...history, { role: "user", content: q }] }),
        signal: ctrl.signal,
      });
      // Too many questions: a wait of over a minute means this hour's are used up.
      if (res.status === 429) throw new Error(Number(res.headers.get("retry-after")) > 60 ? "HOUR_LIMIT" : "RATE_LIMITED");
      if (!res.ok || !res.body) throw new Error("FAILED");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const ev = JSON.parse(line) as { type: string; text?: string; coins?: Coin[]; proofs?: string[]; sig?: string; error?: string };
          if (ctrl.signal.aborted) break;
          if (ev.type === "coins") setTurn(id, (t) => ({ ...t, coins: ev.coins ?? [], proofs: new Set(ev.proofs ?? []) }));
          else if (ev.type === "text" && ev.text) L.full.set(id, (L.full.get(id) ?? "") + ev.text);
          else if (ev.type === "done" && ev.sig) L.sigs.set(id, ev.sig);
          else if (ev.type === "error") throw new Error("FAILED");
        }
      }
      L.ended.add(id);
    } catch (err) {
      // Stopped: she finishes writing what came (or says she stopped). Failed: the loop below says so.
      L.errors.set(id, ctrl.signal.aborted ? ERRORS.STOPPED : (ERRORS[(err as Error).message] ?? ERRORS.FAILED));
      L.ended.add(id);
    } finally {
      if (abort.current === ctrl) abort.current = null;
    }
  };

  // Stop means stop: she finishes the word she's on, and nothing after it.
  const stop = () => {
    const L = live.current;
    const cur = L.turns.at(-1);
    if (cur) {
      L.full.set(cur.id, L.pen.id === cur.id ? (L.full.get(cur.id) ?? "").slice(0, L.pen.end) : "");
      // What's left isn't the answer she signed, so it won't count as hers.
      L.sigs.delete(cur.id);
      L.errors.set(cur.id, ERRORS.STOPPED);
      L.ended.add(cur.id);
    }
    abort.current?.abort();
  };

  const again = (t: Turn) => void ask(t.question, t.id);

  // Leaving the page stops the answer in flight, so the server stops the model, and its cost, too.
  useEffect(() => () => abort.current?.abort(), []);

  const newChat = () => {
    abort.current?.abort();
    const L = live.current;
    L.full.clear();
    L.sigs.clear();
    L.ended.clear();
    L.errors.clear();
    L.pen.id = -1;
    busyRef.current = false;
    setTurns([]);
    setDraft("");
    scroller.current?.scrollTo({ top: 0 });
    field.current?.focus();
  };

  const copy = async (t: Turn) => {
    try {
      await navigator.clipboard.writeText(plain(live.current.full.get(t.id) ?? t.text));
      setCopied(t.id);
      setTimeout(() => setCopied((c) => (c === t.id ? null : c)), 1600);
    } catch {
      // No clipboard here (an insecure page or a denied permission): nothing to do.
    }
  };

  const share = async (t: Turn, coin: Coin | null) => {
    const answer = plain(live.current.full.get(t.id) ?? t.text);
    const url = coin ? (coin.market === "ascend" ? `${window.location.origin}/delphi/${coin.token}` : `${explorer}/token/${coin.token}`) : window.location.href;
    const text = `${answer}\n\n${url}`;
    try {
      if (navigator.share) await navigator.share({ title: "DELPHI · PANTHEON", text: answer, url });
      else await navigator.clipboard.writeText(text);
      setShared(t.id);
      setTimeout(() => setShared((id) => (id === t.id ? null : id)), 1600);
    } catch (err) {
      if ((err as DOMException).name !== "AbortError") {
        try {
          await navigator.clipboard.writeText(text);
          setShared(t.id);
          setTimeout(() => setShared((id) => (id === t.id ? null : id)), 1600);
        } catch {
          // Sharing and clipboard access can both be denied; leave the page unchanged.
        }
      }
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    live.current.keys.push(performance.now() / 1000);
    if (live.current.keys.length > 24) live.current.keys.shift();
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void ask(draft);
    }
  };

  // The thinking line and its timer move on once a second.
  useEffect(() => {
    if (!busy) return;
    const id = setInterval(() => setClock(performance.now()), 250);
    return () => clearInterval(id);
  }, [busy]);

  // The composer grows with what you type, up to six lines.
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 22 * 6 + 4)}px`;
  }, [draft]);

  // Before the first question the composer sits under DELPHI, not at the bottom.
  useLayoutEffect(() => {
    const place = () => {
      if (started || !empty.current || !box.current) return setLift(0);
      const e = empty.current.getBoundingClientRect();
      const b = box.current.getBoundingClientRect();
      const docked = b.top + (liftRef.current || 0); // where it sits with no lift
      const tips = suggestionRow.current?.getBoundingClientRect();
      const tipsBottom = tips ? tips.bottom + (liftRef.current || 0) : b.bottom + (liftRef.current || 0);
      const bottom = (page.current?.getBoundingClientRect().bottom ?? window.innerHeight) - 12;
      setLift(Math.max(0, docked - (e.bottom + 28), tipsBottom - bottom));
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [started]);
  const liftRef = useRef(0);
  useEffect(() => {
    liftRef.current = lift;
  }, [lift]);

  // When an answer ends, bring its actions up above the composer (unless you've scrolled away).
  const last = turns.at(-1);
  const lastEnded = last && (last.status === "done" || last.status === "error") ? last.id : null;
  useEffect(() => {
    if (lastEnded == null || !live.current.stuck) return;
    const id = setTimeout(() => scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" }), 350);
    return () => clearTimeout(id);
  }, [lastEnded]);

  // Follow the answer down unless you've scrolled up to read.
  useEffect(() => {
    const sc = scroller.current;
    if (!sc) return;
    let last = sc.scrollTop;
    const onScroll = () => {
      const y = sc.scrollTop;
      const atEnd = sc.clientHeight + y >= sc.scrollHeight - 72;
      if (y < last - 2 && !atEnd) live.current.stuck = false;
      if (atEnd) live.current.stuck = true;
      last = y;
      setStuck(live.current.stuck);
    };
    sc.addEventListener("scroll", onScroll, { passive: true });
    return () => sc.removeEventListener("scroll", onScroll);
  }, []);

  // The conversation leaves room for the composer under its last line, however tall the composer is.
  useEffect(() => {
    const d = dock.current;
    const pg = page.current;
    if (!d || !pg) return;
    const set = () => pg.style.setProperty("--dock", `${Math.ceil(d.getBoundingClientRect().height)}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(d);
    return () => ro.disconnect();
  }, []);

  // ------------------------------------------------------------------ the orb and the pen
  useEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    const L = live.current;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const orb = ChatOrb.create(cv);
    if (!orb) setNoGL(true);
    const t0 = performance.now() / 1000;
    const sim = { x: 0, y: 0, r: 0, vx: 0, vy: 0, vr: 0, ready: false, last: 0, scroll: 0 };
    let raf = 0;

    // Boxes relative to the canvas, which is where the orb is drawn.
    const rect = (el: Element | null | undefined) => {
      const r = el?.getBoundingClientRect();
      if (!r) return null;
      const off = cv.getBoundingClientRect();
      return { left: r.left - off.left, right: r.right - off.left, top: r.top - off.top, width: r.width, height: r.height };
    };
    const lastPieces = (id: number) => {
      const all = answers.current.get(id)?.querySelectorAll<HTMLElement>("[data-w]");
      if (!all?.length) return [null, null] as const;
      return [all[all.length - 1], all.length > 1 ? all[all.length - 2] : null] as const;
    };
    const unink = () => {
      if (L.inked) {
        L.inked.style.maskImage = "";
        L.inked.style.webkitMaskImage = "";
        L.inked = null;
      }
    };

    const frame = () => {
      raf = requestAnimationFrame(frame);
      const nowMs = performance.now();
      const now = nowMs / 1000;
      const t = now - t0;
      const turns = L.turns;
      const cur = turns.at(-1);
      // The canvas covers the page, which is the visible viewport (100dvh): draw in its size, not
      // window.inner*, which on phones counts the browser bars differently.
      const W = cv.clientWidth || window.innerWidth;
      const H = cv.clientHeight || window.innerHeight;
      const top = cv.getBoundingClientRect().top;
      const phone = W < 640;

      // ---- the pen: give the next word when the last one is written
      if (cur && (cur.status === "thinking" || cur.status === "writing")) {
        const full = L.full.get(cur.id) ?? "";
        const ended = L.ended.has(cur.id);
        const P = L.pen;
        if (P.id !== cur.id) Object.assign(P, { id: cur.id, end: 0, start: 0, delay: 0, dur: 0, tail: 0 });
        // She thinks a moment however fast the answer comes, unless it ended with nothing to write.
        const thoughtEnough = (ended && !full.trim()) || now - cur.at / 1000 >= (reduced ? 0.2 : THINK_MIN);
        const due = P.start + P.delay + P.dur + P.tail;
        if (now >= due && thoughtEnough) {
          const w = nextWord(full, P.end, ended);
          if (w) {
            // A steady pace, character by character: the stream arrives in uneven pieces, the page
            // doesn't. She speeds up, gently (up to 1.6x), only when the answer is very far ahead of her.
            const ahead = full.length - w.end;
            const speed = 1 + clamp((ahead - 700) / 1400, 0, 0.6);
            // A transaction or an address is drawn short (0x1234…abcd), so it takes the time of what shows.
            const shown = /^0x[0-9a-fA-F]{40,64}/.test(w.word) ? 12 : w.word.length;
            const chars = Math.max(1, shown + (w.end - P.end - w.word.length));
            P.end = w.end;
            // Start where the last word ended, not where this frame landed, so the pace never drifts.
            P.start = cur.status === "thinking" ? now : Math.max(due, now - 0.05);
            P.delay = cur.status === "thinking" ? 0.45 : w.breaks ? 0.28 : 0;
            P.dur = reduced ? 0.012 : chars / (CPS * speed);
            P.tail = reduced ? 0 : (/[.!?]$/.test(w.word) ? 0.24 : /[,:;]$/.test(w.word) ? 0.1 : 0) / Math.min(speed, 2);
            const text = full.slice(0, w.end);
            setTurns((ts) => ts.map((x) => (x.id === cur.id ? { ...x, text, status: "writing" } : x)));
          } else if (ended && now >= P.start + P.delay + P.dur + 0.05) {
            const error = L.errors.get(cur.id);
            if (error) {
              setTurns((ts) => ts.map((x) => (x.id === cur.id ? { ...x, text: full.slice(0, Math.max(P.end, full.trimEnd().length)), status: "error", error } : x)));
            } else if (full.trim()) {
              setTurns((ts) => ts.map((x) => (x.id === cur.id ? { ...x, text: full.slice(0, Math.max(P.end, full.trimEnd().length)), status: "done" } : x)));
            } else {
              setTurns((ts) => ts.map((x) => (x.id === cur.id ? { ...x, status: "error", error: ERRORS.FAILED } : x)));
            }
          }
        }
      }

      // ---- where the orb wants to be
      let tx = W / 2;
      let ty = H * 0.3;
      let tr = phone ? R.heroPhone : R.hero;
      let mode: "hero" | "think" | "pen" | "rest" = "hero";
      let ink = 0;
      let inkEl: HTMLElement | null = null;
      if (!cur) {
        const h = rect(heroSpot.current);
        if (h) {
          tx = h.left + h.width / 2;
          ty = h.top + h.height / 2;
          tr = h.width / 2;
        }
      } else {
        const P = L.pen;
        const [el, prev] = lastPieces(cur.id);
        const spot = rect(spots.current.get(cur.id));
        if ((cur.status === "thinking" || (cur.status === "writing" && !el)) && spot) {
          mode = "think";
          tx = spot.left + spot.width / 2;
          ty = spot.top + spot.height / 2;
          tr = R.think;
        } else if (!el && spot) {
          mode = "rest";
          tx = spot.left + spot.width / 2;
          ty = spot.top + spot.height / 2;
          tr = R.rest;
        } else if (el) {
          const r = rect(el);
          const p = rect(prev);
          if (r) {
            const writing = cur.status === "writing";
            mode = writing ? "pen" : "rest";
            tr = writing ? R.pen : R.rest;
            ink = writing ? clamp((now - P.start - P.delay) / Math.max(P.dur, 0.001), 0, 1) : 1;
            const sameLine = !!p && Math.abs(p.top + p.height / 2 - (r.top + r.height / 2)) < 4 && el.dataset.kind === "word";
            tx = (writing && sameLine ? r.left + r.width * ink : r.right) + 5 + tr;
            ty = r.top + r.height / 2;
            if (writing && sameLine && !reduced) inkEl = el;
          }
        }
      }

      // ---- the ink: the word being written shows up to the orb
      if (inkEl !== L.inked) unink();
      if (inkEl && ink < 1) {
        const m = `linear-gradient(90deg, #000 ${(ink * 118 - 18).toFixed(1)}%, transparent ${(ink * 118 + 4).toFixed(1)}%)`;
        inkEl.style.maskImage = m;
        inkEl.style.webkitMaskImage = m;
        L.inked = inkEl;
      } else if (inkEl) unink();

      // ---- springs; on the line it's writing it follows the pen exactly
      const dt = sim.last ? Math.min(0.05, now - sim.last) : 1 / 60;
      sim.last = now;
      // Scrolling carries the orb with the page, so it never trails what it sits on. A jump of more
      // than a screen (a new chat) isn't carried: the orb just glides to its new place.
      const scrollY = scroller.current?.scrollTop ?? 0;
      if (sim.ready && Math.abs(scrollY - sim.scroll) < H) sim.y -= scrollY - sim.scroll;
      sim.scroll = scrollY;
      if (!sim.ready || reduced) Object.assign(sim, { x: tx, y: ty, r: tr, vx: 0, vy: 0, vr: 0, ready: true });
      else {
        const steps = Math.max(1, Math.round(dt / (1 / 120)));
        const h = dt / steps;
        for (let i = 0; i < steps; i++) {
          // Calm glides between places; tight only while it follows the pen.
          const wx = mode === "pen" ? 26 : 8.5;
          const wy = mode === "pen" ? 36 : 8.5;
          sim.vr += (56 * (tr - sim.r) - 15 * sim.vr) * h;
          sim.r += sim.vr * h;
          if (mode === "pen" && Math.abs(ty - sim.y) < 1.5 && Math.abs(sim.vy) < 40) {
            sim.vx += ((tx - sim.x) / h - sim.vx) * 0.25;
            sim.x = tx;
            sim.vy = 0;
            sim.y = ty;
          } else {
            sim.vx += (wx * wx * (tx - sim.x) - 2 * wx * sim.vx) * h;
            sim.vy += (wy * wy * (ty - sim.y) - 2 * wy * sim.vy) * h;
            sim.x += sim.vx * h;
            sim.y += sim.vy * h;
          }
        }
      }

      // ---- keep the pen in view while she writes, unless you've scrolled up
      if (L.stuck && cur && (cur.status === "thinking" || cur.status === "writing")) {
        const dockTop = (dock.current?.querySelector<HTMLElement>("[data-composer]")?.getBoundingClientRect().top ?? H + top) - top;
        const over = ty + 48 - dockTop;
        if (over > 0 && scroller.current) scroller.current.scrollTop += Math.ceil(over * (reduced ? 1 : 0.18));
      }

      // ---- how the light behaves
      let think = 0;
      let energy = 0.16 + 0.18 * voice(t);
      let pulse = 0;
      const kick = L.keys.reduce((k, at) => Math.max(k, Math.exp(-(now - at) * 7)), 0);
      if (mode === "think" && cur) {
        think = smooth(cur.at / 1000 + 0.15, cur.at / 1000 + 1.3, now);
        energy = 0.5 + 0.3 * voice(t);
        pulse = Math.exp(-(((now - cur.at / 1000) % 1.8) * 3));
      } else if (mode === "pen") {
        energy = 0.62 + 0.36 * voice(t * 1.6);
      } else if (mode === "rest") {
        energy = 0.12 + 0.1 * voice(t * 0.7) + 0.5 * kick;
      } else {
        energy += 0.45 * kick;
      }
      const speed = Math.hypot(sim.vx, sim.vy);
      const state = {
        x: sim.x,
        y: sim.y,
        r: Math.max(sim.r, 0.5),
        think,
        energy,
        pulse,
        stretch: reduced ? 0 : clamp(speed / 4500, 0, 0.12),
        angle: Math.atan2(sim.vy, sim.vx),
        time: reduced ? 6 : t,
        fade: 1,
      };
      if (orb && !orb.lost) orb.draw(state, W, H, Math.min(window.devicePixelRatio || 1, phone ? 1.5 : 2));
      else if (bead.current) {
        bead.current.style.transform = `translate(${(state.x - state.r).toFixed(1)}px, ${(state.y - state.r + top).toFixed(1)}px)`;
        bead.current.style.width = bead.current.style.height = `${(state.r * 2).toFixed(1)}px`;
      }
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      unink();
    };
  }, []);

  // ------------------------------------------------------------------ the page
  const cur = turns.at(-1);
  const announce = !cur ? "" : cur.status === "thinking" || cur.status === "writing" ? "DELPHI is answering." : cur.status === "error" ? (cur.error ?? "") : plain(cur.text);

  return (
    <div ref={page} className={s.page} data-started={started || undefined}>
      <canvas ref={canvas} className={s.orb} aria-hidden="true" />
      {noGL && <div ref={bead} className={s.bead} aria-hidden="true" />}

      <header className={s.header}>
        <Link href="/" aria-label="PANTHEON home" className={s.logo}>
          <CodeWordmark text="PANTHEON" module={2.2} />
        </Link>
        <button type="button" className={s.newChat} onClick={newChat} tabIndex={started ? 0 : -1} aria-hidden={!started}>
          <Pixels d={PLUS} size={12} />
          New chat
        </button>
      </header>

      <div ref={scroller} className={s.scroller}>
      <main className={s.main}>
        <div ref={empty} className={s.empty} aria-hidden={started}>
          <div ref={heroSpot} className={s.heroSpot} />
          <h1 className={s.title}>Ask DELPHI about any coin.</h1>
          <p className={s.sub}>She reads every coin on Ascend, Kalos and PerpMe, and answers only from what she found on-chain.</p>
        </div>

        <ol className={s.thread} aria-label="Conversation with DELPHI">
          {turns.map((t, i) => {
            const lines = thinking(t.coins);
            const since = Math.max(0, clock - t.at);
            const secs = Math.floor(since / 1000);
            const line = lines[Math.min(lines.length - 1, Math.floor(since / LINE_EVERY))];
            const one = t.coins.length === 1 ? t.coins[0] : null;
            return (
              <li key={t.id} className={s.turn}>
                <div className={s.you}>
                  <p className={s.bubble}>{t.question}</p>
                </div>
                <div className={s.delphi} aria-busy={t.status === "thinking" || t.status === "writing"}>
                  <div className={s.think} data-on={t.status === "thinking" || undefined} aria-hidden="true">
                    <span
                      className={s.spot}
                      ref={(el) => {
                        spots.current.set(t.id, el);
                      }}
                    />
                    <span key={line} className={s.thinkLine}>
                      {line}…
                    </span>
                    <span className={s.timer}>{secs}s</span>
                  </div>
                  <div
                    className={s.answer}
                    ref={(el) => {
                      answers.current.set(t.id, el);
                    }}
                  >
                    {blocks(t.text, t.proofs).map((b, j) => (
                      <BlockView key={j} b={b} explorer={explorer} />
                    ))}
                  </div>
                  {t.status === "error" &&
                    (t.error === ERRORS.STOPPED ? (
                      <p className={s.stopped}>{t.error}</p>
                    ) : (
                      <p className={s.error} role="alert">
                        {t.error}
                      </p>
                    ))}
                  {(t.status === "done" || t.status === "error") && (
                    <div className={s.actions}>
                      {t.status === "done" && (
                        <button type="button" className={s.action} onClick={() => void copy(t)}>
                          <Pixels d={copied === t.id ? CHECK : COPY} size={12} />
                          {copied === t.id ? "Copied" : "Copy"}
                        </button>
                      )}
                      {t.status === "done" && (
                        <button type="button" className={s.action} onClick={() => void share(t, one)}>
                          {shared === t.id ? "Shared" : "Share"}
                        </button>
                      )}
                      {one && t.status === "done" &&
                        (one.market === "ascend" ? (
                          <Link href={`/delphi/${one.token}`} className={s.action}>
                            Full report ↗
                          </Link>
                        ) : (
                          <a href={`${explorer}/token/${one.token}`} className={s.action} target="_blank" rel="noreferrer">
                            View token ↗
                          </a>
                        ))}
                      {one && t.status === "done" && (
                        <Link href={`/delphi/dispute?token=${one.token}`} className={s.action}>
                          Dispute
                        </Link>
                      )}
                      {i === turns.length - 1 && (
                        <button type="button" className={s.action} onClick={() => again(t)}>
                          <Pixels d={AGAIN} size={12} />
                          Try again
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      </main>
      </div>

      {started && !stuck && (
        <button type="button" className={s.latest} onClick={() => scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" })} aria-label="Jump to the latest">
          <Pixels d={DOWN} size={12} />
        </button>
      )}

      <div ref={dock} className={s.dock} style={{ transform: lift ? `translateY(${-lift}px)` : undefined }}>
        <div ref={box} className={s.composer} data-composer>
          <textarea
            ref={field}
            className={s.field}
            rows={1}
            value={draft}
            placeholder={started ? "Ask a follow-up" : "Ask about a coin, a ticker or an address"}
            aria-label="Ask DELPHI"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
            enterKeyHint="send"
            autoFocus
          />
          {busy ? (
            <button type="button" className={s.send} onClick={stop} aria-label="Stop">
              <Pixels d={STOP} size={12} />
            </button>
          ) : (
            <button type="button" className={s.send} onClick={() => void ask(draft)} disabled={!draft.trim()} aria-label="Send">
              <Pixels d={SEND} size={14} />
            </button>
          )}
        </div>
        <div ref={suggestionRow} className={s.suggestions} aria-hidden={started}>
          {suggestions.map((q) => (
            <button key={q} type="button" className={s.suggestion} onClick={() => void ask(q)} tabIndex={started ? -1 : 0}>
              {q}
            </button>
          ))}
        </div>
      </div>

      <p className={s.sr} role="status" aria-live="polite">
        {announce}
      </p>
    </div>
  );
}

function BlockView({ b, explorer }: { b: Block; explorer: string }) {
  const Tag = b.kind === "head" ? "p" : b.kind === "label" ? "p" : b.kind === "point" ? "div" : "p";
  return (
    <Tag className={s[b.kind]}>
      {b.pieces.map((p, i) => (
        <PieceView key={p.n} p={p} explorer={explorer} space={i < b.pieces.length - 1} />
      ))}
      {b.proof.length > 0 && (
        <span className={s.proof}>
          {b.proof.map((p) => (
            <PieceView key={p.n} p={p} explorer={explorer} space={false} />
          ))}
        </span>
      )}
    </Tag>
  );
}

function PieceView({ p, explorer, space }: { p: Piece; explorer: string; space: boolean }) {
  const gap = space ? " " : null;
  if (p.kind === "verdict")
    return (
      <>
        <span data-w={p.n} data-kind="verdict" className={`${s.pill} ${s[p.verdict]}`}>
          {LABEL[p.verdict]}
        </span>
        {gap}
      </>
    );
  if (p.kind === "tx")
    return (
      <a data-w={p.n} data-kind="tx" className={s.tx} href={`${explorer}/tx/${p.hash}`} target="_blank" rel="noreferrer">
        {shortHash(p.hash)} ↗
      </a>
    );
  if (p.kind === "address")
    return (
      <>
        <a data-w={p.n} data-kind="address" className={s.address} href={`${explorer}/address/${p.address}`} target="_blank" rel="noreferrer">
          {shortHash(p.address)}
        </a>
        {gap}
      </>
    );
  return (
    <>
      <span data-w={p.n} data-kind="word" className={s.word}>
        {p.text}
      </span>
      {gap}
    </>
  );
}
