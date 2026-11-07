"use client";

// The frame every inside page sits in, with one wallet connection for all of them.
// On a computer: one glass bar across the top with PANTHEON's mark (the way back out to the site), the
// places, Create and your wallet. On a phone: the mark, Create and your wallet at the top; the places in a
// floating glass bar at the bottom. DELPHI's orb waits in the bottom corner of every page: one click and
// you're on her page. Your wallet's menu holds your Passport, Copy address and Disconnect.
// Glass is only on this frame, the layer that floats over the pages (Apple's rule for Liquid Glass).

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useDisconnect, useSwitchChain } from "wagmi";
import { useHydratedConnection } from "@/lib/use-hydrated-connection";
import { CodeWordmark } from "@/components/code-type/code-wordmark";
import { reason, short } from "@/components/app/shared";
import { elysium } from "@/lib/chain/config";
import { DelphiOrb } from "./delphi-orb";
import s from "./app-frame.module.css";

type Glyph = "space" | "delphi" | "basket" | "stake" | "trials" | "plus" | "passport" | "copy" | "check" | "exit" | "launch";
type Place = { label: string; href: string | null; glyph: Glyph };

const PLACES: Place[] = [
  { label: "Space", href: "/space", glyph: "space" },
  { label: "DELPHI", href: "/delphi/chat", glyph: "delphi" },
  { label: "Basket", href: null, glyph: "basket" },
  { label: "Stake", href: "/stake", glyph: "stake" },
  { label: "Trials", href: "/trials/vote", glyph: "trials" },
];
// On a phone DELPHI is her orb at the end of the bar, so the bar itself holds the other four.
const PHONE_PLACES = PLACES.filter((p) => p.glyph !== "delphi");

const here = (pathname: string, href: string | null) => !!href && (pathname === href || pathname.startsWith(`${href}/`) || (href === "/trials/vote" && pathname.startsWith("/trials")));

// ------------------------------------------------------------------ the places, with a glass pill on the one you're on

function Places({ pathname, places, className, label }: { pathname: string; places: Place[]; className: string; label: string }) {
  const nav = useRef<HTMLElement>(null);
  const [pill, setPill] = useState<{ x: number; w: number; on: boolean; ready: boolean }>({ x: 0, w: 0, on: false, ready: false });
  // the pill slides to the place you're on; it appears there without sliding the first time
  useLayoutEffect(() => {
    const el = nav.current;
    if (!el) return;
    // measured when the observer first reports (straight after layout, before paint) and on every resize
    const place = () => {
      const cur = el.querySelector<HTMLElement>('[aria-current="page"]');
      setPill((p) => (cur ? { x: cur.offsetLeft, w: cur.offsetWidth, on: true, ready: p.ready || p.on } : { ...p, on: false }));
    };
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
  }, [pathname]);
  return (
    <nav ref={nav} className={className} aria-label={label}>
      <span
        className={s.pill}
        data-on={pill.on || undefined}
        data-ready={pill.ready || undefined}
        style={{ "--x": `${pill.x}px`, "--w": `${pill.w}px` } as CSSProperties}
        aria-hidden="true"
      />
      {places.map(({ label: name, href, glyph }) =>
        href ? (
          <Link key={name} className={s.place} href={href} aria-current={here(pathname, href) ? "page" : undefined}>
            <Glyph name={glyph} />
            <span>{name}</span>
          </Link>
        ) : (
          <span key={name} className={`${s.place} ${s.soon}`} aria-disabled="true" title={`${name} opens soon`}>
            <Glyph name={glyph} />
            <span>{name}</span>
            <small>soon</small>
          </span>
        ),
      )}
    </nav>
  );
}

// ------------------------------------------------------------------ a small menu that opens from a button

function Menu({ trigger, label, className, children }: { trigger: ReactNode; label: string; className: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLElement>("a, button")?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <div
      className={s.menu}
      ref={root}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button ref={button} className={className} type="button" aria-label={label} aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        {trigger}
      </button>
      <div ref={panel} id={id} className={s.popover} data-open={open || undefined} hidden={!open}>
        {children(() => setOpen(false))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ your wallet

/** A wallet's own small mark: a 5 × 5 pattern of dots, mirrored, from its address. Your space wears it too. */
export function Mark({ address, size = 22 }: { address: string; size?: number }) {
  let h = 2166136261;
  for (const ch of address.toLowerCase()) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  const cells: [number, number][] = [];
  for (let y = 0; y < 5; y++)
    for (let x = 0; x < 3; x++) {
      if ((h >>> (y * 3 + x)) & 1) {
        cells.push([x, y]);
        if (x < 2) cells.push([4 - x, y]);
      }
    }
  return (
    <svg className={s.walletMark} viewBox="-1.5 -1.5 8 8" width={size} height={size} aria-hidden="true" shapeRendering="crispEdges">
      {cells.map(([x, y]) => (
        <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" fill="currentColor" />
      ))}
    </svg>
  );
}

function Wallet() {
  const { address, isConnected, chainId } = useHydratedConnection();
  const disconnect = useDisconnect();
  const switchChain = useSwitchChain();
  const [copied, setCopied] = useState(false);

  if (!isConnected || !address)
    return (
      <Link className={s.getUploaded} href="/upload">
        Get uploaded
      </Link>
    );
  if (chainId !== elysium.id)
    return (
      <div className={s.menu}>
        <button className={s.chip} type="button" disabled={switchChain.isPending} onClick={() => switchChain.mutate({ chainId: elysium.id })}>
          {switchChain.isPending ? "Switching…" : "Switch to Elysium"}
        </button>
        {switchChain.error && (
          <p role="alert" className={s.error}>
            {reason(switchChain.error)}
          </p>
        )}
      </div>
    );
  const copy = () => {
    navigator.clipboard?.writeText(address).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    }, () => {});
  };
  return (
    <Menu
      key={address}
      className={s.chip}
      label={`Your wallet, ${short(address)}`}
      trigger={
        <>
          <Mark address={address} />
          <span className={s.address}>{short(address)}</span>
          <span className={s.chevron} aria-hidden="true" />
        </>
      }
    >
      {(close) => (
        <>
          <div className={s.who}>
            <Mark address={address} size={34} />
            <div>
              <p className={s.whoAddress}>{short(address)}</p>
              <p className={s.whoChain}>Elysium</p>
            </div>
          </div>
          <Link href="/passport/me" onClick={close}>
            <Glyph name="passport" />
            Your Passport
          </Link>
          <button type="button" onClick={copy}>
            <Glyph name={copied ? "check" : "copy"} />
            {copied ? "Copied" : "Copy address"}
          </button>
          <button
            type="button"
            onClick={() => {
              close();
              disconnect.mutate();
            }}
          >
            <Glyph name="exit" />
            Disconnect
          </button>
        </>
      )}
    </Menu>
  );
}

// ------------------------------------------------------------------ the frame

export function AppFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (pathname === "/upload") return children;
  const atDelphi = pathname.startsWith("/delphi");

  return (
    <div className={s.frame}>
      <header className={s.bar}>
        <div className={s.barIn}>
          <Link className={s.mark} href="/" aria-label="PANTHEON, back to the site">
            <CodeWordmark text="PANTHEON" module={2.2} />
          </Link>
          <Places pathname={pathname} places={PLACES} className={s.topPlaces} label="App" />
          <div className={s.actions}>
            <Menu
              key={`create:${pathname}`}
              className={s.create}
              label="Create"
              trigger={
                <>
                  <Glyph name="plus" />
                  <span className={s.createWord}>Create</span>
                </>
              }
            >
              {(close) => (
                <Link href="/covenant/launch" onClick={close}>
                  <Glyph name="launch" />
                  Launch a coin
                </Link>
              )}
            </Menu>
            <Wallet key={`wallet:${pathname}`} />
          </div>
        </div>
      </header>
      <div className={s.content}>{children}</div>
      <div className={s.dock}>
        <Places pathname={pathname} places={PHONE_PLACES} className={s.bottomPlaces} label="App" />
        {!atDelphi && <DelphiOrb />}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ PANTHEON's 7 × 7 pixel glyphs ("+" is a half-tone pixel)

const GLYPHS: Record<Glyph, string[]> = {
  // a home
  space: ["...#...", "..#.#..", ".#...#.", "#######", ".#...#.", ".#.#.#.", ".#####."],
  // an eye: the oracle
  delphi: [".......", "..###..", ".#+++#.", "#+.#.+#", ".#+++#.", "..###..", "......."],
  // the basket's temple
  basket: ["...#...", "..###..", "#######", ".#.#.#.", ".#.#.#.", ".#.#.#.", "#######"],
  // bars that grow: what a stake earns
  stake: [".......", ".....#.", ".....#.", "...#.#.", "...#.#.", ".#.#.#.", ".#.#.#."],
  // a tick: a vote cast
  trials: [".......", "......#", ".....#+", "#...#+.", "+#.#+..", ".+#+...", "..+...."],
  plus: ["...#...", "...#...", "...#...", "#######", "...#...", "...#...", "...#..."],
  passport: ["#######", "#.....#", "#..#..#", "#.###.#", "#.###.#", "#.....#", "#######"],
  copy: ["..#####", "..#...#", "###...#", "#.#...#", "#.#####", "#...#..", "#####.."],
  check: [".......", "......#", ".....#.", "#...#..", ".#.#...", "..#....", "......."],
  exit: ["####...", "#......", "#...#..", "#.#####", "#...#..", "#......", "####..."],
  launch: ["...#...", "..###..", "..#.#..", "..###..", ".#####.", "#.#.#.#", "..+.+.."],
};

function Glyph({ name }: { name: Glyph }) {
  return (
    <svg className={s.glyph} viewBox="0 0 7 7" width="14" height="14" shapeRendering="crispEdges" aria-hidden="true">
      {GLYPHS[name].flatMap((row, y) =>
        [...row].map((ch, x) => (ch === "." ? null : <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" fill="currentColor" fillOpacity={ch === "+" ? 0.45 : 1} />)),
      )}
    </svg>
  );
}
