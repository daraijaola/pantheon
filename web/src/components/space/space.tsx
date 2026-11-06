"use client";

// Your space: the main page inside the app, where Get uploaded leads. It says one thing first, how your
// bag looks to DELPHI, and keeps everything else a tap away. Your bag is a dark card, a tile per coin,
// with the passport's liquid-glass lens on the one that matters and one line under it saying what she
// found. Beside it: at most three things to do now, and three numbers that say where you stand. The
// details open in a tray of glass, grown from what you tapped. Ink on paper; glass only on what floats
// or moves, as Apple uses it. Until sign-in is live it shows a labelled example (data.ts says where the
// real answers will come from).

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { readFonts } from "@/components/passport-book/draw";
import { pantheonStakingAbi } from "@/lib/chain/abi";
import { deployment } from "@/lib/chain/config";
import { short, TxNote, useNow, useTx, type Hex } from "@/components/app/shared";
import { createBag, layoutTiles, MARGIN, type TileItem } from "./bag";
import { useSpace, type Alert, type Bag, type BagCoin, type Part, type Space, type Verdict } from "./data";
import { fromEl, Tray, useCloseTray, type From } from "./tray";
import { LABEL, ago, amount, lead, standing, ticker, todos, type Glyph as GlyphName, type Stat, type Todo } from "./words";
import s from "./space.module.css";

const at = (i: number) => ({ "--i": i }) as CSSProperties;
const VENUE: Record<string, string> = { ascend: "Ascend", kalos: "Kalos", perpme: "PerpMe" };

const LOADING: Part<Bag> = { state: "loading" };

type TrayView = { view: "coin"; i: number; back?: "all" } | { view: "all" } | { view: "about" };

export function YourSpace() {
  const sp = useSpace();
  const now = useNow();
  const ready = sp.mode !== "loading";
  const example = sp.mode === "example";
  const [tray, setTray] = useState<{ v: TrayView; from: From | null } | null>(null);
  const [lensAt, setLensAt] = useState(0);
  const bag = sp.bag.state === "ok" ? sp.bag.data : null;
  const alerts = sp.guard.state === "ok" ? sp.guard.data.alerts : [];

  const stand = ready ? standing(sp) : null;
  const trayCoin = tray && bag && tray.v.view === "coin" ? bag.coins[tray.v.i] : undefined;
  const trayBack = tray && tray.v.view === "coin" ? tray.v.back : undefined;

  const openCoin = (i: number, from: From | null, back?: "all") => {
    setLensAt(i);
    setTray({ v: { view: "coin", i, back }, from });
  };

  return (
    <div className={s.page} aria-busy={!ready}>
      <div className={s.inner}>
        <Top sp={sp} now={now} />
        <div className={s.grid}>
          <BagCard part={ready ? sp.bag : LOADING} ready={ready} now={now} lensAt={lensAt} onLens={setLensAt} onOpen={openCoin} onAll={(from) => setTray({ v: { view: "all" }, from })} onAbout={(from) => setTray({ v: { view: "about" }, from })} />
          <aside className={s.side}>
            {ready && <ForYou items={todos(sp, now)} example={example} wallet={sp.wallet} partial={[sp.rewards, sp.ballot, sp.stake].some((p) => p.state === "unread")} />}
            {stand && <Standing stats={stand} />}
          </aside>
        </div>
        {ready && (
          <p className={`${s.fine} ${s.rise}`} style={at(6)}>
            {example ? "Made-up coins, so you can see how it works. Your own space opens here once you’re uploaded." : "Only you can see this space."}
          </p>
        )}
      </div>

      <Tray open={!!tray} from={tray?.from ?? null} label={tray?.v.view === "about" ? "About your bag" : tray?.v.view === "all" ? "All your coins" : "A coin in your bag"} onClose={() => setTray(null)}>
        {trayCoin && tray && (
          <CoinTray c={trayCoin} alert={alerts.find((a) => a.token === trayCoin.token)} example={example} now={now} onBack={trayBack ? () => setTray({ v: { view: "all" }, from: tray.from }) : undefined} />
        )}
        {tray && bag && tray.v.view === "all" && <AllTray bag={bag} onPick={(i) => setTray({ v: { view: "coin", i, back: "all" }, from: tray.from })} />}
        {tray && bag && tray.v.view === "about" && <AboutTray bag={bag} now={now} />}
      </Tray>
    </div>
  );
}

// ------------------------------------------------------------------ the top: one sentence

function Top({ sp, now }: { sp: Space; now: number }) {
  const { headline, sub } = lead(sp, now);
  if (sp.mode === "loading" || !headline)
    return (
      <header className={s.top} aria-hidden="true">
        <span className={s.skelLine} />
        <span className={s.skelSub} />
      </header>
    );
  return (
    <header className={s.top}>
      <h1 className={`${s.headline} ${s.rise}`} style={at(0)}>
        {headline}
      </h1>
      <p className={`${s.sub} ${s.rise}`} style={at(1)}>
        {sub}
      </p>
      {sp.mode === "example" && (
        <p className={`${s.example} ${s.rise}`} style={at(2)}>
          <span className={s.tag}>Example</span>
          <span>Made-up coins, to show you around.</span>
          <Link href="/upload" className={s.inkBtn}>
            Get uploaded
          </Link>
        </p>
      )}
    </header>
  );
}

// ------------------------------------------------------------------ the bag: a dark card and its lens

function BagCard({
  part,
  ready,
  now,
  lensAt,
  onLens,
  onOpen,
  onAll,
  onAbout,
}: {
  part: Part<Bag>;
  ready: boolean;
  now: number;
  lensAt: number;
  onLens: (i: number) => void;
  onOpen: (i: number, from: From | null) => void;
  onAll: (from: From | null) => void;
  onAbout: (from: From | null) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const engine = useRef<ReturnType<typeof createBag> | null>(null);
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const [size, setSize] = useState({ w: 0, compact: false });
  const [hover, setHover] = useState<number | null>(null);
  const live = useRef({ onLens });
  useEffect(() => {
    live.current = { onLens };
  });

  const bag = part.state === "ok" ? part.data : null;
  const coins = useMemo(() => bag?.coins ?? [], [bag]);
  const tiles = useMemo(() => (size.w && coins.length ? layoutTiles(size.w, coins.length, size.compact) : null), [size, coins.length]);
  const items = useMemo<TileItem[]>(() => {
    if (!tiles) return [];
    const shown = coins.slice(0, tiles.shown).map((c) => ({ label: ticker(c), kind: c.verdict }) as TileItem);
    return coins.length > tiles.shown ? [...shown, { label: `+${coins.length - tiles.shown}`, kind: "MORE" }] : shown;
  }, [tiles, coins]);
  const more = tiles ? coins.length - tiles.shown : 0;

  // the card's width, which lays out the tiles
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const w = Math.floor(e.contentRect.width), compact = window.innerWidth < 640;
      setSize((p) => (p.w === w && p.compact === compact ? p : { w, compact }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // the drawing: made here, so a cached navigation that runs this again gets fresh canvases
  useEffect(() => {
    if (!host.current || !layer.current) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const b = createBag({ host: host.current, layer: layer.current }, { hover: setHover, pick: (i) => live.current.onLens(i) }, reduced);
    engine.current = b;
    return () => {
      b.destroy();
      engine.current = null;
    };
  }, []);

  // paint once the tiles' face has loaded
  useEffect(() => {
    const b = engine.current;
    if (!b) return;
    if (!tiles || !items.length) {
      b.clear();
      return;
    }
    const { mono } = readFonts();
    let gone = false;
    document.fonts
      .load(`600 12px ${mono}`)
      .catch(() => [])
      .finally(() => {
        if (!gone) b.set(tiles, items, mono);
      });
    return () => {
      gone = true;
    };
  }, [tiles, items]);

  const shownCount = items.length;
  const rest = Math.min(lensAt, Math.max(0, shownCount - 1));
  const focus = hover ?? rest;
  useEffect(() => {
    engine.current?.aim(focus);
  }, [focus, tiles, items]);

  const isMore = more > 0 && focus === shownCount - 1;
  const c = !isMore ? coins[focus] : undefined;

  const open = (i: number) => {
    const el = buttons.current[i];
    const from = el ? fromEl(el, tiles?.radius ?? 12) : null;
    if (more > 0 && i === shownCount - 1) onAll(from);
    else onOpen(i, from);
  };
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (!tiles) return;
    const cols = Math.max(1, tiles.rects.filter((r) => r.y === tiles.rects[0].y).length);
    const step = ({ ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols } as Record<string, number>)[e.key];
    const to = e.key === "Home" ? 0 : e.key === "End" ? shownCount - 1 : step !== undefined ? Math.max(0, Math.min(shownCount - 1, i + step)) : null;
    if (to === null) return;
    e.preventDefault();
    onLens(to);
    buttons.current[to]?.focus();
  };

  const meta = !bag ? null : bag.checking ? "Reading again…" : now ? `Read ${ago(bag.readAt, now)}${bag.unread.length || !bag.complete ? " · not final" : ""}` : "";

  return (
    <section className={`${s.card} ${ready ? s.rise : ""}`} style={at(2)} aria-labelledby="bag-title">
      <header className={s.cardHead}>
        <h2 id="bag-title" className={s.cardTitle}>
          Your bag {bag && bag.coins.length > 0 && <span className={s.cardCount}>{bag.coins.length}</span>}
        </h2>
        <div className={s.cardMeta}>
          {meta && <span>{meta}</span>}
          {bag && (
            <button type="button" className={s.infoBtn} aria-label="About your bag" onClick={(e) => onAbout(fromEl(e.currentTarget, 14))}>
              <Glyph name="info" size={12} />
            </button>
          )}
        </div>
      </header>

      <div ref={host} className={s.mosaic} style={{ height: tiles ? tiles.H : undefined, "--m": `${MARGIN}px` } as CSSProperties}>
        <div ref={layer} className={s.layer} aria-hidden="true" />
        {tiles && (
          <div role="group" aria-label="Your coins, worst first" className={s.tiles}>
            {tiles.rects.map((r, i) => {
              const coin = coins[i];
              const last = more > 0 && i === shownCount - 1;
              if (!last && !coin) return null;
              return (
                <button
                  key={last ? "more" : coin.token}
                  ref={(el) => {
                    buttons.current[i] = el;
                  }}
                  type="button"
                  className={s.tile}
                  style={{ left: r.x, top: r.y, width: r.w, height: r.h, borderRadius: tiles.radius }}
                  tabIndex={i === rest ? 0 : -1}
                  aria-label={last ? `${more} more coins: see them all` : `${ticker(coin)}, ${LABEL[coin.verdict]}. ${coin.reason}`}
                  onFocus={() => onLens(i)}
                  onKeyDown={(e) => onKey(e, i)}
                  onClick={() => {
                    if (engine.current?.consumeDrag()) return;
                    open(i);
                  }}
                />
              );
            })}
          </div>
        )}
        {!bag && (
          <p className={s.cardQuiet}>{part.state === "unread" ? "DELPHI couldn’t read your bag just now. She’ll try again in a minute." : "DELPHI is reading your bag…"}</p>
        )}
        {bag && !bag.coins.length && (
          <>
            <div className={s.ghosts} aria-hidden="true">
              <i />
              <i />
              <i />
            </div>
            <p className={s.cardQuiet}>Nothing here yet.</p>
          </>
        )}
      </div>

      <div className={s.cardFill} />

      {(c || isMore) && (
        <div className={s.caption}>
          <p className={s.capHead}>
            {c ? (
              <>
                <DarkPill v={c.verdict} />
                <strong>{ticker(c)}</strong>
                {c.name && c.name.toUpperCase() !== (c.symbol ?? "").toUpperCase() && <span>{c.name}</span>}
              </>
            ) : (
              <strong>{more} more</strong>
            )}
          </p>
          <p className={s.capWhy}>{c ? c.reason : "The rest of your bag, in one list."}</p>
          <button type="button" className={s.whiteBtn} onClick={() => open(focus)}>
            {c ? "See why" : "See all"}
          </button>
        </div>
      )}
    </section>
  );
}

function DarkPill({ v }: { v: Verdict }) {
  return <span className={`${s.dpill} ${s[`d${v}`]}`}>{LABEL[v]}</span>;
}

export function Pill({ v }: { v: Verdict }) {
  return <span className={`${s.pill} ${s[v]}`}>{LABEL[v]}</span>;
}

// ------------------------------------------------------------------ for you: at most three things to do

function ForYou({ items, example, wallet, partial }: { items: Todo[]; example: boolean; wallet: string; partial: boolean }) {
  const tx = useTx();
  const refresh = () => deployment && tx.run("Refreshing", [{ address: deployment.staking, abi: pantheonStakingAbi, functionName: "poke", args: [[wallet as Hex]] } as const]);
  return (
    <section className={`${s.box} ${s.rise}`} style={at(3)} aria-labelledby="todo-title">
      <h2 id="todo-title" className={s.boxTitle}>
        For you
      </h2>
      {items.length ? (
        <ul className={s.todos}>
          {items.map((t, i) => {
            const inner = (
              <>
                <span className={s.glyph}>
                  <Glyph name={t.glyph} />
                </span>
                <span className={s.todoText}>
                  <strong>{t.title}</strong>
                  <span>{t.sub}</span>
                </span>
                <span className={i === 0 ? s.actInk : s.act}>{t.refresh && tx.busy ? tx.busy : t.action}</span>
              </>
            );
            return (
              <li key={t.key}>
                {t.href ? (
                  <Link href={t.href} className={s.todo}>
                    {inner}
                  </Link>
                ) : (
                  <button
                    type="button"
                    className={s.todo}
                    disabled={!example && (!deployment || !!tx.busy)}
                    aria-disabled={example || undefined}
                    title={example ? "An example: there’s nothing to refresh" : undefined}
                    onClick={example ? undefined : refresh}
                  >
                    {inner}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className={s.calm}>
          <span className={s.glyph}>
            <Glyph name="calm" />
          </span>
          {partial ? "Nothing to show yet." : "Nothing needs you right now."}
        </p>
      )}
      {partial && <p className={s.partial}>Some of this couldn’t be read just now. It fills in on its own.</p>}
      <TxNote error={tx.error} lastTx={tx.lastTx} />
    </section>
  );
}

// ------------------------------------------------------------------ where you stand: three numbers

function Standing({ stats }: { stats: Stat[] }) {
  return (
    <section className={`${s.box} ${s.boxFlush} ${s.rise}`} style={at(4)} aria-label="Where you stand">
      <div className={s.stats}>
        {stats.map((st) => (
          <Link key={st.key} href={st.href} className={s.stat}>
            <span className={s.statK}>{st.label}</span>
            <span className={s.statV}>{st.value}</span>
            <span className={s.statS}>{st.sub}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ the trays

function TrayHead({ title, sub, onBack }: { title: ReactNode; sub?: ReactNode; onBack?: () => void }) {
  const close = useCloseTray();
  return (
    <header className={s.trayHead}>
      {onBack && (
        <button type="button" className={s.roundBtn} onClick={onBack} aria-label="Back to all your coins">
          <Glyph name="back" size={12} />
        </button>
      )}
      <div className={s.trayTitles}>
        <h2 className={s.trayTitle}>{title}</h2>
        {sub && <p className={s.traySub}>{sub}</p>}
      </div>
      <button type="button" className={s.roundBtn} onClick={close} aria-label="Close">
        <Glyph name="close" size={12} />
      </button>
    </header>
  );
}

function CoinTray({ c, alert, example, now, onBack }: { c: BagCoin; alert?: Alert; example: boolean; now: number; onBack?: () => void }) {
  const report = example ? "/delphi" : (c.reportUrl ?? "/delphi");
  const change = alert
    ? alert.kind === "creator-sold"
      ? `Its creator sold ${(alert.soldPct ?? 0).toFixed(1)}% of the supply${now ? ` ${ago(alert.at, now)}` : ""}.`
      : `It was ${(LABEL[(alert.from as Verdict) ?? "CLEAN"] ?? alert.from).toLowerCase()} until ${now ? ago(alert.at, now) : "this week"}.`
    : null;
  return (
    <>
      <TrayHead title={<span className={s.mono}>{ticker(c)}</span>} sub={[c.name, c.venue ? `on ${VENUE[c.venue] ?? c.venue}` : null].filter(Boolean).join(" · ") || short(c.token)} onBack={onBack} />
      <div className={s.trayBody}>
        <p className={s.trayVerdict}>
          <Pill v={c.verdict} />
          {change && <span>{change}</span>}
        </p>
        <p className={s.trayReason}>{c.reason}</p>
        {((c.findings?.length ?? 0) > 0 || (c.notes?.length ?? 0) > 0) && (
          <>
            <p className={s.label}>What DELPHI found</p>
            <ul className={s.findings}>
              {c.findings?.map((f, i) => (
                <li key={i} data-s={f.severity}>
                  <p>{f.text}</p>
                  {f.evidence.length > 0 && (
                    <p className={s.proof}>
                      {f.evidence.map((e) =>
                        e.url.startsWith("http") ? (
                          <a key={e.tx} href={e.url} target="_blank" rel="noreferrer">
                            {e.what} · {short(e.tx)} ↗
                          </a>
                        ) : (
                          <span key={e.tx}>
                            {e.what} · {short(e.tx)}
                          </span>
                        ),
                      )}
                    </p>
                  )}
                </li>
              ))}
              {c.notes?.map((n, i) => (
                <li key={`n${i}`} data-s="note">
                  <p>{n}</p>
                </li>
              ))}
            </ul>
          </>
        )}
        <dl className={s.trayFacts}>
          <div>
            <dt>You hold</dt>
            <dd>
              {amount(c.amount)} {ticker(c)}
            </dd>
          </div>
          {c.scannedAt && now > 0 && (
            <div>
              <dt>DELPHI read it</dt>
              <dd>{ago(c.scannedAt, now)}</dd>
            </div>
          )}
        </dl>
        {c.stale && <p className={s.trayNote}>This verdict is older than usual. DELPHI will read it again soon.</p>}
        <div className={s.trayActs}>
          <Link href={report} className={s.inkBtn}>
            DELPHI’s report
          </Link>
          {c.disputeUrl && !example && (
            <Link href={c.disputeUrl} className={s.ghostBtn}>
              Dispute
            </Link>
          )}
        </div>
        <p className={s.trayFine}>{c.verdict === "CLEAN" ? "Clean means nothing was found so far, never that a coin is safe." : "Patterns DELPHI found on-chain, not advice."}</p>
      </div>
    </>
  );
}

function AllTray({ bag, onPick }: { bag: Bag; onPick: (i: number) => void }) {
  return (
    <>
      <TrayHead title="Your bag" sub={`${bag.coins.length} coins, worst first`} />
      <div className={s.trayBody}>
        <ul className={s.allList}>
          {bag.coins.map((c, i) => (
            <li key={c.token}>
              <button type="button" className={s.allRow} onClick={() => onPick(i)}>
                <Pill v={c.verdict} />
                <span className={s.mono}>{ticker(c)}</span>
                <span className={s.allAmt}>{amount(c.amount)}</span>
                <span className={s.chev} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

function AboutTray({ bag, now }: { bag: Bag; now: number }) {
  const keys: Array<[Verdict, string]> = [
    ["FLAG", "Flagged: DELPHI found a pattern worth your attention."],
    ["WATCH", "Watch: something to keep an eye on."],
    ["CLEAN", "Clean so far: every check passed."],
    ["NOT_ENOUGH_DATA", "Too new or too quiet to judge yet."],
  ];
  return (
    <>
      <TrayHead title="About your bag" sub={now ? `Read ${ago(bag.readAt, now)}` : undefined} />
      <div className={s.trayBody}>
        <ul className={s.legend}>
          {keys.map(([v, text]) => (
            <li key={v}>
              <span className={s.swatch}>
                <i className={s[`k${v}`]} />
              </span>
              {text}
            </li>
          ))}
        </ul>
        <div className={s.aboutNotes}>
          <p>Worst first. Clean means nothing was found so far, never that a coin is safe.</p>
          {bag.sentIn.length > 0 && (
            <p>
              {bag.sentIn.length} {bag.sentIn.length === 1 ? "coin was" : "coins were"} only ever sent to you by others. They’re left out, so a stranger can’t change your bag.
            </p>
          )}
          {!bag.wholeWallet && <p>Only coins DELPHI checks are listed here; other tokens in your wallet aren’t.</p>}
          {bag.unread.length > 0 && (
            <p>
              {bag.unread.length} {bag.unread.length === 1 ? "coin" : "coins"} couldn’t be read just now, so this isn’t final.
            </p>
          )}
        </div>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ PANTHEON's 7 × 7 pixel glyphs

const GLYPHS: Record<GlyphName | "close" | "back" | "info", string[]> = {
  claim: ["...#...", "...#...", ".#.#.#.", "..###..", "...#...", "#.....#", "#######"],
  vote: [".......", "......#", ".....#+", "#...#+.", "+#.#+..", ".+#+...", "..+...."],
  refresh: [".####..", "#....#.", "#.....#", "#...###", "#....#.", ".#.....", "..####."],
  stake: [".......", ".....#.", ".....#.", "...#.#.", "...#.#.", ".#.#.#.", ".#.#.#."],
  passport: ["#######", "#.....#", "#..#..#", "#.###.#", "#.###.#", "#.....#", "#######"],
  calm: [".......", "......#", ".....#.", "#...#..", ".#.#...", "..#....", "......."],
  close: ["#.....#", ".#...#.", "..#.#..", "...#...", "..#.#..", ".#...#.", "#.....#"],
  back: ["....#..", "...#...", "..#....", ".#.....", "..#....", "...#...", "....#.."],
  info: ["...#...", ".......", "..##...", "...#...", "...#...", "...#...", "..###.."],
};

function Glyph({ name, size = 14 }: { name: keyof typeof GLYPHS; size?: number }) {
  return (
    <svg viewBox="0 0 7 7" width={size} height={size} shapeRendering="crispEdges" aria-hidden="true">
      {GLYPHS[name].flatMap((row, y) =>
        [...row].map((ch, x) => (ch === "." ? null : <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" fill="currentColor" fillOpacity={ch === "+" ? 0.45 : 1} />)),
      )}
    </svg>
  );
}
