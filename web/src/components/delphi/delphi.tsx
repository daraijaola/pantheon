// DELPHI's screens: every coin's verdict, and each written report with its proof. Server-rendered
// from DELPHI's published file; the only links out are to the explorer, so anyone can check a claim.

import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import s from "@/components/app/app.module.css";
import { basketNote, headline, ROUND1, shortHash, VERDICT, when, type Check, type CheckState, type Delphi, type Verdict } from "@/lib/delphi";
import d from "./delphi.module.css";

const CHECK: Record<Check, string> = { bundle: "Launch bundle", wash: "Wash trading", concentration: "Hidden whales" };
const STATE: Record<CheckState, string> = { found: "found", clear: "clear", "not-enough-data": "not enough data" };
const out = { target: "_blank", rel: "noreferrer" } as const;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function Pill({ v }: { v: Verdict }) {
  return <span className={`${d.pill} ${d[v]}`}>{VERDICT[v]}</span>;
}

function Stat({ k, v, note }: { k: string; v: string; note?: string }) {
  return (
    <div className={s.stat}>
      <span className={s.statK}>{k}</span>
      <span className={s.statVStrong}>{v}</span>
      {note && <span className={s.statNote}>{note}</span>}
    </div>
  );
}

function Head({ eyebrow, title, sub, right }: { eyebrow: string; title: ReactNode; sub: ReactNode; right?: ReactNode }) {
  return (
    <header className={s.head}>
      <div>
        <p className={s.eyebrow}>{eyebrow}</p>
        <h1 className={s.h1}>{title}</h1>
        <p className={s.sub}>{sub}</p>
      </div>
      {right}
    </header>
  );
}

export function NotPublished() {
  return (
    <main className={s.page}>
      <Head eyebrow="DELPHI · Elysium testnet" title="DELPHI" sub="DELPHI hasn’t published its first scan here yet. It will appear on this page as soon as it does." />
      <p className={s.fine}>
        <Link href="/">Back to the home page</Link>
      </p>
    </main>
  );
}

// ------------------------------------------------------------------ every coin

export function DelphiIndex({ data }: { data: Delphi }) {
  const { counts, rules } = data;
  const explained = data.coins.filter((c) => c.headline);
  return (
    <main className={s.page}>
      <Head
        eyebrow="DELPHI · Elysium testnet"
        title="Every Ascend coin, checked for cheating"
        sub="DELPHI reads the chain for bundled launches, wash trading and hidden whales. An AI explains each result in plain words, and every claim links to the transactions behind it, so you can check it yourself."
        right={
          data.scannedAt && (
            <div className={d.scan}>
              <span>Last scan</span>
              <span>{when(data.scannedAt)}</span>
            </div>
          )
        }
      />
      <div className={s.grid}>
        <div className={s.main}>
          <section className={s.cell}>
            <div className={s.stats}>
              <Stat k="Coins checked" v={String(counts.coins)} note={`${counts.NOT_ENOUGH_DATA} too new or quiet to judge`} />
              <Stat k="Flagged" v={String(counts.FLAG)} note={counts.WATCH ? `${counts.WATCH} more to watch` : undefined} />
              <Stat k="Clean" v={String(counts.CLEAN)} note="Enough data, nothing found" />
            </div>
          </section>
          <section className={s.cell}>
            <p className={s.label}>Explained in plain words</p>
            <ul className={d.list}>
              {explained.map((c) => (
                <li key={c.token} className={d.item}>
                  <Link href={`/delphi/${c.token}`}>
                    <span className={d.coin}>
                      <span className={d.sym}>{c.symbol ?? shortHash(c.token)}</span>
                      <Pill v={c.verdict} />
                    </span>
                    <p className={d.headline}>{headline(c.headline ?? "")}</p>
                    <span className={d.go} aria-hidden>
                      →
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
          <section className={s.cell}>
            <details className={d.all}>
              <summary>All {counts.coins} coins</summary>
              <div className={d.tableWrap}>
                <table className={d.table}>
                  <thead>
                    <tr>
                      <th>Coin</th>
                      <th>Verdict</th>
                      <th className={d.n}>Trades</th>
                      <th className={d.n}>Holders</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.coins.map((c) => (
                      <tr key={c.token}>
                        <td>
                          {c.headline ? (
                            <Link href={`/delphi/${c.token}`}>{c.symbol ?? shortHash(c.token)}</Link>
                          ) : (
                            <a href={`${data.explorer}/token/${c.token}`} {...out}>
                              {c.symbol ?? shortHash(c.token)}
                            </a>
                          )}
                        </td>
                        <td>
                          <Pill v={c.verdict} />
                        </td>
                        <td className={d.n}>{c.trades}</td>
                        <td className={d.n}>{c.holders}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </section>
        </div>
        <aside className={s.side}>
          <section className={s.cell}>
            <p className={s.label}>What DELPHI looks for</p>
            <dl className={d.defs}>
              <dt>Launch bundle</dt>
              <dd>
                Linked wallets buying in the first {rules.bundle.windowSec} seconds. Watch at {rules.bundle.watchPct}% of the supply, flagged at {rules.bundle.flagPct}%.
              </dd>
              <dt>Wash trading</dt>
              <dd>
                The same people buying and selling the same tokens back within {rules.wash.pairWindowSec / 60} minutes. Watch at {rules.wash.watchPct}% of volume, flagged at{" "}
                {rules.wash.flagPct}%.
              </dd>
              <dt>Hidden whales</dt>
              <dd>
                Linked wallets holding much of what’s out there between them. Watch at {rules.concentration.watchPct}%, flagged at {rules.concentration.flagPct}%.
              </dd>
            </dl>
            <p className={s.hint}>Wallets count as linked when one funded the other, they got gas money from the same private wallet, or they passed tokens straight between them. Public faucets never link anyone.</p>
          </section>
          <section className={s.cell}>
            <p className={s.label}>It decides the basket</p>
            <p className={d.para}>A flagged coin can never enter PANTHEON’s basket.</p>
            <p className={d.para}>
              Round 1 picked {ROUND1.symbols.join(", ")}, and kept out {ROUND1.excluded.join(" and ")}.
            </p>
            <Link href="/trials" className={d.more}>
              How the basket is chosen
            </Link>
          </section>
        </aside>
      </div>
      <p className={s.fine}>
        DELPHI reports patterns, not intent: on testnet, many of them are people trying the launchpad. Reports are written by Claude from DELPHI’s data and checked before they’re published: the verdict can’t change, and every transaction they cite must belong to that coin. Rules {rules.version}.
      </p>
    </main>
  );
}

// ------------------------------------------------------------------ one coin

export function CoinReport({ data, token }: { data: Delphi; token: string }) {
  const row = data.coins.find((c) => c.token.toLowerCase() === token.toLowerCase());
  if (!row) notFound();
  const e = data.explained[row.token.toLowerCase()];
  const basket = basketNote(row.token);
  const tx = (h: string) => `${data.explorer}/tx/${h}`;
  return (
    <main className={s.page}>
      <Head
        eyebrow="DELPHI · coin report"
        title={
          <span className={d.title}>
            {row.symbol ?? shortHash(row.token)} <Pill v={row.verdict} />
          </span>
        }
        sub={
          <>
            {row.name && <>{row.name} · </>}
            launched {when(row.launched)} ·{" "}
            <a href={`${data.explorer}/token/${row.token}`} className={d.inline} {...out}>
              {shortHash(row.token)} ↗
            </a>
          </>
        }
      />
      <div className={s.grid}>
        <div className={s.main}>
          {e ? (
            <>
              <section className={s.cell}>
                <p className={d.big}>{headline(e.explanation.headline)}</p>
                <p className={d.summary}>{e.explanation.summary}</p>
              </section>
              <section className={s.cell}>
                <p className={s.label}>What DELPHI saw</p>
                <ul className={d.points}>
                  {e.explanation.points.map((p) => (
                    <li key={p.text} className={d.point}>
                      {p.text}
                      <span className={d.proof}>
                        {p.evidence.map((h) => (
                          <a key={h} href={tx(h)} className={d.tx} {...out}>
                            {shortHash(h)} ↗
                          </a>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
              {e.explanation.caveats.length > 0 && (
                <section className={s.cell}>
                  <p className={s.label}>Keep in mind</p>
                  <ul className={d.caveats}>
                    {e.explanation.caveats.map((c) => (
                      <li key={c}>{c}</li>
                    ))}
                  </ul>
                </section>
              )}
            </>
          ) : (
            <section className={s.cell}>
              <p className={d.summary}>
                {plural(row.trades, "trade")} by {plural(row.wallets, "wallet")} so far. That’s too little for a written report: DELPHI writes one once a coin has enough trading to judge.
              </p>
            </section>
          )}
        </div>
        <aside className={s.side}>
          {e && (
            <section className={s.cell}>
              <p className={s.label}>The checks</p>
              {(Object.keys(CHECK) as Check[]).map((k) => (
                <div key={k} className={d.check}>
                  <span>{CHECK[k]}</span>
                  <span className={e.report.checks[k] === "found" ? d.found : d.state}>{STATE[e.report.checks[k]]}</span>
                </div>
              ))}
            </section>
          )}
          <section className={s.cell}>
            <div className={s.stats}>
              <Stat k="Trades" v={String(e?.report.stats.trades ?? row.trades)} />
              <Stat k="Wallets" v={String(e?.report.stats.traders ?? row.wallets)} />
              <Stat k="Holders" v={String(e?.report.stats.holders ?? row.holders)} />
            </div>
          </section>
          {basket && (
            <section className={s.cell}>
              {basket.in ? (
                <p className={d.basketIn}>Picked for PANTHEON’s basket in round 1.</p>
              ) : (
                <p className={d.basketOut}>Kept out of PANTHEON’s basket. {basket.why}.</p>
              )}
            </section>
          )}
          {e && (
            <section className={s.cell}>
              <p className={d.para}>
                <a href={tx(e.report.coin.launchTx)} {...out}>
                  The launch transaction ↗
                </a>
              </p>
            </section>
          )}
        </aside>
      </div>
      <p className={s.fine}>
        {e ? `Written by Claude (${e.model}) on ${when(e.writtenAt)}, from DELPHI ${e.report.rules} data. ` : ""}
        DELPHI reports patterns, not intent: check every claim against its transactions. <Link href="/delphi">All coins</Link>
      </p>
    </main>
  );
}
