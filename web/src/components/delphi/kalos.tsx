// DELPHI on Kalos: every coin that reaches Kalos, from PerpMe launches and from new Kalos pools, with
// DELPHI's wallet checks and the contract and market checks a trader asks for before buying (who
// controls it, what they can still do, can you sell). Server-rendered from DELPHI's published file;
// links out go to the explorer only. Long lists open on request, so the page stays short.

import Link from "next/link";
import s from "@/components/app/app.module.css";
import { shortHash, when, type Delphi, type KalosRow, type SafetyCheck } from "@/lib/delphi";
import { Pill } from "./delphi";
import d from "./delphi.module.css";
import k from "./kalos.module.css";

const out = { target: "_blank", rel: "noreferrer" } as const;
const num = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: n < 10 ? 2 : 0 });

/** What a check found, in the table's few words. Unpublished code is common, so it is said plainly. */
const RISK: Record<Exclude<SafetyCheck, "verified">, string> = {
  code: "Can be upgraded",
  owner: "Someone controls it",
  powers: "Powers over holders",
  transfer: "Transfers taxed or blocked",
  sell: "Selling taxed or blocked",
  impersonation: "Copies a known token",
};

function contract(c: KalosRow): string {
  const sf = c.safety;
  if (!sf) return "Not checked yet";
  const risks = sf.risks.filter((r): r is Exclude<SafetyCheck, "verified"> => r !== "verified");
  return risks.length ? risks.map((r) => RISK[r]).join(", ") : "No owner, no powers";
}

function pools(c: KalosRow): string {
  if (c.pools === 0) return "none";
  const value = c.tvlHype === null ? null : c.tvlHype < 0.01 ? "under 0.01 HYPE" : `${num(c.tvlHype)} HYPE`;
  if (c.venue === "perpme") return c.lpLocked ? `Locked${value ? `, ${value}` : ""}` : (value ?? "1 pool");
  return value ?? `${c.pools} pool${c.pools === 1 ? "" : "s"}`;
}

const WHERE = { perpme: "PerpMe", kalos: "Kalos pool" } as const;
const SHOW = { saw: 10, rows: 30 };

function sell(c: KalosRow): string {
  const st = c.safety?.checks.sell.state;
  return st === "ok" ? "Yes, no tax" : st === "risk" ? "Taxed or blocked" : "Not tested";
}

/** The sentences behind a coin's flags: its wallet findings, then each contract check that found something. */
function found(c: KalosRow): string[] {
  // An owner check that only restates the powers (TA: "nobody needs to be one: any wallet can…") is said once.
  const risks = (c.safety?.risks ?? []).filter((r) => r !== "verified" && !(r === "owner" && c.safety!.risks.includes("powers")));
  const contractRisks = risks.map((r) => c.safety!.checks[r].summary);
  return [...c.findings.map((f) => f.summary), ...contractRisks];
}

export function KalosIndex({ data }: { data: Delphi }) {
  const kalos = data.kalos!;
  const risky = kalos.coins.filter((c) => (c.safety?.risks ?? []).some((r) => r !== "verified")).length;
  // Every coin with something to say: what's wrong first, then the context that explains the rest.
  const context = (c: KalosRow) => (c.notes ?? []).filter((n) => !/^(Too busy to read|\d+ decimals|Supply changed|Contracts hold)/.test(n));
  // Findings and contract risks first, then coins with only context, busiest first within each.
  const rank = (c: KalosRow) => (c.findings.length ? 0 : found(c).length ? 1 : 2);
  const worth = kalos.coins
    .filter((c) => found(c).length > 0 || context(c).length > 0)
    .sort((a, b) => rank(a) - rank(b) || b.trades - a.trades);
  const published = kalos.coins.filter((c) => c.safety?.checks.verified.state === "ok").length;
  const fromPerpme = kalos.coins.filter((c) => c.venue === "perpme").length;
  const seen = (c: KalosRow) => (
    <li key={c.token} className={d.item}>
      <a href={`${data.explorer}/token/${c.token}`} {...out}>
        <span className={d.coin}>
          <span className={d.sym}>{c.symbol ?? shortHash(c.token)}</span>
          <Pill v={c.verdict} />
        </span>
        <div className={k.lines}>
          {found(c).map((line) => (
            <p key={line} className={d.headline}>
              {line}
            </p>
          ))}
          {context(c).map((line) => (
            <p key={line} className={found(c).length ? k.quiet : d.headline}>
              {line}
            </p>
          ))}
          {c.windowed && <p className={k.quiet}>Too busy to read in full: read at launch and over the last day.</p>}
        </div>
        <span className={d.go} aria-hidden>
          ↗
        </span>
      </a>
    </li>
  );
  const row = (c: KalosRow) => (
    <tr key={c.token}>
      <td>
        <a href={`${data.explorer}/token/${c.token}`} {...out}>
          {c.symbol ?? shortHash(c.token)}
        </a>
      </td>
      <td className={k.nowrap}>{c.venue ? WHERE[c.venue] : "Kalos pool"}</td>
      <td>
        <Pill v={c.verdict} />
      </td>
      <td>{contract(c)}</td>
      <td className={k.nowrap}>{sell(c)}</td>
      <td className={d.n}>{num(c.creatorPct)}%</td>
      <td className={`${d.n} ${k.nowrap}`}>{pools(c)}</td>
      <td className={d.n}>{c.people ? num(c.people.people) : num(c.holders)}</td>
    </tr>
  );
  const head = (
    <thead>
      <tr>
        <th>Coin</th>
        <th>From</th>
        <th>Verdict</th>
        <th>Contract</th>
        <th>Can you sell?</th>
        <th className={d.n}>Creator holds</th>
        <th className={d.n}>Liquidity</th>
        <th className={d.n}>People</th>
      </tr>
    </thead>
  );
  return (
    <main className={s.page}>
      <header className={s.head}>
        <div>
          <p className={s.eyebrow}>DELPHI · Kalos · Elysium testnet</p>
          <h1 className={s.h1}>Every new coin on Kalos, checked</h1>
          <p className={s.sub}>
            Coins reach Kalos two ways: launches on PerpMe, and new Kalos pools. DELPHI checks each one: are the first buyers one person, is the volume real, who controls
            the contract and what they can still do, and whether you can sell. Every claim links to the chain, so you can check it yourself.
          </p>
        </div>
        {data.scannedAt && (
          <div className={d.scan}>
            <span>Last scan</span>
            <span>{when(data.scannedAt)}</span>
          </div>
        )}
      </header>
      <div className={s.grid}>
        <div className={s.main}>
          <section className={s.cell}>
            <div className={s.stats}>
              <div className={s.stat}>
                <span className={s.statK}>Coins checked</span>
                <span className={s.statVStrong}>{kalos.counts.coins}</span>
                <span className={s.statNote}>
                  {fromPerpme} from PerpMe, {kalos.counts.coins - fromPerpme} from Kalos pools. {kalos.counts.NOT_ENOUGH_DATA} too quiet to judge
                </span>
              </div>
              <div className={s.stat}>
                <span className={s.statK}>Flagged</span>
                <span className={s.statVStrong}>{kalos.counts.FLAG}</span>
                {kalos.counts.WATCH > 0 && <span className={s.statNote}>{kalos.counts.WATCH} more to watch</span>}
              </div>
              <div className={s.stat}>
                <span className={s.statK}>Contract risks</span>
                <span className={s.statVStrong}>{risky}</span>
                <span className={s.statNote}>An owner or code that can still change things</span>
              </div>
            </div>
          </section>

          {worth.length > 0 && (
            <section className={s.cell}>
              <p className={s.label}>What DELPHI saw</p>
              <ul className={d.list}>{worth.slice(0, SHOW.saw).map(seen)}</ul>
              {worth.length > SHOW.saw && (
                <details className={d.all}>
                  <summary>{worth.length - SHOW.saw} more</summary>
                  <ul className={d.list}>{worth.slice(SHOW.saw).map(seen)}</ul>
                </details>
              )}
            </section>
          )}

          <section className={s.cell}>
            <p className={s.label}>All {kalos.counts.coins} coins</p>
            <div className={d.tableWrap}>
              <table className={d.table}>
                {head}
                <tbody>{kalos.coins.slice(0, SHOW.rows).map(row)}</tbody>
              </table>
            </div>
            {kalos.coins.length > SHOW.rows && (
              <details className={d.all}>
                <summary>{kalos.coins.length - SHOW.rows} more coins</summary>
                <div className={d.tableWrap}>
                  <table className={d.table}>
                    {head}
                    <tbody>{kalos.coins.slice(SHOW.rows).map(row)}</tbody>
                  </table>
                </div>
              </details>
            )}
            <p className={k.note}>
              {published === 0
                ? `None of these ${kalos.counts.coins} coins has published its code, so DELPHI read the raw code instead.`
                : `${published} of ${kalos.counts.coins} coins have published their code; DELPHI read the raw code of the rest.`}{" "}
              People counts linked wallets as one person.
            </p>
          </section>
        </div>

        <aside className={s.side}>
          <section className={s.cell}>
            <p className={s.label}>What DELPHI checks</p>
            <dl className={d.defs}>
              <dt>Wallets</dt>
              <dd>
                Linked wallets buying at launch, the same people trading back and forth to fake volume, and linked wallets or one wallet holding much of the supply.
              </dd>
              <dt>Contract</dt>
              <dd>Whether its code is published, who controls it, and powers that can hurt holders: minting, blacklists, pausing, fees.</dd>
              <dt>Selling</dt>
              <dd>A dry run from a real holder and from a fresh wallet: a transfer, and a sale where the coin trades. Nothing is sent: it is a simulation.</dd>
              <dt>Liquidity</dt>
              <dd>What each pool holds and who owns its liquidity. A PerpMe launch locks it for good; liquidity a wallet holds in a Kalos pool can be taken out by that wallet.</dd>
            </dl>
          </section>
          <section className={s.cell}>
            <p className={s.label}>How it was read</p>
            <p className={d.para}>
              From the chain, not from any list: PerpMe’s launch factory and Kalos’s pool factory. A PerpMe coin’s creator is the wallet that launched it; a Kalos pool coin’s is
              the wallet that deployed it. The busiest coins are read at launch and over the last day.
            </p>
            <p className={d.para}>On testnet, people farm with free test money, so many patterns here are farming, not cheating. DELPHI reports patterns, never intent.</p>
            <Link href="/delphi" className={d.more}>
              DELPHI on Ascend
            </Link>
          </section>
        </aside>
      </div>
    </main>
  );
}
