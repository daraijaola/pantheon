"use client";

// A landing-page section that teaches one thing in a few steps: the step list on one side, a live
// preview of that step on the other. Steps advance by themselves while on screen; a click jumps.
// Used by "How it works" (preview on the left) and "What you get" (preview on the right).

import type { ReactNode } from "react";
import { clamp01, useInView, useReducedMotion, useStepClock } from "./kit";
import s from "./showcase.module.css";

export type ShowcaseStep = {
  key: string;
  title: string;
  short: string; // one-word label for the phone tab row
  desc: string;
  brand?: ReactNode; // small partner mark next to the title, e.g. "on [Ascend]"
};

type Props = {
  id: string;
  eyebrow: string;
  title: ReactNode;
  sub: string;
  steps: ShowcaseStep[];
  /** Draw the preview for step `i`, `t` ms after it appeared (a large number = final state). */
  renderCard: (i: number, t: number) => ReactNode;
  foot: { label: string; href: string };
  reverse?: boolean;
  stepMs?: number;
};

export function Showcase({ id, eyebrow, title, sub, steps, renderCard, foot, reverse, stepMs = 6500 }: Props) {
  const [ref, inView] = useInView<HTMLDivElement>();
  const reduce = useReducedMotion();
  const { active, t, select } = useStepClock(steps.length, stepMs, inView && !reduce);
  const shown = reduce ? 99999 : t;

  return (
    <section className={s.section} aria-labelledby={id}>
      <header className={s.head}>
        <p className={s.eyebrow}>
          <span>{"//"}</span> {eyebrow} <span>{"\\\\"}</span>
        </p>
        <h2 id={id} className={s.h2}>
          {title}
        </h2>
        <p className={s.sub}>{sub}</p>
      </header>

      <div className={`${s.body} ${reverse ? s.reverse : ""}`} ref={ref}>
        <div className={s.steps} role="tablist" aria-label={eyebrow}>
          {steps.map((step, i) => {
            const on = i === active;
            return (
              <button key={step.key} role="tab" aria-selected={on} className={`${s.step} ${on ? s.stepOn : ""}`} onClick={() => select(i)}>
                <span className={s.stepNum}>{String(i + 1).padStart(2, "0")}</span>
                <span className={s.stepTitle}>
                  <span className={s.long}>{step.title}</span>
                  <span className={s.short}>{step.short}</span>
                  {step.brand && <span className={s.stepBrand}>{step.brand}</span>}
                </span>
                <span className={s.stepDesc}>{step.desc}</span>
                {on && !reduce && <span className={s.progress} style={{ transform: `scaleX(${clamp01(t / stepMs)})` }} />}
              </button>
            );
          })}
          <a className={s.stepsFoot} href={foot.href}>
            {foot.label} <span aria-hidden="true">›</span>
          </a>
        </div>

        <div className={s.stage} role="tabpanel">
          <span className={s.example}>EXAMPLE</span>
          <p className={s.stageDesc}>{steps[active].desc}</p>
          <div key={active} className={s.cardWrap}>
            {renderCard(active, shown)}
          </div>
        </div>
      </div>
    </section>
  );
}
