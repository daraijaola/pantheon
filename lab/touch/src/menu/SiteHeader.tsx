// The site header. The landing page explains the core in three sections; everything else lives
// behind one "Explore" button. On a computer it opens on hover as a panel across the page (Firecrawl's
// layout: three columns, one item per row, a tiny icon each, ours glitching in our code
// signature). On a phone the same items open as a full-screen sheet.

import { useEffect, useRef, useState } from "react";
import { CodeWordmark } from "../code-type/code-wordmark";
import { GlitchIcon } from "./GlitchIcon";
import type { IconName } from "./icons";
import { A } from "./link";
import { MiniTemple } from "./MiniTemple";
import m from "./menu.module.css";

const OUT = {
  github: "https://github.com/daraijaola/pantheon",
  x: "https://x.com/pantheonindex",
  ascend: "https://ascendlaunch.xyz",
};

type Item = { icon: IconName; title: string; desc: string; href?: string }; // no href = coming soon
const FEATURES: Item[] = [
  { icon: "passport", title: "HYPE Passport", desc: "Prove you hold HYPE. Earn up to 1.25× and get a vote.", href: "/passport" },
  { icon: "trials", title: "The Trials", desc: "Vote coins into the basket.", href: "/trials" },
  { icon: "covenant", title: "Covenant", desc: "The ownerless contract every fee goes through.", href: "/covenant" },
  { icon: "delphi", title: "DELPHI", desc: "An AI that checks every coin for cheating and shows its proof.", href: "/delphi" },
];
const RESOURCES: Item[] = [
  { icon: "terms", title: "Terms of use", desc: "The plain rules for using this site.", href: "/terms" },
  { icon: "github", title: "GitHub", desc: "The code behind PANTHEON.", href: OUT.github },
  { icon: "x", title: "X", desc: "Launch news and every basket change.", href: OUT.x },
];

const external = (href?: string) => (href?.startsWith("http") ? { target: "_blank", rel: "noreferrer" } : {});

function Row({ item, onPick }: { item: Item; onPick: () => void }) {
  const [hot, setHot] = useState(false);
  const body = (
    <>
      <GlitchIcon name={item.icon} hot={hot} />
      <span className={m.text}>
        <span className={m.title}>
          {item.title}
          {!item.href && <small className={m.soon}>soon</small>}
          {item.href?.startsWith("http") && <span className={m.ext}>↗</span>}
        </span>
        <span className={m.desc}>{item.desc}</span>
      </span>
    </>
  );
  if (!item.href) return <div className={`${m.row} ${m.off}`}>{body}</div>;
  return (
    <A href={item.href} className={m.row} onClick={onPick} onMouseEnter={() => setHot(true)} onMouseLeave={() => setHot(false)} {...external(item.href)}>
      {body}
    </A>
  );
}

function Chevron() {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" className={m.chev}>
      <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Computers with a mouse open the menu on hover; touch screens (and keyboards) use a click.
const canHover = () => window.matchMedia("(hover: hover) and (pointer: fine) and (min-width: 901px)").matches;
const LEAVE_MS = 220; // time to cross from the button down into the panel

export function SiteHeader({ code }: { code: string }) {
  const [open, setOpen] = useState(false);
  const headerRef = useRef<HTMLElement>(null);
  const leaveTimer = useRef(0);
  const close = () => {
    clearTimeout(leaveTimer.current);
    setOpen(false);
  };
  const hoverIn = () => {
    if (!canHover()) return;
    clearTimeout(leaveTimer.current);
    setOpen(true);
  };
  const hoverOut = () => {
    if (!canHover()) return;
    clearTimeout(leaveTimer.current);
    leaveTimer.current = window.setTimeout(() => setOpen(false), LEAVE_MS);
  };
  // With a mouse, a click after hovering keeps it open; on touch it toggles.
  const clickExplore = () => (canHover() ? setOpen(true) : setOpen((v) => !v));
  useEffect(() => () => clearTimeout(leaveTimer.current), []);

  // Escape closes; the page doesn't scroll behind the phone sheet.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    if (window.matchMedia("(max-width: 900px)").matches) document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  return (
    <header ref={headerRef} className={`${m.header} ${open ? m.isOpen : ""}`}>
      <div className={m.bar}>
        <A href="/" aria-label="PANTHEON home" className={m.logo} onClick={close}>
          <CodeWordmark text="PANTHEON" module={2.2} />
        </A>
        <button
          type="button"
          className={m.explore}
          aria-expanded={open}
          aria-controls="site-menu"
          onClick={clickExplore}
          onMouseEnter={hoverIn}
          onMouseLeave={hoverOut}
        >
          Explore
          <Chevron />
        </button>
        <span className={m.spacer} />
        <a href={OUT.github} className={m.ghost} {...external(OUT.github)}>
          GitHub
        </a>
        <A href="/stake" className={m.wallet}>
          Open app
        </A>
        <button type="button" className={m.burger} aria-expanded={open} aria-controls="site-menu" aria-label={open ? "Close menu" : "Open menu"} onClick={() => setOpen((v) => !v)}>
          <span />
          <span />
        </button>
      </div>

      {open && (
        <>
          <div className={m.scrim} onClick={close} aria-hidden="true" />
          <nav id="site-menu" className={m.panel} aria-label="Explore" onMouseEnter={hoverIn} onMouseLeave={hoverOut}>
            <section className={m.col}>
              <p className={m.colHead}>Features</p>
              {FEATURES.map((it) => (
                <Row key={it.title} item={it} onPick={close} />
              ))}
            </section>
            <section className={m.col}>
              <p className={m.colHead}>Resources</p>
              {RESOURCES.map((it) => (
                <Row key={it.title} item={it} onPick={close} />
              ))}
            </section>
            <section className={`${m.col} ${m.featuredCol}`}>
              <p className={m.colHead}>Featured</p>
              <A href="/#basket" className={m.featured} onClick={close}>
                <span className={m.featuredTop}>
                  <span className={m.tag}>The basket</span>
                  <span className={m.ext}>↗</span>
                </span>
                <MiniTemple code={code} className={m.mini} />
                <span className={m.featuredText}>Up to ten coins hold it up. See which made it in.</span>
              </A>
              <a href={OUT.ascend} className={m.launch} onClick={close} {...external(OUT.ascend)}>
                <span className={m.arrow}>→</span>
                <span className={m.text}>
                  <span className={m.title}>Launching on Ascend</span>
                  <span className={m.desc}>Where PNTH will trade.</span>
                </span>
              </a>
            </section>
            <div className={m.sheetActions}>
              <A href="/get" className={m.btnInk} onClick={close}>
                Get $PNTH
              </A>
              <A href="/stake" className={m.btnGhost} onClick={close}>
                Open app
              </A>
            </div>
          </nav>
        </>
      )}
    </header>
  );
}
