"use client";

// Parts every app screen shares: the wallet bar, the transaction sender, small number/time helpers.

import Link from "next/link";
import { useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { formatUnits, parseUnits, type TransactionReceipt } from "viem";
import { useBlock, useConfig, useConnect, useConnection, useConnectors, useDisconnect, useSwitchChain, useWriteContract } from "wagmi";
import { getPublicClient, waitForTransactionReceipt } from "wagmi/actions";
import { elysium, explorer } from "@/lib/chain/config";
import s from "./app.module.css";

export type Hex = `0x${string}`;

/**
 * Send one or more transactions in order, waiting for each, then refresh every read. Returns the
 * receipts, or null if one failed. `label` can name each step ("Buying PNTH (2 of 2)").
 */
export function useTx() {
  const config = useConfig();
  const { address } = useConnection();
  const qc = useQueryClient();
  const { mutateAsync } = useWriteContract();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<Hex | null>(null);
  // Set at once on click (state only updates on the next render), so a fast double-click can't send twice.
  const running = useRef(false);

  const run = async (label: string | readonly string[], calls: readonly Parameters<typeof mutateAsync>[0][]): Promise<TransactionReceipt[] | null> => {
    if (running.current) return null;
    running.current = true;
    const step = (i: number) => `${typeof label === "string" ? label : (label[i] ?? label[label.length - 1])}…`;
    setBusy(step(0));
    setError(null);
    const receipts: TransactionReceipt[] = [];
    let pending: Hex | null = null; // sent, not yet confirmed
    try {
      for (const [i, call] of calls.entries()) {
        setBusy(step(i));
        // Rewards accrue between the estimate and the block the transaction lands in, and each one
        // costs an extra storage write, so give every action headroom over the estimate.
        const client = getPublicClient(config, { chainId: elysium.id });
        if (!client) throw new Error("No connection to Elysium.");
        const estimate = await client.estimateContractGas({ ...call, account: address } as Parameters<typeof client.estimateContractGas>[0]);
        const hash = await mutateAsync({ ...call, gas: (estimate * 3n) / 2n + 100_000n });
        pending = hash;
        setLastTx(hash);
        // The testnet RPC sometimes rate-limits: keep asking for a while before giving up.
        receipts.push(await waitForTransactionReceipt(config, { hash, timeout: 180_000, retryCount: 12, retryDelay: 2_000 }));
        pending = null;
      }
      await qc.invalidateQueries();
      return receipts;
    } catch (e) {
      // Once a transaction is sent, a failed wait doesn't mean it failed: say so, so nobody sends it twice.
      setError(pending ? "Your transaction was sent, but we couldn’t confirm it yet. Check it on the explorer before trying again." : reason(e));
      return null;
    } finally {
      running.current = false;
      setBusy(null);
    }
  };
  return { run, busy, error, lastTx };
}

export function TxNote({ error, lastTx }: { error: string | null; lastTx: Hex | null }) {
  if (error)
    return (
      <p className={s.error}>
        {error}
        {lastTx && error.startsWith("Your transaction was sent") && (
          <>
            {" "}
            <a href={explorer("tx", lastTx)} target="_blank" rel="noreferrer">
              See it ↗
            </a>
          </>
        )}
      </p>
    );
  if (lastTx)
    return (
      <p className={s.hint}>
        Last transaction:{" "}
        <a href={explorer("tx", lastTx)} target="_blank" rel="noreferrer">
          {short(lastTx)}
        </a>
      </p>
    );
  return null;
}

// ------------------------------------------------------------------ wallet

export function WalletBar() {
  const { address, isConnected, chainId } = useConnection();
  const connectors = useConnectors();
  const connect = useConnect();
  const disconnect = useDisconnect();
  const switchChain = useSwitchChain();

  if (!isConnected) {
    // A browser wallet when there is one; otherwise the first connector (in dev, the test wallet).
    const hasBrowserWallet = typeof window !== "undefined" && "ethereum" in window;
    const c = (hasBrowserWallet ? connectors.find((x) => x.type === "injected") : undefined) ?? connectors[0];
    return (
      <div className={s.wallet}>
        <button type="button" className={s.primarySmall} disabled={!c || connect.isPending} onClick={() => c && connect.mutate({ connector: c })}>
          {connect.isPending ? "Connecting…" : "Connect wallet"}
        </button>
        {connect.error && <p className={s.error}>{reason(connect.error)}</p>}
      </div>
    );
  }
  if (chainId !== elysium.id) {
    return (
      <div className={s.wallet}>
        <button type="button" className={s.primarySmall} onClick={() => switchChain.mutate({ chainId: elysium.id })}>
          Switch to Elysium testnet
        </button>
      </div>
    );
  }
  return (
    <div className={s.wallet}>
      <span className={s.addr}>
        <span className={s.dot} aria-hidden="true" />
        {short(address ?? "")}
      </span>
      <button type="button" className={s.ghost} onClick={() => disconnect.mutate()}>
        Disconnect
      </button>
    </div>
  );
}

export function NotLive({ title, line }: { title: string; line: string }) {
  return (
    <main className={s.page}>
      <header className={s.head}>
        <div>
          <p className={s.eyebrow}>App · Elysium testnet</p>
          <h1 className={s.h1}>{title}</h1>
          <p className={s.sub}>{line}</p>
        </div>
      </header>
      <p className={s.fine}>
        <Link href="/">Back to the home page</Link>
      </p>
    </main>
  );
}

// ------------------------------------------------------------------ small parts

export function Stat({ k, v, note, strong }: { k: string; v: string; note?: ReactNode; strong?: boolean }) {
  return (
    <div className={s.stat}>
      <span className={s.statK}>{k}</span>
      <span className={strong ? s.statVStrong : s.statV}>{v}</span>
      {note && <span className={s.statNote}>{note}</span>}
    </div>
  );
}

export function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className={s.row}>
      <span>{k}</span>
      <span className={s.num}>{v}</span>
    </div>
  );
}

// ------------------------------------------------------------------ helpers

/** The current time in seconds, ticking once a second. */
export function useNow() {
  return useSyncExternalStore(
    (tick) => {
      const id = setInterval(tick, 1_000);
      return () => clearInterval(id);
    },
    () => Math.floor(Date.now() / 1_000),
    () => 0,
  );
}

/** Now, in seconds, by the chain's clock when it runs ahead of this computer's (timers on-chain use it). */
export function useChainNow() {
  const block = useBlock({ watch: true });
  return Math.max(useNow(), Number(block.data?.timestamp ?? 0));
}

export function parse(v: string): bigint | null {
  if (!v || v === ".") return null;
  try {
    return parseUnits(v, 18);
  } catch {
    return null;
  }
}

export function fmt(v: bigint | undefined, decimals = 18): string {
  if (v === undefined) return "—";
  const n = Number(formatUnits(v, decimals));
  if (n === 0) return "0";
  if (n >= 1e6) return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(n);
  return n.toLocaleString("en-US", { maximumFractionDigits: n < 1 ? 4 : 2 });
}

export function short(a: string) {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

const DAY = 86_400;

export function until(sec: number) {
  const d = Math.floor(sec / DAY);
  const h = Math.floor((sec % DAY) / 3_600);
  const m = Math.ceil((sec % 3_600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** A short, plain reason for a failed action (wallet rejection, revert name). */
export function reason(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/rejected|denied/i.test(msg)) return "You cancelled it in your wallet.";
  if (/Provider not found|No injected provider/i.test(msg)) return "No wallet found in this browser. Install MetaMask or Rabby, then reload this page.";
  if (/PriceLimitAlreadyExceeded|PriceLimitOutOfBounds/.test(msg)) return "There’s nothing left to buy in that pool right now.";
  if (/insufficient funds|exceeds the balance of the account|gas required exceeds/i.test(msg))
    return "This wallet doesn’t have enough test HYPE for gas yet. If you just got some from the faucet, wait a few seconds and try again.";
  if (/nonce too low|replacement transaction underpriced|already known/i.test(msg))
    return "Your wallet is still sending an earlier transaction. Wait a few seconds and try again.";
  // Ascend switched new launches off on testnet ahead of mainnet (its own switch, not ours).
  if (/LaunchesArePaused|0x3a1455a0|HookNotAllowed|0xaf73e17a|ProtocolFeeCannotBeFetched/.test(msg))
    return "Ascend has paused new launches on testnet while it gets ready for mainnet on Nov 9. Launches open again as soon as Ascend switches them back on.";
  const named = msg.match(/reverted with the following reason:\s*\n?(.+)|error\s+([A-Z][A-Za-z]+)\(/);
  if (named) return `The contract refused: ${(named[1] ?? named[2]).trim()}.`;
  return `${msg.split("\n")[0].slice(0, 160)} Try again in a few seconds, or refresh the page.`;
}
