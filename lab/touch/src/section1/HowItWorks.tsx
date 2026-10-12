// Section 01 · How it works. Where every trade's 1% fee goes, told as receipts people already know how to read.
// Numbers are exact for the example: a $100 buy pays $1.00; half (50¢) buys the basket by weight.

import type { CSSProperties } from "react";
import { AscendMark, decrypt, ease, fmt, span, type Logos } from "../showcase/kit";
import { Showcase, type ShowcaseStep } from "../showcase/showcase";
import s from "../showcase/showcase.module.css";

/** Receipt lines print one after another: fade in and settle 4px. */
function line(t: number, at: number): CSSProperties {
  const k = ease(span(t, at, at + 320));
  return { opacity: k, transform: `translateY(${(1 - k) * 4}px)` };
}

/** A number that counts up from 0 to `to` between `at` and `at + 500` ms. */
function count(t: number, at: number, to: number) {
  return to * ease(span(t, at, at + 500));
}

function ReceiptHead({ logos, kind }: { logos: Logos; kind: "BUY" | "SELL" }) {
  return (
    <div className={s.cardHead}>
      <span className={s.brandRow}>
        <AscendMark logos={logos} size={18} />
        <b>Trade on Ascend</b>
      </span>
      <span className={s.tag}>{kind}</span>
    </div>
  );
}

// The basket weights used in the example (top 3 shown, the rest summed).
const SHOWN = [
  ["HELIOS", 18],
  ["AETHER", 15],
  ["NYX", 13],
] as const;
const REST = 54;

function BuyReceipt({ t, logos }: { t: number; logos: Logos }) {
  const amount = span(t, 150, 650);
  return (
    <div className={`${s.card} ${s.receipt}`}>
      <ReceiptHead logos={logos} kind="BUY" />
      <div style={line(t, 100)}>
        <span className={s.fieldLabel}>Someone bought</span>
        <div className={s.bigLine}>
          <span className={s.big}>{amount > 0 ? decrypt("$100.00", amount * 1.3) : ""}</span>
          <span className={s.muted}>of PNTH</span>
        </div>
      </div>
      <div className={s.dash} style={line(t, 600)} />
      <div className={s.rRow} style={line(t, 700)}>
        <span>Trade fee · 1%</span>
        <span className={s.num}>${fmt(count(t, 700, 1), 2)}</span>
      </div>
      <div className={`${s.rRow} ${s.rSub}`} style={line(t, 950)}>
        <span>↳ to Ascend</span>
        <span className={s.num}>${fmt(count(t, 950, 0.5), 2)}</span>
      </div>
      <div className={`${s.rRow} ${s.rSub} ${s.rStrong}`} style={line(t, 1150)}>
        <span>↳ to PANTHEON</span>
        <span className={s.num}>${fmt(count(t, 1150, 0.5), 2)}</span>
      </div>
      <div className={s.dash} style={line(t, 1500)} />
      <span className={s.fieldLabel} style={line(t, 1600)}>
        PANTHEON’s 50¢ bought
      </span>
      {SHOWN.map(([name, w], i) => {
        const at = 1800 + i * 180;
        const fill = ease(span(t, at, at + 600));
        return (
          <div key={name} className={s.coinLine} style={line(t, at)}>
            <span className={s.coinName}>{name}</span>
            <span className={s.bar}>
              {Array.from({ length: 10 }, (_, k) => (
                <i key={k} style={{ opacity: k < Math.round((w / 20) * 10 * fill) ? 1 : 0.12 }} />
              ))}
            </span>
            <span className={s.num}>{fmt(count(t, at, w * 0.5), 1)}¢</span>
          </div>
        );
      })}
      <div className={s.coinLine} style={line(t, 2400)}>
        <span className={s.muted}>+ 7 more</span>
        <span />
        <span className={s.num}>{fmt(count(t, 2400, REST * 0.5), 1)}¢</span>
      </div>
      <p className={s.note} style={line(t, 2800)}>
        These coins are locked, then paid out to people who stake PNTH.
      </p>
    </div>
  );
}

function SellReceipt({ t, logos }: { t: number; logos: Logos }) {
  const amount = span(t, 150, 650);
  const burn = ease(span(t, 1500, 2100));
  const circulating = 1_000_000_000 - 50 * ease(span(t, 2300, 3000));
  return (
    <div className={`${s.card} ${s.receipt}`}>
      <ReceiptHead logos={logos} kind="SELL" />
      <div style={line(t, 100)}>
        <span className={s.fieldLabel}>Someone sold</span>
        <div className={s.bigLine}>
          <span className={s.big}>{amount > 0 ? decrypt("10,000", amount * 1.3) : ""}</span>
          <span className={s.muted}>PNTH</span>
        </div>
      </div>
      <div className={s.dash} style={line(t, 600)} />
      <div className={s.rRow} style={line(t, 700)}>
        <span>Trade fee · 1%</span>
        <span className={s.num}>{fmt(count(t, 700, 100))} PNTH</span>
      </div>
      <div className={`${s.rRow} ${s.rSub}`} style={line(t, 950)}>
        <span>↳ to Ascend</span>
        <span className={s.num}>{fmt(count(t, 950, 50))} PNTH</span>
      </div>
      <div className={`${s.rRow} ${s.rSub} ${s.rStrong} ${s.burnRow}`} style={line(t, 1150)}>
        <span>↳ burned forever</span>
        <span className={`${s.num} ${s.strikeWrap}`}>
          {burn > 0 && burn < 1 ? decrypt("50 PNTH", 1 - burn) : `${fmt(count(t, 1150, 50))} PNTH`}
          <span className={s.strike} style={{ transform: `scaleX(${burn})` }} />
        </span>
      </div>
      <div className={s.dash} style={line(t, 2100)} />
      <span className={s.fieldLabel} style={line(t, 2200)}>
        PNTH in circulation
      </span>
      <span className={s.big} style={line(t, 2200)}>
        {fmt(circulating)}
      </span>
      <p className={s.note} style={line(t, 2900)}>
        Burned PNTH goes somewhere no one can ever move it out of. The total never grows, so every burn is for good.
      </p>
    </div>
  );
}

function RulesCard({ t }: { t: number }) {
  const rows: [string, string, boolean?][] = [
    ["Fee on every trade", "1%"],
    ["Ascend gets", "half"],
    ["Our half, on buys", "→ the basket"],
    ["Our half, on sells", "→ burned"],
    ["Owner", "none", true],
    ["Who can change this", "no one", true],
  ];
  const stamp = ease(span(t, 1700, 2000));
  return (
    <div className={s.card}>
      <div className={s.cardHead}>
        <span className={s.brandRow}>
          <svg className={s.lock} viewBox="0 0 12 14" width="12" height="14" aria-hidden="true">
            <rect x="1" y="6" width="10" height="7" rx="1.5" />
            <path d="M3.5 6V4.2a2.5 2.5 0 0 1 5 0V6" fill="none" strokeWidth="1.4" />
          </svg>
          <b>The rules</b>
        </span>
        <span className={`${s.tag} ${s.tagInk}`} style={{ opacity: stamp, transform: `scale(${1.15 - 0.15 * stamp})` }}>
          LOCKED
        </span>
      </div>
      <div className={s.rows}>
        {rows.map(([k, v, check], i) => (
          <div key={k} className={s.row} style={line(t, 150 + i * 200)}>
            <span className={check ? undefined : s.muted}>{k}</span>
            <span className={`${s.num} ${check ? s.strong : ""}`}>
              {v}
              {check && <span className={s.okDot}>✓</span>}
            </span>
          </div>
        ))}
      </div>
      <button className={s.outline} tabIndex={-1} style={line(t, 1500)}>
        View the contract ↗
      </button>
      <p className={s.note} style={line(t, 1700)}>
        Written into the contract at launch. Anyone can check it.
      </p>
    </div>
  );
}

export function HowItWorks({ logos = "mono" }: { logos?: Logos }) {
  const steps: ShowcaseStep[] = [
    {
      key: "buy",
      title: "When someone buys",
      short: "Buys",
      desc: "Half the 1% fee goes to Ascend. Our half buys Ascend’s 10 best coins and pays them out to people who stake PNTH.",
      brand: <>on <AscendMark logos={logos} size={15} /></>,
    },
    { key: "sell", title: "When someone sells", short: "Sells", desc: "Half the fee goes to Ascend. Our half is burned, so there are fewer PNTH, forever." },
    { key: "rules", title: "Who controls it", short: "Rules", desc: "No one. The rules are locked into the contract at launch. Not even we can change them." },
  ];
  return (
    <Showcase
      id="how-it-works"
      reverse
      eyebrow="How it works"
      title={
        <>
          Buys build the basket.
          <br />
          <span>Sells burn the supply.</span>
        </>
      }
      sub="Every PNTH trade pays a 1% fee. Here is exactly where it goes."
      steps={steps}
      foot={{ label: "Read the full rules", href: "#rules" }}
      stepMs={7000}
      renderCard={(i, t) => (i === 0 ? <BuyReceipt t={t} logos={logos} /> : i === 1 ? <SellReceipt t={t} logos={logos} /> : <RulesCard t={t} />)}
    />
  );
}
