// One template for the feature pages behind the Explore menu (Passport, Trials, Covenant).
// Lighter than the landing page on purpose: the idea and its diagram side by side, three short
// steps, one table of the details, a few plain answers. The footer follows.

import type { ReactNode } from "react";
import { A } from "../menu/link";
import f from "./feature.module.css";

export type Feature = {
  eyebrow: string;
  title: ReactNode; // two lines; the second is greyed with a <span>
  sub: string;
  actions: { label: string; href: string; primary?: boolean }[];
  diagram: ReactNode; // a worked example, shown beside the text
  steps: { title: string; desc: string }[];
  details: { title: string; sub: string; head: string[]; rows: ReactNode[][]; note?: string };
  faq: { q: string; a: string }[];
};

export function FeaturePage({ page }: { page: Feature }) {
  return (
    <main className={f.page}>
      <section className={f.hero}>
        <div className={f.copy}>
          <p className={f.eyebrow}>
            <span>{"//"}</span> {page.eyebrow} <span>{"\\\\"}</span>
          </p>
          <h1 className={f.h1}>{page.title}</h1>
          <p className={f.sub}>{page.sub}</p>
          <div className={f.actions}>
            {page.actions.map((a) => (
              <A
                key={a.label}
                href={a.href}
                className={a.primary ? f.btnInk : f.btnGhost}
                {...(a.href.startsWith("http") ? { target: "_blank", rel: "noreferrer" } : {})}
              >
                {a.label}
              </A>
            ))}
          </div>
        </div>
        <div className={f.stage}>
          <span className={f.example}>EXAMPLE</span>
          {page.diagram}
        </div>
      </section>

      <section className={f.steps} aria-label="How it works">
        {page.steps.map((s, i) => (
          <div key={s.title} className={f.step}>
            <span className={f.stepNum}>{String(i + 1).padStart(2, "0")}</span>
            <h2 className={f.stepTitle}>{s.title}</h2>
            <p className={f.stepDesc}>{s.desc}</p>
          </div>
        ))}
      </section>

      <section id="details" className={f.details}>
        <header className={f.detailsHead}>
          <h2 className={f.h2}>{page.details.title}</h2>
          <p className={f.detailsSub}>{page.details.sub}</p>
        </header>
        <div className={f.tableWrap}>
          <table className={f.table}>
            <thead>
              <tr>
                {page.details.head.map((h) => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {page.details.rows.map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    <td key={j}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {page.details.note && <p className={f.note}>{page.details.note}</p>}
        </div>
      </section>

      <section className={f.faq}>
        <h2 className={f.h2}>Questions</h2>
        <div className={f.qs}>
          {page.faq.map((item) => (
            <details key={item.q} className={f.q}>
              <summary>
                {item.q}
                <span aria-hidden="true" className={f.plus} />
              </summary>
              <p>{item.a}</p>
            </details>
          ))}
        </div>
      </section>
    </main>
  );
}
