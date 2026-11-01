"use client";

// "Get uploaded", step one: connect a wallet. Two ways in, one primary: the browser wallet (Rabby,
// MetaMask, any wallet that announces itself), or a phone wallet over WalletConnect. Read-only:
// nothing is signed or sent here.

import { useState } from "react";
import { useConnect, useConnection, useConnectors, useDisconnect, type Connector } from "wagmi";
import { Providers } from "@/components/app/providers";
import { reason, short } from "@/components/app/shared";
import { uploadConfig } from "./upload-config";
import s from "./upload.module.css";

// 7×7 pixel glyphs, drawn in the text colour.
const pixels = (rows: string[]) =>
  rows.map((row, y) => [...row].map((c, x) => (c === "#" ? `M${x} ${y}h1v1h-1z` : "")).join("")).join("");
const WALLET = pixels([".......", "######.", "#....#.", "#..####", "#..#.##", "#..####", "######."]);
const QR = pixels(["###.#.#", "#.#..##", "###.#..", "...#.#.", "#.##..#", ".#..###", "##.#.##"]);
const LOCK = pixels(["..###..", ".#...#.", ".#...#.", "#######", "#######", "#######", "#######"]);

function Glyph({ d, size = 16 }: { d: string; size?: number }) {
  return (
    <svg viewBox="0 0 7 7" width={size} height={size} fill="currentColor" shapeRendering="crispEdges" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

function Arrow() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3.5 8h9m-3.5-3.5L12.5 8 9 11.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Chevron() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M6 3.5 10.5 8 6 12.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Waiting on the wallet: eight squares round a ring, a dark one chasing clockwise.
const RING = [[0, 0], [2.5, 0], [5, 0], [5, 2.5], [5, 5], [2.5, 5], [0, 5], [0, 2.5]];
function Spinner() {
  return (
    <svg viewBox="0 0 7 7" width="14" height="14" shapeRendering="crispEdges" className={s.spin} aria-hidden="true">
      {RING.map(([x, y], i) => (
        <rect key={`${x}-${y}`} x={x} y={y} width="2" height="2" style={{ animationDelay: `${(i - 8) / 10}s` }} />
      ))}
    </svg>
  );
}

/** "Connect wallet" opens the one browser wallet if exactly one announced itself (EIP-6963), else
 * whichever answers as window.ethereum, like the other app screens. With none: a phone wallet. */
function browserWallet(connectors: readonly Connector[]) {
  const announced = connectors.filter((c) => c.type === "injected" && c.id !== "injected");
  if (announced.length === 1) return announced[0];
  if ("ethereum" in window) return connectors.find((c) => c.id === "injected");
  return announced[0];
}

const walletName = (c: Connector | null) =>
  !c || c.id === "injected" ? "your wallet" : c.type === "walletConnect" ? "your wallet app" : c.name;

function Actions() {
  const { address, status } = useConnection();
  const connectors = useConnectors();
  const connect = useConnect();
  const disconnect = useDisconnect();
  const [used, setUsed] = useState<{ way: "browser" | "phone"; connector: Connector } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const phone = connectors.find((c) => c.type === "walletConnect");

  const open = (way: "browser" | "phone") => {
    setNotice(null);
    const connector = way === "phone" ? phone : (browserWallet(connectors) ?? phone ?? connectors.find((c) => c.id === "injected"));
    if (!connector) {
      setNotice("Phone wallets aren’t switched on here yet. Use Connect wallet for now.");
      return;
    }
    setUsed({ way, connector });
    connect.mutate({ connector });
  };

  const note = (
    <p className={s.note}>
      <Glyph d={LOCK} size={12} />
      Read-only. No network fee, and no seed phrase, ever.
    </p>
  );

  if (status === "connected" && address) {
    return (
      <div className={s.way}>
        <div className={s.actions}>
          <div className={s.connected}>
            <span className={s.lead} aria-hidden="true">
              <span className={s.live} />
            </span>
            <span className={s.txt}>
              <span className={s.t}>Connected</span>
              <span className={s.c}>{short(address)}</span>
            </span>
            <button type="button" className={s.disconnect} onClick={() => disconnect.mutate()}>
              Disconnect
            </button>
          </div>
        </div>
        {note}
      </div>
    );
  }

  const busy = connect.isPending;
  const busyBrowser = busy && used?.way === "browser";
  const busyPhone = busy && used?.way === "phone";
  // Closing the QR window is a choice, not a failure: no message for it.
  const closedQr = used?.connector.type === "walletConnect" && /rejected|reset/i.test(connect.error?.message ?? "");
  const problem = notice ?? (connect.error && !closedQr ? reason(connect.error) : null);

  return (
    <div className={s.way}>
      <div className={s.actions}>
        <button type="button" className={`${s.btn} ${s.primary}`} disabled={busy} aria-busy={busyBrowser} onClick={() => open("browser")}>
          <span className={s.lead}>
            <Glyph d={WALLET} />
          </span>
          <span className={s.txt}>
            <span className={s.t}>{busyBrowser ? "Opening your wallet…" : "Connect wallet"}</span>
            <span className={s.c}>{busyBrowser ? `Approve the connection in ${walletName(used?.connector ?? null)}` : "Rabby, MetaMask, Coinbase and more"}</span>
          </span>
          <span className={s.end} aria-hidden="true">
            {busyBrowser ? <Spinner /> : <Arrow />}
          </span>
        </button>
        <button type="button" className={`${s.btn} ${s.secondary}`} disabled={busy} aria-busy={busyPhone} onClick={() => open("phone")}>
          <span className={s.lead}>
            <Glyph d={QR} />
          </span>
          <span className={s.txt}>
            <span className={s.t}>Scan with your phone</span>
            <span className={s.c}>Any wallet app that scans a QR code</span>
          </span>
          <span className={s.end} aria-hidden="true">
            {busyPhone ? <Spinner /> : <Chevron />}
          </span>
        </button>
      </div>
      {problem && (
        <p className={s.error} role="alert">
          {problem}
        </p>
      )}
      {note}
    </div>
  );
}

export function Connect() {
  return (
    <Providers config={uploadConfig}>
      <Actions />
    </Providers>
  );
}
