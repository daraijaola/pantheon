"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useConnection, useDisconnect, useSwitchChain } from "wagmi";
import { CodeWordmark } from "@/components/code-type/code-wordmark";
import { reason, short } from "@/components/app/shared";
import { elysium } from "@/lib/chain/config";
import s from "./app-frame.module.css";

const ITEMS = [
  { label: "Space", href: null },
  { label: "DELPHI", href: "/delphi/chat" },
  { label: "Basket", href: null },
  { label: "Stake", href: "/stake" },
  { label: "Trials", href: "/trials/vote" },
] as const;

function Navigation({ pathname }: { pathname: string }) {
  return ITEMS.map(({ label, href }) => href ? (
    <Link key={label} className={s.tab} href={href} aria-current={pathname === href || pathname.startsWith(`${href}/`) ? "page" : undefined}>
      {label}
    </Link>
  ) : (
    <span key={label} className={`${s.tab} ${s.soon}`} aria-disabled="true">
      {label}<small>soon</small>
    </span>
  ));
}

function Disclosure({ label, children }: { label: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
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
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <div className={s.disclosure} ref={root} onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }}>
      <button ref={trigger} className={s.chip} type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        {label}<span className={s.chevron} aria-hidden="true" />
      </button>
      <div ref={panel} id={id} className={s.popover} hidden={!open}>
        {children(() => setOpen(false))}
      </div>
    </div>
  );
}

function WalletIdentity() {
  const { address, isConnected, chainId } = useConnection();
  const disconnect = useDisconnect();
  const switchChain = useSwitchChain();

  if (!isConnected) return <Link className={s.chip} href="/upload">Get uploaded</Link>;
  if (chainId !== elysium.id) return (
    <div className={s.disclosure}>
      <button className={s.chip} type="button" disabled={switchChain.isPending} onClick={() => switchChain.mutate({ chainId: elysium.id })}>
        {switchChain.isPending ? "Switching…" : "Switch to Elysium"}
      </button>
      {switchChain.error && <p role="alert" className={s.error}>{reason(switchChain.error)}</p>}
    </div>
  );
  return (
    <Disclosure key={address} label={short(address ?? "")}>
      {(close) => <>
        <Link href="/passport/me" onClick={close}>Your Passport</Link>
        <button type="button" onClick={() => { close(); disconnect.mutate(); }}>Disconnect</button>
      </>}
    </Disclosure>
  );
}

export function AppFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (pathname === "/upload") return children;

  return (
    <div className={s.frame}>
      <header className={s.bar}>
        <Link className={s.mark} href="/" aria-label="PANTHEON home"><CodeWordmark text="PANTHEON" module={2.2} /></Link>
        <nav className={s.desktopNav} aria-label="App"><Navigation pathname={pathname} /></nav>
        <div className={s.actions}>
          <Disclosure key={`create:${pathname}`} label="Create">
            {(close) => <Link href="/covenant/launch" onClick={close}>Launch a coin</Link>}
          </Disclosure>
          <WalletIdentity key={`wallet:${pathname}`} />
        </div>
      </header>
      <div className={s.content}>{children}</div>
      <nav className={s.mobileNav} aria-label="App"><Navigation pathname={pathname} /></nav>
    </div>
  );
}
