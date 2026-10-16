import Link from "next/link";
import type { Live } from "@/lib/live";
import s from "./live.module.css";

// Under the hero: PANTHEON's real numbers on testnet, each with a link to where it can be checked.
// A left column says what this is; the numbers sit on the right; the basket as it stands today runs
// along the bottom. Anything a service didn't answer is simply left out.

const n = (v: number, digits = 0) => v.toLocaleString("en-US", { maximumFractionDigits: digits });
const short = (v: number) => (v >= 1e6 ? `${n(v / 1e6, 1)}M` : v >= 1e3 ? `${n(v / 1e3, 1)}K` : n(v, 2));
const utc = (sec: number) =>
  `${new Date(sec * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" })} UTC`;

type Cell = { value: string; label: string; note: React.ReactNode };

export function LiveNumbers({ live, pnth }: { live: Live; pnth: string | null }) {
  const cells: Cell[] = [];
  if (live.people) {
    cells.push({
      value: n(live.people.people),
      label: "people",
      note: (
        <>
          behind {n(live.people.wallets)} wallets. Wallets one person funds count once.{" "}
          {pnth && <Link href={`/delphi/${pnth}`}>How we count</Link>}
        </>
      ),
    });
  }
  if (live.stakers !== null) cells.push({ value: n(live.stakers), label: "wallets staking", note: "earning the coins the basket buys" });
  if (live.bought) {
    cells.push({
      value: n(live.bought.usdc),
      label: "test USDC of Ascend coins bought",
      note: (
        <>
          in {n(live.bought.buys)} buys for stakers.{" "}
          {live.bought.last && (
            <a href={live.bought.last.url} target="_blank" rel="noreferrer">
              Latest: {live.bought.last.symbol}
            </a>
          )}
        </>
      ),
    });
  }
  if (live.burned) {
    cells.push({
      value: n(live.burned.pnth),
      label: "PNTH burned",
      note: live.burned.url ? (
        <a href={live.burned.url} target="_blank" rel="noreferrer">
          from sell fees
        </a>
      ) : (
        "from sell fees"
      ),
    });
  }
  if (live.checked) {
    cells.push({
      value: n(live.checked.coins),
      label: "Ascend coins checked for cheating",
      note: (
        <>
          {n(live.checked.flagged)} flagged, and they can never enter the basket. <Link href="/delphi">See them</Link>
        </>
      ),
    });
  }
  if (live.vote) {
    cells.push({
      value: n(live.vote.ballots),
      label: live.vote.ballots === 1 ? "vote on the next basket" : "votes on the next basket",
      note: live.vote.open ? (
        <>
          Open until {utc(live.vote.closesAt)}. <Link href="/trials/vote">{live.vote.ballots === 0 ? "Be the first" : "Vote"}</Link>
        </>
      ) : (
        <Link href="/trials">See the results</Link>
      ),
    });
  }
  if (cells.length === 0) return null;

  return (
    <section id="live" className={s.section} aria-labelledby="live-title">
      <div className={s.top}>
        <header className={s.head}>
          <p className={s.eyebrow}>
            <i className={s.dot} aria-hidden="true" /> Live on Elysium testnet
          </p>
          <h2 id="live-title" className={s.h2}>
            Already running.
          </h2>
          <p className={s.sub}>Real numbers from the chain, updated every few minutes. Test coins, so nothing here has a price yet.</p>
        </header>
        <dl className={s.grid}>
          {cells.map((c) => (
            <div key={c.label} className={s.cell}>
              <dt className={s.label}>{c.label}</dt>
              <dd className={s.value}>{c.value}</dd>
              <dd className={s.note}>{c.note}</dd>
            </div>
          ))}
        </dl>
      </div>

      {live.basket && (
        <div className={s.basket}>
          <p className={s.basketHead}>The basket right now</p>
          <ul className={s.coins}>
            {live.basket.coins.map((c) => (
              <li key={c.token}>
                <Link href={`/delphi/${c.token}`} className={s.coin}>
                  {c.symbol}
                </Link>
                <span className={s.coinNote}>
                  {c.weightPct}% · {c.bought > 0 ? `${short(c.bought)} bought` : "not bought yet"}
                </span>
              </li>
            ))}
          </ul>
          {live.next && (
            <p className={s.next}>
              Next list, ready to start {utc(live.next.startsAt)}: {live.next.symbols.join(", ")}.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
