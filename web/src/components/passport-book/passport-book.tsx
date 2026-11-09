"use client";

// Your Passport: the HYPE Passport as a floating card with a liquid-glass lens riding on it, and its
// second page, the stamps, each pressed in under a bubble of the same glass. Everything shown is read
// from the registry on Elysium. Disconnected wallets get a labelled preview.

import { networkLabel } from "@/lib/network-copy";
import Link from "next/link";
import { ConnectWallet } from "@/components/app/connect-wallet";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { zeroAddress } from "viem";
import { useReadContracts } from "wagmi";
import { hypePassportRegistryAbi } from "@/lib/chain/abi";
import { deployment, elysium } from "@/lib/chain/config";
import type { Deployment } from "@/lib/chain/deployments";
import { useHydratedConnection } from "@/lib/use-hydrated-connection";
import { type Hex } from "@/components/app/shared";
import a from "@/components/app/app.module.css";
import { createCard, type Layout } from "./card";
import { createStamps } from "./stamps";
import { loadFonts, readFonts, type FinishName } from "./draw";
import { EXAMPLE, TIER_NAMES, dmy, extraVotes, registryView, type PassportView } from "./view";
import { PassportShare } from "./share";
import s from "./passport-book.module.css";

export function PassportBook({ publicAddress }: { publicAddress?: Hex }) {
  return deployment ? <Live d={deployment} publicAddress={publicAddress} /> : <State title="Passport unavailable" note="PANTHEON isn’t live on this network yet." />;
}

function Live({ d, publicAddress }: { d: Deployment; publicAddress?: Hex }) {
  const { address, isConnected, chainId } = useHydratedConnection();
  const onChain = !!publicAddress || (isConnected && chainId === elysium.id);
  const me = (publicAddress ?? address ?? zeroAddress) as Hex;
  const chain = useReadContracts({
    chainId: elysium.id,
    contracts: [
      { address: d.passportRegistry, abi: hypePassportRegistryAbi, functionName: "passportOf", args: [me] },
      { address: d.passportRegistry, abi: hypePassportRegistryAbi, functionName: "isValid", args: [me] },
      { address: d.passportRegistry, abi: hypePassportRegistryAbi, functionName: "multiplierOf", args: [me] },
    ],
    query: { enabled: onChain, refetchInterval: 30_000, retry: 1 },
  });
  const p = chain.data?.[0]?.result;
  const valid = chain.data?.[1]?.result;
  const mult = chain.data?.[2]?.result;
  const view = useMemo<PassportView | null>(() => {
    if (!onChain || !p || valid === undefined || mult === undefined) return null;
    return registryView(me, p, valid, mult);
  }, [onChain, valid, p, me, mult]);
  if (!publicAddress && !isConnected) return <Book key="example" view={null} note="Connect your Elysium wallet to see your passport. This is a labelled example, not your data." />;
  if (!onChain) return <State title="Switch to Elysium" note={`Your Passport lives on ${networkLabel}.`}><ConnectWallet /></State>;
  if (chain.isPending) return <State title="Reading your passport…" note="Checking the public registry." />;
  if (chain.isError || chain.data?.some(r => r.status === "failure") || !p || valid === undefined || mult === undefined) return <State title="Couldn't read your passport" note="The registry is unavailable. This does not mean you have no passport."><button type="button" className={s.action} onClick={() => void chain.refetch()}>Retry</button></State>;
  if (!view) return <State title="No passport yet" note={`${me.slice(0, 6)}…${me.slice(-4)} has no Passport in the public registry.`}><Link className={s.action} href="/passport/get">Get your Passport</Link><PassportShare wallet={me} /></State>;
  return <Book key={me} view={view} note={view.status === "Expired" ? `Expired on ${dmy(view.valid)}. Your recorded tier and stamps remain visible; boosts and extra votes are inactive.` : view.status === "Inactive" ? "This registry record is inactive. Boosts and extra votes are inactive." : null} publicPage={!!publicAddress} />;
}

function State({ title, note, children }: { title: string; note: string; children?: React.ReactNode }) {
  return <main className={a.page}><header className={a.head}><div><p className={a.eyebrow}>App · {networkLabel}</p><h1 className={a.h1}>HYPE Passport</h1></div></header><section className={s.state}><h2>{title}</h2><p>{note}</p><div className={s.actions}>{children}</div></section></main>;
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

function Book({ view, note, publicPage = false }: { view: PassportView | null; note: string | null; publicPage?: boolean }) {
  const shown = view ?? EXAMPLE;
  const [finish, setFinish] = useState<FinishName>("ink");
  const wrap = useRef<HTMLDivElement>(null);
  const scene = useRef<HTMLDivElement>(null);
  const floor = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const face = useRef<HTMLCanvasElement>(null);
  const glass = useRef<HTMLDivElement>(null);
  const stamps = useRef<HTMLElement>(null);
  const stampsFace = useRef<HTMLCanvasElement>(null);
  const stampsGlass = useRef<HTMLDivElement>(null);
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
    const { wrap: w, scene: sc, floor: fl, card: cd, face: fc, glass: glassHost, stamps: st, stampsFace: sf, stampsGlass: stampsGlassHost, hits: ht } = els as { [K in keyof typeof els]: NonNullable<(typeof els)[K]> };
    // Activity preserves DOM but restarts effects; a released WebGL canvas cannot be reused.
    const gl = document.createElement("canvas"), sg = document.createElement("canvas");
    gl.className = s.glass;
    sg.className = `${s.stampsCanvas} ${s.stampsGlass}`;
    glassHost.appendChild(gl);
    stampsGlassHost.appendChild(sg);
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
      gl.remove();
      sg.remove();
    };
  }, []);

  const tierName = TIER_NAMES[shown.tier] ?? "";
  const cardLabel = `${shown.example ? "Example HYPE Passport" : "HYPE Passport"}: tier ${shown.tier}, ${tierName}. Staking boost ${shown.boost}, ${extraVotes(shown)} extra Trials votes. ${shown.status ?? "Example"}. Expires ${dmy(shown.valid)}.`;
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
          <p className={a.eyebrow}>App · {networkLabel}</p>
          <h1 className={a.h1}>{publicPage ? "HYPE Passport" : "Your Passport"}</h1>
          <p className={a.sub}>Public Elysium registry facts. Never your Hyperliquid address or balances.</p>
        </div>
      </header>

      <div ref={wrap} className={s.book}>
        {note && (
          <p className={s.note} aria-live="polite">
            {note}
            {view?.status === "Expired" && <> <Link href="/passport/get">Refresh passport</Link></>}
          </p>
        )}
        {!publicPage && <ConnectWallet />}
        {view && <div className={s.actions}><PassportShare wallet={view.wallet} view={view} /></div>}
        <p className={s.eyebrow}>PANTHEON · {shown.example ? "Example passport · preview only" : "Public registry record"}</p>
        <div ref={scene} className={s.scene}>
          <div ref={floor} className={s.floor} />
          <div ref={card} className={s.card} tabIndex={0} role="img" aria-label={cardLabel}>
            <canvas ref={face} className={s.face} />
            <div ref={glass} className={s.glassHost} />
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
        {view && <dl className={s.facts} aria-label="Passport facts">
          {[["Tier", `${tierName}${view.status !== "Valid" ? " (recorded)" : ""}`], ["Staking boost", view.boost], ["Extra Trials votes", `+${extraVotes(view)}`], ["Stamps earned", `${view.stamps.length}/8`], ["Issued", dmy(view.issued)], ["Expires", dmy(view.valid)], ["Linked", dmy(view.linked)], ["Status", view.status ?? "Valid"], ["Elysium wallet", view.wallet]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
        </dl>}
        <section ref={stamps} className={s.stamps} aria-labelledby="passport-stamps">
          <h2 className={s.sr} id="passport-stamps">
            Stamps: {shown.stamps.length} of 8
          </h2>
          <canvas ref={stampsFace} className={s.stampsCanvas} aria-hidden="true" />
          <div ref={stampsGlass} className={s.glassHost} aria-hidden="true" />
          <div ref={hits} className={s.hits} />
        </section>
      </div>
    </main>
  );
}
