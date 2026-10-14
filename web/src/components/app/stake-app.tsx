"use client";

// The stake screen: an inside screen, so it stays calm. Plain cells, numbers and two buttons.
// Everything shown is read live from the contracts; every action is one or two wallet prompts.

import Link from "next/link";
import { useState } from "react";
import { erc20Abi, formatUnits, zeroAddress } from "viem";
import { useConnection, useReadContracts } from "wagmi";
import { constituentRegistryAbi, hypePassportRegistryAbi, pantheonStakingAbi } from "@/lib/chain/abi";
import { deployment, elysium, explorer } from "@/lib/chain/config";
import type { Deployment } from "@/lib/chain/deployments";
import { Providers } from "./providers";
import { fmt, NotLive, parse, Row, short, Stat, TxNote, until, useChainNow, useTx, WalletBar, type Hex } from "./shared";
import s from "./app.module.css";
const ONE = 10n ** 18n;
const AGE_RAMP = 30 * 86_400;

export function StakeApp() {
  if (!deployment) return <NotLive title="Stake PNTH" line="PANTHEON isn’t live on testnet yet. Staking opens here the moment it is." />;
  return (
    <Providers>
      <Stake d={deployment} />
    </Providers>
  );
}

// ------------------------------------------------------------------ the screen

function Stake({ d }: { d: Deployment }) {
  const { address, isConnected, chainId } = useConnection();
  const onChain = isConnected && chainId === elysium.id;
  const me = (address ?? zeroAddress) as Hex;
  const now = useChainNow(); // the chain's clock decides when an unlock is ready

  const pub = useReadContracts({
    contracts: [
      { address: d.constituentRegistry, abi: constituentRegistryAbi, functionName: "active" },
      { address: d.staking, abi: pantheonStakingAbi, functionName: "totalStaked" },
      { address: d.staking, abi: pantheonStakingAbi, functionName: "totalWorking" },
      { address: d.staking, abi: pantheonStakingAbi, functionName: "rewardTokens" },
      { address: d.pnth, abi: erc20Abi, functionName: "balanceOf", args: [d.burnSink] },
    ],
    query: { refetchInterval: 10_000 },
  });
  const basket = pub.data?.[0].result ?? [];
  const totalStaked = pub.data?.[1].result;
  const totalWorking = pub.data?.[2].result;
  const rewardTokens = (pub.data?.[3].result ?? []) as readonly Hex[];
  const burned = pub.data?.[4].result;

  const tokens = Array.from(new Set([...basket.map((c) => c.token as Hex), ...rewardTokens]));
  const syms = useReadContracts({
    contracts: tokens.map((t) => ({ address: t, abi: erc20Abi, functionName: "symbol" }) as const),
  });
  const symbol = (t: Hex) => (syms.data?.[tokens.indexOf(t)]?.result as string | undefined) ?? short(t);

  const mine = useReadContracts({
    contracts: [
      { address: d.pnth, abi: erc20Abi, functionName: "balanceOf", args: [me] },
      { address: d.pnth, abi: erc20Abi, functionName: "allowance", args: [me, d.staking] },
      { address: d.staking, abi: pantheonStakingAbi, functionName: "accounts", args: [me] },
      { address: d.passportRegistry, abi: hypePassportRegistryAbi, functionName: "multiplierOf", args: [me] },
    ],
    query: { enabled: onChain, refetchInterval: 5_000 },
  });
  const wallet = mine.data?.[0].result;
  const allowance = mine.data?.[1].result ?? 0n;
  const acct = mine.data?.[2].result; // [staked, cooling, working, coolEnd, stakeStart]
  const passportMult = mine.data?.[3].result ?? ONE;
  const staked = acct?.[0] ?? 0n;
  const cooling = acct?.[1] ?? 0n;
  const working = acct?.[2] ?? 0n;
  const coolEnd = Number(acct?.[3] ?? 0n);
  const stakeStart = Number(acct?.[4] ?? 0n);

  const earnedQ = useReadContracts({
    contracts: rewardTokens.map(
      (t) => ({ address: d.staking, abi: pantheonStakingAbi, functionName: "earned", args: [t, me] }) as const,
    ),
    query: { enabled: onChain && rewardTokens.length > 0, refetchInterval: 3_000 },
  });
  const earned = rewardTokens.map((t, i) => ({ token: t, amount: (earnedQ.data?.[i]?.result as bigint | undefined) ?? 0n }));
  const anyEarned = earned.some((e) => e.amount > 0n);

  const age = staked > 0n ? Math.min(Math.max(now - stakeStart, 0), AGE_RAMP) : 0;
  const timeBonus = 1 + (age / AGE_RAMP) * 0.5;
  const passport = Number(passportMult) / 1e18;
  const share = totalWorking && totalWorking > 0n ? Number((working * 10_000n) / totalWorking) / 100 : 0;

  return (
    <main className={s.page}>
      <header className={s.head}>
        <div>
          <p className={s.eyebrow}>App · Elysium testnet</p>
          <h1 className={s.h1}>Stake PNTH</h1>
          <p className={s.sub}>Every coin the basket buys streams to stakers over a day. Unstaking takes 3 days.</p>
        </div>
        <WalletBar />
      </header>

      <div className={s.grid}>
        <section className={s.main}>
          <div className={s.cell}>
            <p className={s.label}>Your PNTH</p>
            <div className={s.stats}>
              <Stat
                k="In your wallet"
                v={onChain ? fmt(wallet) : "—"}
                note={onChain && wallet === 0n ? <Link href="/get">Get test PNTH</Link> : undefined}
              />
              <Stat k="Staked" v={onChain ? fmt(staked) : "—"} strong />
              <Stat
                k="Unlocking"
                v={onChain ? fmt(cooling) : "—"}
                note={cooling > 0n ? (now >= coolEnd ? "ready to withdraw" : `ready in ${until(coolEnd - now)}`) : undefined}
              />
            </div>
          </div>

          <Actions
            d={d}
            enabled={onChain}
            wallet={wallet ?? 0n}
            allowance={allowance}
            staked={staked}
            cooling={cooling}
            ready={cooling > 0n && now >= coolEnd}
          />

          <div className={s.cell}>
            <div className={s.rowHead}>
              <p className={s.label}>Earned</p>
              <ClaimButton d={d} enabled={onChain && anyEarned} />
            </div>
            {rewardTokens.length === 0 ? (
              <p className={s.empty}>Nothing is streaming yet. The basket&rsquo;s first buy starts it.</p>
            ) : (
              <ul className={s.coins}>
                {earned.map((e) => (
                  <li key={e.token}>
                    <a href={explorer("token", e.token)} target="_blank" rel="noreferrer">
                      {symbol(e.token)}
                    </a>
                    <span className={s.num}>{onChain ? fmt(e.amount) : "—"}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className={s.cell}>
            <p className={s.label}>Your boost</p>
            <div className={s.stats}>
              <Stat k="Time bonus" v={`${timeBonus.toFixed(2)}×`} note="grows to 1.50× over 30 days" />
              <Stat
                k="HYPE Passport"
                v={`${passport.toFixed(2)}×`}
                note={passport > 1 ? "verified" : <Link href="/passport">get one for up to 1.25×</Link>}
              />
              <Stat k="Your share of the stream" v={onChain ? `${share.toFixed(2)}%` : "—"} strong />
            </div>
          </div>
        </section>

        <aside className={s.side}>
          <div className={s.cell}>
            <p className={s.label}>The basket</p>
            {basket.length === 0 ? (
              <p className={s.empty}>No basket yet. The first list is waiting out its 24 hours on-chain. Until it starts, fees reach stakers as USDC.</p>
            ) : (
              <ul className={s.basket}>
                {basket.map((c) => (
                  <li key={c.token}>
                    <a href={explorer("token", c.token)} target="_blank" rel="noreferrer">
                      {symbol(c.token as Hex)}
                    </a>
                    <span className={s.bar}>
                      <i style={{ width: `${c.weightBps / 100}%` }} />
                    </span>
                    <span className={s.num}>{c.weightBps / 100}%</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className={s.cell}>
            <p className={s.label}>Everyone</p>
            <div className={s.list}>
              <Row k="PNTH staked" v={fmt(totalStaked)} />
              <Row k="PNTH burned" v={fmt(burned)} />
              <Row k="Coins streaming" v={String(rewardTokens.length)} />
            </div>
          </div>
          <p className={s.fine}>
            Testnet: these are test coins with no value. <Link href="/covenant">How the rules work</Link>
          </p>
        </aside>
      </div>
    </main>
  );
}

// ------------------------------------------------------------------ actions

function Actions(p: {
  d: Deployment;
  enabled: boolean;
  wallet: bigint;
  allowance: bigint;
  staked: bigint;
  cooling: bigint;
  ready: boolean;
}) {
  const [tab, setTab] = useState<"stake" | "unstake">("stake");
  const [value, setValue] = useState("");
  const { run, busy, error, lastTx } = useTx();
  const amount = parse(value);
  const max = tab === "stake" ? p.wallet : p.staked;
  const tooMuch = amount !== null && amount > max;
  const canSubmit = p.enabled && !busy && amount !== null && amount > 0n && !tooMuch;
  const needsApproval = tab === "stake" && amount !== null && amount > p.allowance;

  const submit = async () => {
    if (amount === null) return;
    if (tab === "stake") {
      const ok = await run(needsApproval ? "Approving" : "Staking", [
        ...(needsApproval
          ? [{ address: p.d.pnth, abi: erc20Abi, functionName: "approve", args: [p.d.staking, amount] } as const]
          : []),
        { address: p.d.staking, abi: pantheonStakingAbi, functionName: "stake", args: [amount] } as const,
      ]);
      if (ok) setValue("");
    } else {
      const ok = await run("Starting the unlock", [
        { address: p.d.staking, abi: pantheonStakingAbi, functionName: "requestUnstake", args: [amount] } as const,
      ]);
      if (ok) setValue("");
    }
  };

  return (
    <div className={s.cell}>
      <div className={s.tabs} role="tablist">
        {(["stake", "unstake"] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? s.tabOn : s.tab} onClick={() => setTab(t)}>
            {t === "stake" ? "Stake" : "Unstake"}
          </button>
        ))}
      </div>
      <label className={s.field}>
        <span className={s.fieldTop}>
          <span>Amount</span>
          <button type="button" className={s.max} disabled={!p.enabled} onClick={() => setValue(formatUnits(max, 18))}>
            Max {fmt(max)}
          </button>
        </span>
        <span className={s.inputRow}>
          <input
            inputMode="decimal"
            placeholder="0"
            value={value}
            onChange={(e) => setValue(e.target.value.replace(/[^0-9.]/g, ""))}
            disabled={!p.enabled}
          />
          <span className={s.unit}>PNTH</span>
        </span>
      </label>
      <button type="button" className={s.primary} disabled={!canSubmit} onClick={submit}>
        {busy ??
          (tooMuch
            ? "More than you have"
            : tab === "stake"
              ? needsApproval
                ? "Approve and stake"
                : "Stake"
              : "Start the 3-day unlock")}
      </button>
      {tab === "unstake" && <p className={s.hint}>The amount stops earning now and can be withdrawn in 3 days.</p>}

      {p.cooling > 0n && (
        <div className={s.unlock}>
          <span>
            {fmt(p.cooling)} PNTH {p.ready ? "ready to withdraw" : "unlocking"}
          </span>
          <span className={s.unlockActions}>
            <button
              type="button"
              className={s.ghost}
              disabled={!p.enabled || !!busy}
              onClick={() =>
                run("Cancelling", [{ address: p.d.staking, abi: pantheonStakingAbi, functionName: "cancelUnstake" } as const])
              }
            >
              Keep staking
            </button>
            <button
              type="button"
              className={s.primarySmall}
              disabled={!p.enabled || !p.ready || !!busy}
              onClick={() => run("Withdrawing", [{ address: p.d.staking, abi: pantheonStakingAbi, functionName: "withdraw" } as const])}
            >
              Withdraw
            </button>
          </span>
        </div>
      )}
      <TxNote error={error} lastTx={lastTx} />
    </div>
  );
}

function ClaimButton({ d, enabled }: { d: Deployment; enabled: boolean }) {
  const { run, busy, error, lastTx } = useTx();
  return (
    <span className={s.claimWrap}>
      <button
        type="button"
        className={s.primarySmall}
        disabled={!enabled || !!busy}
        onClick={() => run("Claiming", [{ address: d.staking, abi: pantheonStakingAbi, functionName: "claim" } as const])}
      >
        {busy ?? "Claim all"}
      </button>
      <TxNote error={error} lastTx={lastTx} />
    </span>
  );
}

// ------------------------------------------------------------------ wallet

