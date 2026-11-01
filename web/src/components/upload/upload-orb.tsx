// "Get uploaded" on DELPHI's orb, from the first second: connect a wallet, sign one free message,
// DELPHI reads the wallet, and your self splits into bubbles; picking one goes on to your space. The
// orb blooms once, when the page opens, and stays: each step only changes the words and the button
// under it. One WebGL canvas draws the orb (orb-renderer.ts); its timing and the bubbles' physics are
// plain functions (orb-motion.ts). The words, buttons and the bubbles' hit areas are HTML on top.
// Rendered by UploadFlow, a client component.

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { short } from "@/components/app/shared";
import { CodeWordmark } from "@/components/code-type/code-wordmark";
import { BUBBLES, LINES, READ, T, budReach, clamp, inOut, layout, mainOrb, readRadius, simTo, smooth, voice, type BubbleDesign, type Sim, type Timeline } from "./orb-motion";
import { OrbRenderer } from "./orb-renderer";
import s from "./upload-orb.module.css";

import type { WalletChoice } from "./use-connect-wallet";

export type Picked = { index: number; design: BubbleDesign };

type Props = {
  /** The connected wallet, or null while there isn't one yet. */
  address: string | null;
  /** The wallet (or WalletConnect's window) is open, asking to connect. */
  connecting: boolean;
  /** Connecting through a wallet app: a phone, or a QR code on a computer. */
  connectViaApp: boolean;
  connectError: string | null;
  onConnect: () => void;
  /** Computers only: WalletConnect's QR code, for a wallet on a phone. Null when it isn't set up. */
  onPhoneWallet: (() => void) | null;
  /** Two or more wallets in this browser, after Connect: the user picks one. Null otherwise. */
  wallets?: WalletChoice[] | null;
  onPickWallet?: (id: string) => void;
  onCancelPick?: () => void;
  /** The signature is in: DELPHI starts reading. */
  signed: boolean;
  /** The wallet is showing the message. */
  signing: boolean;
  /** While signing in a phone wallet app, Sign stays tappable to open the app again. */
  reopen?: boolean;
  signError: string | null;
  onSign: () => void;
  onOtherWallet: () => void;
  /** A bubble was picked and the page has turned to paper. */
  onContinue: (picked: Picked) => void;
};

type Status = "connect" | "sign" | "read" | "done";
const STATUS: Record<Status, string> = {
  connect: "Connect a wallet to begin.",
  sign: "Waiting for your signature.",
  read: "DELPHI is reading your wallet.",
  done: "Your self is uploaded. Pick any bubble to continue.",
};

type Line = { text: string; at: number };

/** Every line under the orb once a wallet is connected (at `from`), with when it comes in. */
function sequence(tl: Timeline, hint: string, from: number): Line[] {
  const seq: Line[] = [{ text: "Waiting for your signature…", at: from + 0.35 }];
  const { read, split } = tl;
  if (read !== null) LINES.forEach((line, i) => seq.push({ text: `${line}…`, at: read + i * T.line }));
  if (split !== null) {
    seq.push({ text: "Your self is uploaded.", at: split + 0.6 });
    seq.push({ text: hint, at: split + 3 });
  }
  return seq;
}

function Chip({ address }: { address: string }) {
  return (
    <div className={s.chip}>
      <span className={s.bead} aria-hidden="true" />
      {short(address)}
    </div>
  );
}

export function UploadOrb({
  address,
  connecting,
  connectViaApp,
  connectError,
  onConnect,
  onPhoneWallet,
  wallets = null,
  onPickWallet,
  onCancelPick,
  signed,
  signing,
  reopen = false,
  signError,
  onSign,
  onOtherWallet,
  onContinue,
}: Props) {
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const label = useRef<HTMLDivElement>(null);
  const slotA = useRef<HTMLDivElement>(null);
  const slotB = useRef<HTMLDivElement>(null);
  const meta = useRef<HTMLDivElement>(null);
  const signBox = useRef<HTMLDivElement>(null);
  const connectBox = useRef<HTMLDivElement>(null);
  const hits = useRef<(HTMLButtonElement | null)[]>([]);
  const [status, setStatus] = useState<Status>("connect");
  // A touch screen or a mouse: unknown until the page is in the browser (the server can't tell).
  const [touch, setTouch] = useState<boolean | null>(null);
  const [still, setStill] = useState<{ x: number; y: number; d: number } | null>(null);

  // What the animation reads, kept current without restarting it.
  const live = useRef({
    t0: 0,
    tl: { read: null, split: null } as Timeline,
    hover: -1,
    pick: null as { i: number; t: number } | null,
    address: address ?? "",
    onContinue,
    /** When a wallet connected (s), and when it last went away. */
    connAt: null as number | null,
    discAt: null as number | null,
    /** The pointer is on Connect wallet: DELPHI leans in. */
    lean: false,
  });
  useEffect(() => {
    live.current.address = address ?? "";
    live.current.onContinue = onContinue;
  });

  // The signature starts the read; the bubbles come when it ends.
  useEffect(() => {
    const L = live.current;
    if (!signed || L.tl.read !== null) return;
    const read = Math.max((performance.now() - L.t0) / 1000, Math.max(L.connAt ?? 0, T.fall) + 0.6);
    L.tl = { read, split: read + READ };
  }, [signed]);

  useEffect(() => {
    const el = root.current;
    const cv = canvas.current;
    if (!el || !cv) return;
    const L = live.current;
    L.t0 = performance.now();
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let gl = OrbRenderer.create(cv);
    const fine = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
    setTouch(!fine);
    const hint = gl ? `${fine ? "Click" : "Tap"} any bubble to continue` : "Your space is ready";
    let lay = layout(el.clientWidth, el.clientHeight);
    const showStill = () => setStill(gl ? null : { x: lay.cx, y: lay.cy, d: lay.r0 * 2 });
    showStill();

    let sim: Sim | null = null;
    const B = new Float32Array(28);
    const P = new Float32Array(28);
    const Q = new Float32Array(28);
    let seq: Line[] = [];
    let seqFor = "";
    let lean = 0;
    let lastT = 0;
    const shown = ["", ""];
    let lastMeta = "";
    let lastStatus: Status = "connect";
    let continued = false;
    let raf = 0;

    const ro = new ResizeObserver(() => {
      lay = layout(el.clientWidth, el.clientHeight);
      sim = null;
      showStill();
    });
    ro.observe(el);
    const onLost = (e: Event) => e.preventDefault();
    const onRestored = () => {
      gl = OrbRenderer.create(cv);
    };
    cv.addEventListener("webglcontextlost", onLost);
    cv.addEventListener("webglcontextrestored", onRestored);

    const setSlot = (k: number, text: string, opacity: number, blur: number, y: number) => {
      const node = k === 0 ? slotA.current : slotB.current;
      if (!node) return;
      if (shown[k] !== text) {
        node.textContent = text;
        shown[k] = text;
      }
      node.style.opacity = opacity.toFixed(3);
      node.style.filter = blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : "none";
      node.style.transform = `translate(-50%, ${y.toFixed(2)}px)`;
    };

    const frame = () => {
      raf = requestAnimationFrame(frame);
      if (document.hidden) return;
      const t = (performance.now() - L.t0) / 1000;
      const dt = Math.min(Math.max(t - lastT, 0), 0.1);
      lastT = t;
      const tl = L.tl;
      // When the page turned from connecting to signing: never before the orb has bloomed.
      const conn = L.connAt === null ? null : Math.max(L.connAt, T.fall);
      const lo = lay;
      const pick = L.pick;
      const reading = tl.read !== null && t >= tl.read;
      const split = tl.split !== null && t >= tl.split;

      // ---------------------------------------------------------------- the orb and the bubbles
      const orb = mainOrb(t, tl, lo, reduced);
      if (!reduced) {
        // DELPHI leans in while the pointer is on Connect wallet, and answers once when a wallet connects.
        lean += ((L.lean && conn === null ? 1 : 0) - lean) * Math.min(1, dt * 6);
        orb.energy += 0.2 * lean;
        if (conn !== null && t >= conn && t < conn + 1.4) orb.pulse = Math.max(orb.pulse, Math.exp(-(t - conn) * 4));
      }
      let n = 0;
      let fade = reduced ? clamp(t / 0.4, 0, 1) : 1;
      let cover = 0;
      if (split && tl.split !== null) {
        sim = simTo(sim, pick ? pick.t : t, lo, tl.split, L.hover, reduced);
        n = BUBBLES.length;
        if (pick) cover = clamp((t - pick.t) / (reduced ? 0.35 : T.cover), 0, 1);
        sim.b.forEach((b, i) => {
          const d = BUBBLES[i];
          let { x, y, rr: r, s: squash } = b;
          let grid = 1;
          let think: number = d.think;
          let energy = 0.45 + 0.35 * voice(t + d.off);
          let flash = 0;
          if (pick && !reduced) {
            if (i === pick.i) {
              // The pick fills the screen, its data clears to light, and the light flashes white.
              const e = inOut(cover);
              x += (lo.w / 2 - x) * e;
              y += (lo.h / 2 - y) * e;
              r += (Math.hypot(lo.w, lo.h) * 0.62 - r) * e;
              grid = 1 - smooth(0, 0.3, cover);
              think *= 1 - smooth(0, 0.35, cover);
              energy = 0.4 + 0.3 * cover;
              squash *= 1 - cover;
              flash = smooth(0.6, 0.92, cover);
            } else {
              // The rest shrink away.
              const q = clamp((t - pick.t) / 0.65, 0, 1);
              r *= 1 - inOut(q);
              grid = 1 - q;
            }
          }
          B.set([x, y, r, d.type], i * 4);
          P.set([think, energy, squash, b.sa], i * 4);
          Q.set([d.off, flash, 0.45 + 0.3 * Math.sin(t * 0.21 + d.off), grid], i * 4);
        });
        if (pick) fade = reduced ? 1 - cover : 1 - smooth(0.9, 1, cover);
      }
      if (gl && !gl.lost) {
        gl.draw(
          { time: reduced ? 6 : t, fade, orb, mainType: 6, n, b: B, p: P, q: Q, reach: tl.split !== null ? budReach(t, tl.split, lo) : 14, full: !!pick && !reduced },
          lo.w,
          lo.h,
          // Phones draw the light at 1.5x: it's soft anyway, and the text above stays sharp.
          Math.min(window.devicePixelRatio || 1, lo.w < 640 ? 1.5 : 2),
        );
      }

      // ---------------------------------------------------------------- the words under it
      const seqKey = `${tl.read}|${tl.split}|${conn}`;
      if (seqFor !== seqKey) {
        seqFor = seqKey;
        seq = sequence(tl, hint, conn ?? T.fall);
      }
      let idx = 0;
      for (let i = 0; i < seq.length; i++) if (seq[i].at <= t) idx = i;
      const cur = seq[idx];
      const prev = idx > 0 ? seq[idx - 1] : null;
      const since = t - cur.at;
      const fadeIn = reduced ? (since >= 0 ? 1 : 0) : 1 - Math.pow(1 - clamp(since / 0.45, 0, 1), 3);
      const fadeOut = reduced ? 1 : clamp(since / 0.32, 0, 1);
      // Two lines take turns: the new one rises in out of a blur as the old one rises away.
      setSlot(idx % 2, cur.text, fadeIn, (1 - fadeIn) * 7, (1 - fadeIn) * 9);
      setSlot(1 - (idx % 2), prev ? prev.text : "", prev ? 1 - fadeOut : 0, fadeOut * 7, -fadeOut * 9);

      let metaText = "";
      if (!reading) metaText = "Free · nothing moves";
      else if (!split && tl.read !== null) metaText = `${short(L.address)} · ${Math.floor(t - tl.read)}s`;
      if (metaText !== lastMeta && meta.current) {
        meta.current.textContent = metaText;
        lastMeta = metaText;
      }

      const band = lo.h - lo.band + 34;
      const orbR = reduced ? (reading ? lo.r1 * 0.86 : lo.r0) : readRadius(t, tl, lo);
      let top = lo.cy + orbR + 42;
      if (split && tl.split !== null) {
        // Under the orb while it reads, then down below the bubbles.
        const from = lo.cy + (reduced ? lo.r1 * 0.86 : lo.r1) + 42;
        top = reduced ? band : from + (band - from) * inOut(clamp((t - tl.split) / 1.2, 0, 1));
      }
      let labelOpacity = conn === null ? 0 : reduced ? 1 : clamp((t - conn - 0.15) / 0.4, 0, 1);
      if (pick) labelOpacity *= 1 - smooth(0, 0.25, cover);
      if (label.current) {
        label.current.style.top = `${top.toFixed(1)}px`;
        label.current.style.opacity = labelOpacity.toFixed(3);
      }

      const box = signBox.current;
      if (box) {
        const show = conn === null ? 0 : tl.read === null ? (reduced ? 1 : clamp((t - conn - 0.3) / 0.4, 0, 1)) : clamp(1 - (t - tl.read) / 0.3, 0, 1);
        box.style.top = `${(lo.cy + lo.r0 + 42 + 64).toFixed(1)}px`;
        box.style.opacity = show.toFixed(3);
        box.style.visibility = show > 0.01 ? "visible" : "hidden";
      }

      // ---------------------------------------------------------------- connect, before any wallet
      const cbox = connectBox.current;
      if (cbox) {
        const back = Math.max(T.fall + 0.35, (L.discAt ?? -9) + 0.15);
        const fadeIn = reduced ? 1 : clamp((t - back) / 0.45, 0, 1);
        // Once a wallet is in they fade out; a wallet that reconnects as the page opens never shows them.
        const show = conn === null ? fadeIn : reduced ? (t < conn ? 1 : 0) : Math.min(fadeIn, clamp(1 - (t - conn) / 0.3, 0, 1));
        const rise = conn === null ? 1 - inOut(show) : 0;
        cbox.style.top = `${(lo.cy + lo.r0 + 36).toFixed(1)}px`;
        cbox.style.opacity = show.toFixed(3);
        cbox.style.transform = `translateY(${(rise * 10).toFixed(2)}px)`;
        cbox.style.visibility = show > 0.01 ? "visible" : "hidden";
      }

      // ---------------------------------------------------------------- the bubbles' hit areas
      const pickable = !!sim && split && tl.split !== null && t >= tl.split + T.splitDur - 0.4 && !pick;
      hits.current.forEach((h, i) => {
        if (!h) return;
        if (pickable && sim) {
          const b = sim.b[i];
          const r = Math.max(b.rr, 1);
          h.style.display = "block";
          h.style.width = `${2 * r}px`;
          h.style.height = `${2 * r}px`;
          h.style.transform = `translate(${(b.x - r).toFixed(1)}px, ${(b.y - r).toFixed(1)}px)`;
        } else if (h.style.display !== "none") {
          h.style.display = "none";
        }
      });

      const st: Status = split ? "done" : reading ? "read" : conn === null ? "connect" : "sign";
      if (st !== lastStatus) {
        lastStatus = st;
        setStatus(st);
      }
      if (pick && cover >= 1 && !continued) {
        continued = true;
        L.onContinue({ index: pick.i, design: BUBBLES[pick.i].design });
      }
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      cv.removeEventListener("webglcontextlost", onLost);
      cv.removeEventListener("webglcontextrestored", onRestored);
    };
  }, []);

  // A wallet comes in: the page turns to signing. It goes (or another takes its place): start over.
  const seen = useRef<string | null>(null);
  useEffect(() => {
    const L = live.current;
    const now = (performance.now() - L.t0) / 1000;
    const was = seen.current;
    seen.current = address;
    if (address === was) return;
    if (!address) {
      L.connAt = null;
      L.discAt = now;
    } else {
      L.connAt = now;
    }
    if (was) L.tl = { read: null, split: null };
  }, [address]);

  // `at` is the click's own timestamp, on the same clock as the animation.
  const pick = (i: number, at: number) => {
    const L = live.current;
    const t = (at - L.t0) / 1000;
    if (L.pick || L.tl.split === null || t < L.tl.split + T.splitDur - 0.4) return;
    L.pick = { i, t };
  };
  const hover = (i: number) => {
    live.current.hover = i;
  };
  const unhover = (i: number) => {
    if (live.current.hover === i) live.current.hover = -1;
  };

  return (
    <div ref={root} className={s.root}>
      <canvas ref={canvas} className={s.canvas} aria-hidden="true" />
      {still && <div className={s.still} style={{ left: still.x - still.d / 2, top: still.y - still.d / 2, width: still.d, height: still.d }} aria-hidden="true" />}
      <Link href="/" aria-label="PANTHEON home" className={s.logo}>
        <CodeWordmark text="PANTHEON" module={2.2} />
      </Link>
      {address ? (
        <Chip address={address} />
      ) : (
        <Link href="/" className={s.back}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path d="M8.5 3.5 5 7l3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Back to site
        </Link>
      )}
      <p className={s.sr} role="status">
        {STATUS[status]}
      </p>

      <div ref={label} className={s.label} aria-hidden="true">
        <div className={s.lines}>
          <div ref={slotA} className={s.line} />
          <div ref={slotB} className={s.line} />
        </div>
        <div ref={meta} className={s.meta} />
      </div>

      <div ref={connectBox} className={s.connect}>
        <h1 className={s.title}>Get uploaded.</h1>
        <p className={s.lede}>Connect your wallet. DELPHI reads&nbsp;it and builds a space that is yours.</p>
        {wallets ? (
          <div className={s.wallets} role="group" aria-label="Choose a wallet">
            {wallets.map((w) => (
              <button key={w.id} type="button" className={s.walletRow} onClick={() => onPickWallet?.(w.id)}>
                {w.icon ? (
                  // eslint-disable-next-line @next/next/no-img-element -- the wallet's own data-URI icon
                  <img src={w.icon} alt="" width={20} height={20} className={s.walletIcon} />
                ) : (
                  <span className={s.walletIcon} aria-hidden="true" />
                )}
                <span>{w.name}</span>
              </button>
            ))}
            <button type="button" className={s.other} onClick={onCancelPick}>
              Back
            </button>
          </div>
        ) : (
          <button
            type="button"
            className={`${s.signBtn} ${s.connectBtn}`}
            onClick={onConnect}
            disabled={connecting || !!address}
            aria-busy={connecting}
            onPointerEnter={() => (live.current.lean = true)}
            onPointerLeave={() => (live.current.lean = false)}
            onFocus={() => (live.current.lean = true)}
            onBlur={() => (live.current.lean = false)}
          >
            {connecting ? "Check your wallet…" : "Connect wallet"}
          </button>
        )}
        {connectError && (
          <p className={s.error} role="alert">
            {connectError}
          </p>
        )}
        {onPhoneWallet && touch === false && (
          <button type="button" className={s.other} onClick={onPhoneWallet} disabled={connecting || !!address}>
            Use a phone wallet
          </button>
        )}
        <p className={s.small}>
          {connecting
            ? connectViaApp
              ? touch
                ? "Approve in your wallet app, then come back to this tab."
                : "Scan the code with your phone’s wallet app."
              : "Approve the connection in your wallet."
            : wallets
              ? "Pick the wallet to connect with"
              : "Read-only · no fee · no seed phrase"}
        </p>
      </div>

      <div ref={signBox} className={s.sign}>
        <button type="button" className={s.signBtn} onClick={onSign} disabled={(signing && !reopen) || signed} aria-busy={signing}>
          {signing ? "Check your wallet…" : "Sign message"}
        </button>
        {signError && (
          <p className={s.error} role="alert">
            {signError}
          </p>
        )}
        <button type="button" className={s.other} onClick={onOtherWallet} disabled={signing || signed}>
          Use another wallet
        </button>
      </div>

      <div className={s.hits}>
        {BUBBLES.map((b, i) => (
          <button
            key={b.design}
            ref={(node) => {
              hits.current[i] = node;
            }}
            type="button"
            className={s.hit}
            aria-label={`Continue (bubble ${i + 1} of ${BUBBLES.length})`}
            onClick={(e) => pick(i, e.timeStamp)}
            onPointerEnter={() => hover(i)}
            onPointerLeave={() => unhover(i)}
            onFocus={() => hover(i)}
            onBlur={() => unhover(i)}
          />
        ))}
      </div>

      {still && status === "done" && (
        <div className={s.go}>
          <button type="button" className={s.signBtn} onClick={() => onContinue({ index: 0, design: BUBBLES[0].design })}>
            Continue
          </button>
        </div>
      )}
    </div>
  );
}

/** Where a picked bubble leads. Your space isn't built yet, so for now this page says so. */
export function UploadNext({ address }: { address: string }) {
  return (
    <div className={s.root}>
      <Chip address={address} />
      <div className={s.next}>
        <p className={s.nextTitle}>Your space opens here soon.</p>
        <p className={s.nextSub}>DELPHI has read your wallet. There’s nothing more to sign.</p>
        <Link href="/" className={s.ghost}>
          Back to site
        </Link>
      </div>
    </div>
  );
}
