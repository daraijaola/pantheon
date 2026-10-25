"use client";

// Launch a coin on Covenant: an inside screen, so it stays calm. The creator picks what happens to
// the fees on sells and on buys, and one transaction launches the coin on Ascend with those rules
// locked in. Every coin already on Covenant is listed from the factory's own events.

import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { decodeEventLog, erc20Abi, isAddress, zeroAddress } from "viem";
import { useConnection, usePublicClient, useReadContract, useReadContracts } from "wagmi";
import { covenantFactoryAbi, covenantRouterAbi } from "@/lib/chain/abi";
import { deployedFrom, deployment, elysium, explorer } from "@/lib/chain/config";
import type { Deployment } from "@/lib/chain/deployments";
import { Providers } from "./providers";
import { NotLive, Row, short, TxNote, useTx, WalletBar, type Hex } from "./shared";
import s from "./app.module.css";
import c from "./covenant.module.css";

export function CovenantLaunchApp() {
  if (!deployment) return <NotLive title="Launch on Covenant" line="Covenant isn’t live on testnet yet. Launches open here the moment it is." />;
  return (
    <Providers>
      <Launch d={deployment} />
    </Providers>
  );
}

// ------------------------------------------------------------------ the rules a creator can pick

// The router's jobs (CovenantRouter.Job). Fees in the coin may be burned or paid; fees in USDC may
// be paid or sent to the PANTHEON basket. Streaming needs a staking contract, so it isn't offered here.
const PAY = 0;
const BURN = 1;
const INDEX = 2;
type Leg = { job: number; bps: number; target: Hex };

const SELLS = {
  burn: { label: "Burn all of it", note: "Your coin’s supply only goes down." },
  half: { label: "Burn half, pay half to a wallet", note: "Some supply burned, some income for you." },
  pay: { label: "Pay all of it to a wallet", note: "You get the fee, in your coin." },
};
const BUYS = {
  pay: { label: "Pay it to a wallet", note: "You get the fee, in USDC. The rule just can’t change later." },
  split: { label: "Half to a wallet, half to the PANTHEON basket", note: "Half for you, half buys Ascend’s best coins for PNTH stakers." },
  basket: { label: "All to the PANTHEON basket", note: "Every buy fee goes to Ascend’s index." },
};
/** Ascend's own on/off switch for new launches (owner-only on Ascend's side). */
const launchSwitchAbi = [{ type: "function", name: "paused", inputs: [], outputs: [{ name: "", type: "bool" }], stateMutability: "view" }] as const;
const PAUSED_LINE = "Ascend has paused new launches on testnet while it gets ready for mainnet on Nov 9. Covenant launches open again here as soon as Ascend switches them back on.";
type Sell = keyof typeof SELLS;
type Buy = keyof typeof BUYS;

function sellLegs(k: Sell, wallet: Hex): Leg[] {
  if (k === "burn") return [{ job: BURN, bps: 10_000, target: zeroAddress }];
  if (k === "half")
    return [
      { job: BURN, bps: 5_000, target: zeroAddress },
      { job: PAY, bps: 5_000, target: wallet },
    ];
  return [{ job: PAY, bps: 10_000, target: wallet }];
}

function buyLegs(k: Buy, wallet: Hex, basket: Hex): Leg[] {
  if (k === "pay") return [{ job: PAY, bps: 10_000, target: wallet }];
  if (k === "split")
    return [
      { job: PAY, bps: 5_000, target: wallet },
      { job: INDEX, bps: 5_000, target: basket },
    ];
  return [{ job: INDEX, bps: 10_000, target: basket }];
}

/** A fresh salt per launch. The factory mixes in the sender, so nobody can take another creator's address. */
function randomSalt(): Hex {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

// ------------------------------------------------------------------ the screen

type Launched = { symbol: string; token: Hex; router: Hex; tx: Hex };

function Launch({ d }: { d: Deployment }) {
  const { address, isConnected, chainId } = useConnection();
  const onChain = isConnected && chainId === elysium.id;
  const tx = useTx();

  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [sell, setSell] = useState<Sell>("burn");
  const [buy, setBuy] = useState<Buy>("split");
  const [payTo, setPayTo] = useState("");
  const [done, setDone] = useState<Launched | null>(null);
  const switchQ = useReadContract({ address: d.launchpad, abi: launchSwitchAbi, functionName: "paused", chainId: elysium.id, query: { refetchInterval: 30_000 } });
  const ascendPaused = switchQ.data === true;

  const wallet = (payTo.trim() || address || "") as Hex;
  const needsWallet = sell !== "burn" || buy !== "basket";
  const problem =
    name.trim().length === 0
      ? "Give your coin a name."
      : name.trim().length > 32
        ? "Keep the name to 32 characters."
        : !/^[A-Z0-9]{1,10}$/.test(symbol)
          ? "The symbol is 1 to 10 letters or numbers."
          : needsWallet && !isAddress(wallet)
            ? "Enter the wallet that gets paid."
            : null;

  const launch = async () => {
    const receipts = await tx.run("Launching", [
      {
        address: d.covenantFactory,
        abi: covenantFactoryAbi,
        functionName: "launch",
        args: [name.trim(), symbol, d.usdc, randomSalt(), sellLegs(sell, wallet), buyLegs(buy, wallet, d.indexVault)],
      },
    ]);
    const receipt = receipts?.[0];
    if (!receipt) return;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== d.covenantFactory.toLowerCase()) continue;
      try {
        const ev = decodeEventLog({ abi: covenantFactoryAbi, data: log.data, topics: log.topics });
        if (ev.eventName === "RouterDeployed") setDone({ symbol, token: ev.args.token, router: ev.args.router, tx: receipt.transactionHash });
      } catch {
        // another event from the factory
      }
    }
  };

  return (
    <main className={s.page}>
      <header className={s.head}>
        <div>
          <p className={s.eyebrow}>Covenant · Elysium testnet</p>
          <h1 className={s.h1}>Launch a coin on Covenant</h1>
          <p className={s.sub}>
            Your coin launches on Ascend like any other. Its creator fees go to a contract that follows the rules you pick here, and nobody can change them later, including you.
          </p>
        </div>
        <WalletBar />
      </header>

      {done && (
        <section className={c.done}>
          <p className={c.doneTitle}>{done.symbol} is live on Ascend, with its rules locked.</p>
          <p className={c.links}>
            <a href={explorer("token", done.token)} target="_blank" rel="noreferrer">
              The coin ↗
            </a>
            <a href={explorer("address", done.router)} target="_blank" rel="noreferrer">
              Its Covenant ↗
            </a>
            <a href={explorer("tx", done.tx)} target="_blank" rel="noreferrer">
              The launch ↗
            </a>
          </p>
        </section>
      )}

      <div className={s.grid}>
        <div className={s.main}>
          <section className={s.cell}>
            <p className={s.label}>Your coin</p>
            <div className={c.pair}>
              <label className={s.field}>
                <span className={s.fieldTop}>Name</span>
                <span className={s.inputRow}>
                  <input className={s.addrInput} value={name} placeholder="Olympus" maxLength={40} onChange={(e) => setName(e.target.value)} />
                </span>
              </label>
              <label className={s.field}>
                <span className={s.fieldTop}>Symbol</span>
                <span className={s.inputRow}>
                  <input
                    className={s.addrInput}
                    value={symbol}
                    placeholder="OLY"
                    maxLength={10}
                    onChange={(e) => setSymbol(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
                  />
                </span>
              </label>
            </div>
          </section>

          <section className={s.cell}>
            <p className={s.label}>When people sell, the fee is paid in your coin. Covenant will:</p>
            <Choices name="sell" options={SELLS} value={sell} onChange={setSell} />
          </section>

          <section className={s.cell}>
            <p className={s.label}>When people buy, the fee is paid in USDC. Covenant will:</p>
            <Choices name="buy" options={BUYS} value={buy} onChange={setBuy} />
          </section>

          {needsWallet && (
            <section className={s.cell}>
              <label className={s.field}>
                <span className={s.fieldTop}>Wallet that gets paid</span>
                <span className={s.inputRow}>
                  <input className={s.addrInput} value={payTo} placeholder={address ?? "0x…"} spellCheck={false} onChange={(e) => setPayTo(e.target.value.trim())} />
                </span>
              </label>
              <p className={s.hint}>Your connected wallet, unless you enter another. It’s locked in at launch too.</p>
            </section>
          )}

          <section className={s.cell}>
            <p className={s.label}>Locked in at launch</p>
            <ul className={c.rules}>
              <li>
                <span>On sells</span>
                <span>{SELLS[sell].label}</span>
              </li>
              <li>
                <span>On buys</span>
                <span>{BUYS[buy].label}</span>
              </li>
              <li>
                <span>Owner, admin key, upgrades</span>
                <span>none</span>
              </li>
            </ul>
            <button type="button" className={s.primary} disabled={ascendPaused || !onChain || !!problem || !!tx.busy} onClick={launch}>
              {tx.busy ?? (ascendPaused ? "Launches are paused by Ascend" : !onChain ? "Connect your wallet to launch" : (problem ?? "Launch on Ascend"))}
            </button>
            {ascendPaused && <p className={s.hint}>{PAUSED_LINE}</p>}
            <p className={s.hint}>One transaction. A Covenant launch can’t include a creator buy, but you can buy your coin right after, like anyone else.</p>
            <TxNote error={tx.error} lastTx={tx.lastTx} />
          </section>
        </div>

        <aside className={s.side}>
          <div className={s.cell}>
            <p className={s.label}>Coins on Covenant</p>
            <CoinsOnCovenant d={d} />
          </div>
          <div className={s.cell}>
            <p className={s.label}>Where a trade’s fee goes</p>
            <Row k="Fee on every trade" v="1%" />
            <Row k="To Ascend" v="0.5%" />
            <Row k="To the coin’s Covenant" v="0.5%" />
            <p className={s.hint}>Fees move when anyone presses Run on a coin’s Covenant. It costs only gas, and every run leaves a receipt on the explorer.</p>
          </div>
        </aside>
      </div>
      <p className={s.fine}>
        Testnet only for now: coins launched here trade against Ascend’s test USDC. <Link href="/covenant">How Covenant works</Link>
      </p>
    </main>
  );
}

function Choices<K extends string>({
  name,
  options,
  value,
  onChange,
}: {
  name: string;
  options: Record<K, { label: string; note: string }>;
  value: K;
  onChange: (k: K) => void;
}) {
  return (
    <div className={c.choices} role="radiogroup">
      {(Object.keys(options) as K[]).map((k) => (
        <label key={k} className={k === value ? c.choiceOn : c.choice}>
          <input type="radio" name={name} checked={k === value} onChange={() => onChange(k)} />
          <span className={c.choiceText}>
            <span className={c.choiceLabel}>{options[k].label}</span>
            <span className={c.choiceNote}>{options[k].note}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

/** Every router the factory has deployed, newest first, read from its RouterDeployed events. Anyone can run one. */
function CoinsOnCovenant({ d }: { d: Deployment }) {
  const client = usePublicClient({ chainId: elysium.id });
  const tx = useTx();
  const coins = useQuery({
    queryKey: ["covenant-coins", d.covenantFactory],
    enabled: !!client,
    refetchInterval: 30_000,
    queryFn: async () => {
      const logs = await client!.getContractEvents({
        address: d.covenantFactory,
        abi: covenantFactoryAbi,
        eventName: "RouterDeployed",
        fromBlock: deployedFrom,
        toBlock: "latest",
      });
      return logs.map((l) => ({ token: l.args.token as Hex, router: l.args.router as Hex, launched: !!l.args.launched })).reverse();
    },
  });
  const list = coins.data ?? [];
  const syms = useReadContracts({ contracts: list.map((x) => ({ address: x.token, abi: erc20Abi, functionName: "symbol" }) as const) });

  if (coins.isLoading) return <p className={s.empty}>Reading the chain…</p>;
  if (coins.error) return <p className={s.empty}>Couldn’t read the list right now.</p>;
  if (list.length === 0) return <p className={s.empty}>No coins yet.</p>;
  return (
    <>
      <ul className={c.coins}>
        {list.map((x, i) => (
          <li key={x.router}>
            <a href={explorer("address", x.router)} target="_blank" rel="noreferrer">
              {(syms.data?.[i]?.result as string | undefined) ?? short(x.token)}
            </a>
            <span className={c.how}>{x.launched ? "launched" : "moved in"}</span>
            <button
              type="button"
              className={s.ghost}
              disabled={!!tx.busy}
              onClick={() => tx.run("Running", [{ address: x.router, abi: covenantRouterAbi, functionName: "run" }])}
            >
              Run
            </button>
          </li>
        ))}
      </ul>
      <TxNote error={tx.error} lastTx={tx.lastTx} />
    </>
  );
}
