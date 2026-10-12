"use client";

// Section 02 · What you get. Four steps on the left; on the right, a live preview of that moment in the app.

import type { CSSProperties } from "react";
import { AscendMark, AscendWordmark, decrypt, ease, fmt, HypeMark, PMark, span, TokenChip, type Logos } from "@/components/showcase/kit";
import { Showcase, type ShowcaseStep } from "@/components/showcase/showcase";
import s from "@/components/showcase/showcase.module.css";

// ───────────────────────── the four app previews ─────────────────────────
function BuyCard({ t, logos }: { t: number; logos: Logos }) {
  const typed = "100".slice(0, Math.floor(span(t, 250, 700) * 3 + 0.0001));
  const out = span(t, 750, 1350);
  const pressed = t > 1550 && t < 1780;
  const done = span(t, 1850, 2150);
  return (
    <div className={s.card}>
      <div className={s.cardHead}>
        <span className={s.brandRow}>
          <AscendMark logos={logos} size={18} />
          <AscendWordmark size={15} />
        </span>
        <span className={s.muted}>Swap</span>
      </div>
      <div className={s.field}>
        <span className={s.fieldLabel}>You pay</span>
        <span className={s.fieldRow}>
          <span className={s.amount}>
            {typed || <span className={s.placeholder}>0</span>}
            {t < 800 && <span className={s.caret} />}
          </span>
          <TokenChip logo={logos === "mono" ? "/brand/usdc-mono.svg" : "/brand/usdc.svg"} label="USDC" />
        </span>
      </div>
      <div className={s.swapArrow} aria-hidden="true">
        ↓
      </div>
      <div className={s.field}>
        <span className={s.fieldLabel}>You get</span>
        <span className={s.fieldRow}>
          <span className={s.amount} style={{ opacity: out > 0 ? 1 : 0.25 }}>
            {out > 0 ? decrypt("10,000", out * 1.2) : "0"}
          </span>
          <TokenChip icon={<PMark size={11} />} label="PNTH" />
        </span>
      </div>
      <button className={`${s.primary} ${pressed ? s.pressed : ""}`} tabIndex={-1}>
        Swap
      </button>
      <div className={s.toast} style={{ opacity: done, transform: `translateY(${(1 - ease(done)) * 6}px)` }}>
        <span className={s.check}>✓</span> You bought 10,000 PNTH
      </div>
    </div>
  );
}

function StakeCard({ t }: { t: number }) {
  const fill = ease(span(t, 350, 1100));
  const pressed = t > 1300 && t < 1520;
  const move = ease(span(t, 1550, 2350));
  const lock = span(t, 2400, 2800);
  return (
    <div className={s.card}>
      <div className={s.cardHead}>
        <span className={s.brandRow}>
          <PMark size={15} />
          <b>Stake PNTH</b>
        </span>
        <span className={s.muted}>{fmt(fill * 100)}%</span>
      </div>
      <div className={s.rows}>
        <div className={s.row}>
          <span className={s.muted}>In your wallet</span>
          <span className={s.num}>{fmt(10000 * (1 - move))} PNTH</span>
        </div>
        <div className={s.row}>
          <span>Staked</span>
          <span className={`${s.num} ${s.strong}`}>{fmt(10000 * move)} PNTH</span>
        </div>
      </div>
      <div className={s.slider}>
        <span className={s.sliderFill} style={{ width: `${fill * 100}%` }} />
        <span className={s.sliderKnob} style={{ left: `${fill * 100}%` }} />
      </div>
      <button className={`${s.primary} ${pressed ? s.pressed : ""}`} tabIndex={-1}>
        {move >= 1 ? "Staked" : "Stake"}
      </button>
      <div className={s.note} style={{ opacity: lock }}>
        <svg className={s.lock} viewBox="0 0 12 14" width="12" height="14" aria-hidden="true">
          <rect x="1" y="6" width="10" height="7" rx="1.5" />
          <path d="M3.5 6V4.2a2.5 2.5 0 0 1 5 0V6" fill="none" strokeWidth="1.4" />
        </svg>
        Leave any time. Your PNTH unlocks 3 days after you ask.
      </div>
    </div>
  );
}

const BASKET = [
  ["HELIOS", 18],
  ["AETHER", 15],
  ["NYX", 13],
  ["ARGO", 10],
  ["THEMIS", 9],
  ["IRIS", 8],
] as const;

function EarnCard({ t }: { t: number }) {
  // Each coin accrues at a rate set by its basket weight; one row lights up as a payment lands.
  const flashRow = Math.floor(t / 900) % BASKET.length;
  const flash = 1 - span(t % 900, 0, 650);
  return (
    <div className={s.card}>
      <div className={s.cardHead}>
        <b>Your earnings</b>
        <span className={s.live}>
          <span className={s.liveDot} /> live
        </span>
      </div>
      <div className={s.coins}>
        {BASKET.map(([name, w], i) => {
          const amount = 0.04 * w + (t / 1000) * w * 0.0021;
          const lit = i === flashRow && t > 300 ? flash : 0;
          return (
            <div key={name} className={s.coin} style={{ "--lit": lit } as CSSProperties}>
              <span className={s.coinIcon}>{name[0]}</span>
              <span className={s.coinName}>{name}</span>
              <span className={s.plus} style={{ opacity: lit }}>
                +{fmt(w * 0.0019, 4)}
              </span>
              <span className={s.num}>{fmt(amount, 4)}</span>
            </div>
          );
        })}
      </div>
      <div className={s.cardFoot}>
        <span className={s.muted}>+ 4 more coins</span>
        <span className={s.muted}>paid from the basket</span>
      </div>
    </div>
  );
}

function BoostCard({ t, logos }: { t: number; logos: Logos }) {
  const hold = ease(span(t, 300, 1900));
  const verify = span(t, 1900, 2500);
  const tier = t > 2700 ? 2 : t > 2550 ? 1 : 0;
  return (
    <div className={s.card}>
      <div className={s.cardHead}>
        <b>Your boost</b>
        <span className={s.muted}>on top of your share</span>
      </div>
      <div className={s.boost}>
        <div className={s.row}>
          <span>Stay longer</span>
          <span className={`${s.num} ${s.strong}`}>{(1 + 0.5 * hold).toFixed(2)}×</span>
        </div>
        <div className={s.meter}>
          {Array.from({ length: 20 }, (_, i) => (
            <span key={i} className={s.tick} style={{ opacity: i / 20 < hold ? 1 : 0.14 }} />
          ))}
        </div>
        <span className={s.caption}>The longer you stay, the bigger your share, up to 1.5×.</span>
      </div>
      <div className={s.boost}>
        <div className={s.row}>
          <span className={s.brandRow}>
            <HypeMark logos={logos} size={18} />
            Prove you hold HYPE
          </span>
          <span className={s.num} style={{ opacity: verify > 0 ? 1 : 0.3 }}>
            {verify >= 1 ? "Verified ✓" : verify > 0 ? decrypt("Verified ✓", verify) : "—"}
          </span>
        </div>
        <div className={s.tiers}>
          {[
            ["Tier 1", "1.10×"],
            ["Tier 2", "1.20×"],
            ["Tier 3", "1.25×"],
          ].map(([name, x], i) => (
            <span key={name} className={`${s.tier} ${tier === i + 1 && i === 1 ? s.tierOn : ""}`}>
              <span className={s.muted}>{name}</span>
              <b>{x}</b>
            </span>
          ))}
        </div>
        <span className={s.caption}>One signature from your Hyperliquid wallet. No transfer.</span>
      </div>
    </div>
  );
}

// ───────────────────────── the section ─────────────────────────
export function WhatYouGet({ logos = "mono" }: { logos?: Logos }) {
  const steps: ShowcaseStep[] = [
    { key: "buy", title: "Buy PNTH", short: "Buy", desc: "Swap USDC for PNTH on Ascend, like any other coin.", brand: <>on <AscendMark logos={logos} size={15} /></> },
    { key: "stake", title: "Stake it", short: "Stake", desc: "Put your PNTH to work. Leave any time; it unlocks 3 days after you ask." },
    { key: "earn", title: "Earn the basket", short: "Earn", desc: "Ascend’s 10 best coins drip into your wallet, every day you stay." },
    { key: "boost", title: "Boost it", short: "Boost", desc: "Stay longer to earn up to 1.5×. Prove you hold HYPE for up to 1.25× more.", brand: <>with <HypeMark logos={logos} size={16} /></> },
  ];
  return (
    <Showcase
      id="what-you-get"
      eyebrow="For holders"
      title={
        <>
          Stake PNTH.
          <br />
          <span>Earn Ascend’s best coins.</span>
        </>
      }
      sub="Four steps. No forms, no lockups to sign. Leave whenever you want."
      steps={steps}
      foot={{ label: "Read the staking rules", href: "#rules" }}
      renderCard={(i, t) =>
        i === 0 ? <BuyCard t={t} logos={logos} /> : i === 1 ? <StakeCard t={t} /> : i === 2 ? <EarnCard t={t} /> : <BoostCard t={t} logos={logos} />
      }
    />
  );
}
