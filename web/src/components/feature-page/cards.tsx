"use client";

// The worked examples beside each feature page's title. Same card language as the landing page
// (receipts, rows, a stamp); values decrypt in once, then the card stays still.

import { useEffect, useState, type CSSProperties } from "react";
import { decrypt, ease, fmt, HypeMark, span, useReducedMotion } from "@/components/showcase/kit";
import s from "@/components/showcase/showcase.module.css";
import c from "./cards.module.css";

/** Milliseconds since the card mounted, until `until`. */
function useIntro(until: number) {
  const reduce = useReducedMotion();
  const [t, setT] = useState(0);
  useEffect(() => {
    if (reduce) return;
    const born = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      setT(now - born);
      if (now - born < until) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [until, reduce]);
  return reduce ? 1e9 : t;
}

/** A line that prints in: fade and settle 4px. */
function line(t: number, at: number): CSSProperties {
  const k = ease(span(t, at, at + 320));
  return { opacity: k, transform: `translateY(${(1 - k) * 4}px)` };
}
function stamp(t: number, at: number): CSSProperties {
  const k = ease(span(t, at, at + 300));
  return { opacity: k, transform: `scale(${1.15 - 0.15 * k})` };
}

function Lock() {
  return (
    <svg className={s.lock} viewBox="0 0 12 14" width="12" height="14" aria-hidden="true">
      <rect x="1" y="6" width="10" height="7" rx="1.5" />
      <path d="M3.5 6V4.2a2.5 2.5 0 0 1 5 0V6" fill="none" strokeWidth="1.4" />
    </svg>
  );
}

// ── HYPE Passport: one person's passport ──
export function PassportCard() {
  const t = useIntro(2600);
  const p = (at: number) => span(t, at, at + 500);
  return (
    <div className={s.card}>
      <div className={s.cardHead}>
        <span className={s.brandRow}>
          <HypeMark logos="mono" size={18} />
          <b>HYPE Passport</b>
        </span>
        <span className={`${s.tag} ${s.tagInk}`} style={stamp(t, 1800)}>
          TIER 2
        </span>
      </div>
      <div className={s.rows}>
        <div className={s.row} style={line(t, 150)}>
          <span className={s.muted}>Hyperliquid wallet</span>
          <span className={c.with}>
            <span className={s.num}>{p(150) > 0 ? decrypt("0x8f3a…21c4", p(150) * 1.2) : ""}</span>
            <small className={c.pill}>private</small>
          </span>
        </div>
        <div className={s.row} style={line(t, 450)}>
          <span className={s.muted}>HYPE counted</span>
          <span className={`${s.num} ${s.strong}`}>{fmt(240 * ease(p(450)))}</span>
        </div>
        <p className={c.hint} style={line(t, 650)}>
          200 staked, plus half of the 80 not staked
        </p>
        <div className={s.row} style={line(t, 850)}>
          <span className={s.muted}>Account age</span>
          <span className={s.num}>{fmt(214 * ease(p(850)))} days</span>
        </div>
      </div>
      <div className={s.rRow} style={line(t, 1200)}>
        <span>Staking boost</span>
        <span className={`${s.num} ${s.strong}`}>1.20×</span>
      </div>
      <div className={s.rRow} style={line(t, 1400)}>
        <span>Votes in the Trials (soon)</span>
        <span className={`${s.num} ${s.strong}`}>2</span>
      </div>
      <div className={c.chips} style={line(t, 1600)}>
        <span className={c.chip}>Genesis holder</span>
        <span className={c.chip}>Hypurr</span>
      </div>
      <p className={s.note} style={line(t, 2000)}>
        Only your tier and a private code go on-chain. Your address and balances stay hidden.
      </p>
    </div>
  );
}

// ── The Trials: this week's ballot ──
const CANDIDATES = [
  ["ORION", 38],
  ["IRIS", 27],
  ["THEMIS", 21],
  ["ARGO", 14],
] as const;

export function BallotCard() {
  const t = useIntro(2800);
  return (
    <div className={s.card}>
      <div className={s.cardHead}>
        <span className={s.brandRow}>
          <b>The Trials · preview</b>
        </span>
        <span className={`${s.num} ${s.muted} ${c.small}`}>closes in 2d 14h</span>
      </div>
      <p className={c.lead} style={line(t, 100)}>
        Three seats are open. Your Passport gives you <b>2 votes</b>.
      </p>
      <div className={c.ballot}>
        {CANDIDATES.map(([name, pct], i) => {
          const at = 400 + i * 180;
          const fill = ease(span(t, at, at + 700));
          const inTop = i < 3;
          return (
            <div key={name} className={c.cand} style={line(t, at)}>
              <span className={c.candName}>
                {name}
                {i === 0 && <small className={c.yours}>your vote</small>}
              </span>
              <span className={c.track}>
                <i style={{ width: `${pct * 2 * fill}%`, opacity: inTop ? 1 : 0.25 }} />
              </span>
              <span className={`${s.num} ${inTop ? s.strong : s.muted}`}>{Math.round(pct * fill)}%</span>
            </div>
          );
        })}
      </div>
      <button type="button" tabIndex={-1} className={s.outline} style={line(t, 1400)}>
        Sign your vote · free
      </button>
      <p className={s.note} style={line(t, 1700)}>
        Coming after launch. The top three will go in after 24 hours, unless the guardian vetoes one.
      </p>
    </div>
  );
}

// ── Covenant: where a fee goes ──
export function CovenantCard() {
  const t = useIntro(2800);
  const rules: [string, string][] = [
    ["Owner", "none"],
    ["Admin key", "none"],
    ["Upgrades", "none"],
  ];
  return (
    <div className={`${s.card} ${s.receipt}`}>
      <div className={s.cardHead}>
        <span className={s.brandRow}>
          <Lock />
          <b>Covenant for PNTH</b>
        </span>
        <span className={`${s.tag} ${s.tagInk}`} style={stamp(t, 2000)}>
          NO OWNER
        </span>
      </div>
      <div className={s.rRow} style={line(t, 100)}>
        <span>Fee on every trade</span>
        <span className={`${s.num} ${s.strong}`}>1%</span>
      </div>
      <div className={`${s.rRow} ${s.rSub}`} style={line(t, 300)}>
        <span>↳ half to Ascend</span>
        <span className={s.num}>0.5%</span>
      </div>
      <div className={`${s.rRow} ${s.rSub} ${s.rStrong}`} style={line(t, 500)}>
        <span>↳ half to Covenant</span>
        <span className={s.num}>0.5%</span>
      </div>
      <div className={s.dash} style={line(t, 750)} />
      <span className={s.fieldLabel} style={line(t, 800)}>
        Its jobs, set at launch
      </span>
      <div className={c.jobs}>
        <div className={c.job} style={line(t, 950)}>
          <span className={c.when}>On buys</span>
          <span>buys the basket and pays it to stakers</span>
        </div>
        <div className={c.job} style={line(t, 1150)}>
          <span className={c.when}>On sells</span>
          <span>burns PNTH for good</span>
        </div>
      </div>
      <div className={s.dash} style={line(t, 1400)} />
      <div className={s.rows}>
        {rules.map(([k, v], i) => (
          <div key={k} className={s.row} style={line(t, 1500 + i * 160)}>
            <span className={s.muted}>{k}</span>
            <span className={`${s.num} ${s.strong}`}>
              {v}
              <span className={s.okDot}>✓</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Security: every key, and what it can do ──
const KEYS: [string, string][] = [
  ["Covenant", "no owner"],
  ["Staking", "no owner"],
  ["Basket vault", "no owner"],
  ["Curator", "proposes lists"],
  ["Guardian", "can only say no"],
  ["Passport signer", "8-day certificates"],
];

export function KeysCard() {
  const t = useIntro(2800);
  return (
    <div className={`${s.card} ${s.receipt}`}>
      <div className={s.cardHead}>
        <span className={s.brandRow}>
          <Lock />
          <b>Keys and what they can do</b>
        </span>
        <span className={`${s.tag} ${s.tagInk}`} style={stamp(t, 2000)}>
          NO KEY MOVES FUNDS
        </span>
      </div>
      <div className={s.rows}>
        {KEYS.map(([k, v], i) => (
          <div key={k} className={s.row} style={line(t, 150 + i * 160)}>
            <span className={s.muted}>{k}</span>
            <span className={`${s.num} ${s.strong}`}>{v}</span>
          </div>
        ))}
      </div>
      <div className={s.dash} style={line(t, 1200)} />
      <div className={s.rRow} style={line(t, 1300)}>
        <span>Wait before a list changes</span>
        <span className={`${s.num} ${s.strong}`}>24h</span>
      </div>
      <div className={s.rRow} style={line(t, 1450)}>
        <span>Most any coin can weigh</span>
        <span className={`${s.num} ${s.strong}`}>20%</span>
      </div>
      <p className={s.note} style={line(t, 1700)}>
        Every contract we wrote is verified on the Elysium explorer.
      </p>
    </div>
  );
}
