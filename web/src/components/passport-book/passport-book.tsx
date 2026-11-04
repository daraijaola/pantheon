"use client";

// Your Passport: the HYPE Passport as a floating card with a liquid-glass lens riding on it, and its
// second page, the stamps, each pressed in under a bubble of the same glass. Everything shown is read
// from the registry on Elysium for the connected wallet; with no passport it shows a labelled example.

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { zeroAddress } from "viem";
import { useConnection, useReadContracts } from "wagmi";
import { hypePassportRegistryAbi } from "@/lib/chain/abi";
import { deployment, elysium } from "@/lib/chain/config";
import type { Deployment } from "@/lib/chain/deployments";
import { type Hex } from "@/components/app/shared";
import a from "@/components/app/app.module.css";
import { createCard, type Layout } from "./card";
import { createStamps } from "./stamps";
import { loadFonts, readFonts, type FinishName } from "./draw";
import { EXAMPLE, TIER_NAMES, dmy, stampNames, type PassportView } from "./view";
import s from "./passport-book.module.css";

export function PassportBook() {
  return deployment ? <Live d={deployment} /> : <Book view={null} note="PANTHEON isn’t live on testnet yet, so this is an example passport." />;
}

function Live({ d }: { d: Deployment }) {
  const { address, isConnected, chainId } = useConnection();
  const onChain = isConnected && chainId === elysium.id;
  const me = (address ?? zeroAddress) as Hex;
  const chain = useReadContracts({
    contracts: [
      { address: d.passportRegistry, abi: hypePassportRegistryAbi, functionName: "passportOf", args: [me] },
      { address: d.passportRegistry, abi: hypePassportRegistryAbi, functionName: "isValid", args: [me] },
      { address: d.passportRegistry, abi: hypePassportRegistryAbi, functionName: "multiplierOf", args: [me] },
    ],
    query: { enabled: onChain, refetchInterval: 30_000 },
  });
  const p = chain.data?.[0].result;
  const valid = chain.data?.[1].result ?? false;
  const mult = chain.data?.[2].result;
  const view = useMemo<PassportView | null>(() => {
    if (!onChain || !valid || !p || p.tier === 0) return null;
    return {
      wallet: me.toLowerCase(),
      tier: p.tier,
      issued: new Date(Number(p.issuedAt) * 1000),
      valid: new Date(Number(p.expiry) * 1000),
      linked: new Date(Number(p.linkedAt) * 1000),
      stamps: stampNames(p.stamps),
      boost: `${(Number(mult ?? 10n ** 18n) / 1e18).toFixed(2)}×`,
      example: false,
    };
  }, [onChain, valid, p, me, mult]);
  const note = !isConnected
    ? "Connect your Elysium wallet to see your passport. Until then, this is an example."
    : !onChain
      ? "Switch to Elysium testnet to see your passport. Until then, this is an example."
      : chain.isPending
        ? "Reading your passport…"
        : view
          ? null
          : "This wallet has no passport yet, so this is an example.";
  return <Book view={view} note={note} getOne={onChain && !chain.isPending && !view} />;
}

const FINISHES: FinishName[] = ["ink", "paper"];

/** The page is laid out wide (computers) or tall (phones), never taller than the screen leaves for it. */
function layoutFor(width: number, screenH: number, dpr: number): Layout {
  const avail = Math.min(width, 820);
  const tall = avail < 560;
  const LW = tall ? 360 : 760, LH = tall ? 600 : 520;
  const fitH = tall ? Math.max(500, screenH - 110) : Math.max(300, screenH - 230);
  const W = Math.min(LW * (tall ? 1.25 : 1), avail, (fitH * LW) / LH);
  return { tall, W, s: W / LW, dpr: Math.min(dpr || 1, 3) };
}

function Book({ view, note, getOne = false }: { view: PassportView | null; note: string | null; getOne?: boolean }) {
  const shown = view ?? EXAMPLE;
  const [finish, setFinish] = useState<FinishName>("ink");
  const wrap = useRef<HTMLDivElement>(null);
  const scene = useRef<HTMLDivElement>(null);
  const floor = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const face = useRef<HTMLCanvasElement>(null);
  const glass = useRef<HTMLCanvasElement>(null);
  const stamps = useRef<HTMLElement>(null);
  const stampsFace = useRef<HTMLCanvasElement>(null);
  const stampsGlass = useRef<HTMLCanvasElement>(null);
  const hits = useRef<HTMLDivElement>(null);
  const engines = useRef<{ card: ReturnType<typeof createCard>; stamps: ReturnType<typeof createStamps> } | null>(null);
  const latest = useRef({ view: shown, finish });

  // Hand the engines whatever the page now shows.
  useEffect(() => {
    latest.current = { view: shown, finish };
    engines.current?.card.set(shown, finish);
    engines.current?.stamps.set(shown, finish);
  }, [shown, finish]);

  // Start the card and the stamps once the fonts they draw with are in, and lay them out again when
  // the width changes (or the height, by more than a phone's toolbars coming and going).
  useEffect(() => {
    const els = { wrap: wrap.current, scene: scene.current, floor: floor.current, card: card.current, face: face.current, glass: glass.current, stamps: stamps.current, stampsFace: stampsFace.current, stampsGlass: stampsGlass.current, hits: hits.current };
    if (Object.values(els).some((e) => !e)) return;
    const { wrap: w, scene: sc, floor: fl, card: cd, face: fc, glass: gl, stamps: st, stampsFace: sf, stampsGlass: sg, hits: ht } = els as { [K in keyof typeof els]: NonNullable<(typeof els)[K]> };
    const fonts = readFonts();
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let dead = false, timer = 0, lastW = 0, lastH = 0;
    const lay = () => {
      const e = engines.current;
      if (!e) return;
      lastW = w.clientWidth;
      lastH = window.innerHeight;
      const l = layoutFor(lastW, lastH, window.devicePixelRatio);
      e.card.layout(l);
      e.stamps.layout(l);
    };
    void loadFonts(fonts).then(() => {
      if (dead) return;
      const c = createCard({ scene: sc, card: cd, face: fc, glass: gl, floor: fl }, fonts, reduced);
      const sp = createStamps({ root: st, face: sf, glass: sg, hits: ht }, fonts, reduced);
      c.set(latest.current.view, latest.current.finish);
      sp.set(latest.current.view, latest.current.finish);
      engines.current = { card: c, stamps: sp };
      lay();
    });
    const ro = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (w.clientWidth === lastW && Math.abs(window.innerHeight - lastH) < 140) return;
        lay();
      }, 120);
    });
    ro.observe(w);
    return () => {
      dead = true;
      window.clearTimeout(timer);
      ro.disconnect();
      engines.current?.card.destroy();
      engines.current?.stamps.destroy();
      engines.current = null;
    };
  }, []);

  const tierName = TIER_NAMES[shown.tier] ?? "";
  const cardLabel = `${shown.example ? "Example HYPE Passport" : "Your HYPE Passport"}: tier ${shown.tier}, ${tierName}. Staking boost ${shown.boost}, ${shown.tier} extra Trials ${shown.tier === 1 ? "vote" : "votes"}. Valid until ${dmy(shown.valid)}.`;
  const onSegKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    const next = finish === "ink" ? "paper" : "ink";
    setFinish(next);
    e.currentTarget.querySelector<HTMLButtonElement>(`[data-finish="${next}"]`)?.focus();
  };

  return (
    <main className={a.page}>
      <header className={a.head}>
        <div>
          <p className={a.eyebrow}>App · Elysium testnet</p>
          <h1 className={a.h1}>Your Passport</h1>
          <p className={a.sub}>Your HYPE Passport and the stamps it carries, read from the chain. Only your tier and stamps are on it, never your Hyperliquid address or balance.</p>
        </div>
      </header>

      <div ref={wrap} className={s.book}>
        {note && (
          <p className={s.note} aria-live="polite">
            {note}
            {getOne && (
              <>
                {" "}
                <Link href="/passport/get">Get your passport</Link>
              </>
            )}
          </p>
        )}
        <p className={s.eyebrow}>PANTHEON · {shown.example ? "Example passport" : "Your passport"}</p>
        <div ref={scene} className={s.scene}>
          <div ref={floor} className={s.floor} />
          <div ref={card} className={s.card} tabIndex={0} role="img" aria-label={cardLabel}>
            <canvas ref={face} className={s.face} />
            <canvas ref={glass} className={s.glass} />
          </div>
        </div>
        <div className={s.below}>
          <p className={s.hint}>
            <span className={s.mouse}>Move over the card. The glass follows you.</span>
            <span className={s.touch}>Drag across the card. The glass follows your finger.</span>
          </p>
          <div className={s.seg} role="radiogroup" aria-label="Card finish" onKeyDown={onSegKey}>
            {FINISHES.map((f) => (
              <button key={f} type="button" role="radio" data-finish={f} aria-checked={finish === f} tabIndex={finish === f ? 0 : -1} onClick={() => setFinish(f)}>
                {f === "ink" ? "Ink" : "Paper"}
              </button>
            ))}
          </div>
        </div>
        <section ref={stamps} className={s.stamps} aria-labelledby="passport-stamps">
          <h2 className={s.sr} id="passport-stamps">
            Stamps: {shown.stamps.length} of 8
          </h2>
          <canvas ref={stampsFace} className={s.stampsCanvas} aria-hidden="true" />
          <canvas ref={stampsGlass} className={`${s.stampsCanvas} ${s.stampsGlass}`} aria-hidden="true" />
          <div ref={hits} className={s.hits} />
        </section>
      </div>
    </main>
  );
}
