"use client";

// Get test PNTH: an inside screen, calm. Three steps with free test money (gas from the faucet,
// Ascend's test USDC, then a buy straight from PNTH's Ascend pool), and a link on to staking.

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { encodeAbiParameters, erc20Abi, keccak256, pad, parseAbi, parseUnits, toHex, zeroAddress } from "viem";
import { useBalance, useConnection, useReadContracts, useWatchAsset } from "wagmi";
import { swapperAbi } from "@/lib/chain/abi";
import { deployment, elysium, explorer } from "@/lib/chain/config";
import type { Deployment } from "@/lib/chain/deployments";
import { Providers } from "./providers";
import { fmt, NotLive, Row, TxNote, useTx, WalletBar, type Hex } from "./shared";
import s from "./app.module.css";

const FAUCET = "https://elysium.kinetiq.xyz/testnet-faucet";
const MINT = 1_000n * 10n ** 6n; // 1,000 test USDC per click

export function GetApp() {
  if (!deployment?.swapper) return <NotLive title="Get test PNTH" line="Buying test PNTH opens here as soon as PANTHEON is live on testnet." />;
  return (
    <Providers>
      <Get d={deployment as Deployment & { swapper: Hex }} />
    </Providers>
  );
}

// ------------------------------------------------------------------ Ascend's pool, as the contracts see it

const LAUNCHPAD = parseAbi([
  "function poolManager() view returns (address)",
  "function emaSqrtPrice(bytes32 poolId) view returns (uint160)",
]);
const MINTABLE = parseAbi(["function mint(address to, uint256 value)"]);
// Ascend's pool settings (LaunchpadKey.sol): a dynamic fee, tick spacing 200, hook bitmap 0x0445.
const DYNAMIC_FEE = 0x800000;
const PARAMETERS = pad(toHex(0x0445 | (200 << 16)), { size: 32 });
const POOL_KEY = [
  {
    type: "tuple",
    components: [
      { name: "currency0", type: "address" },
      { name: "currency1", type: "address" },
      { name: "hooks", type: "address" },
      { name: "poolManager", type: "address" },
      { name: "fee", type: "uint24" },
      { name: "parameters", type: "bytes32" },
    ],
  },
] as const;

function poolKey(token: Hex, quote: Hex, launchpad: Hex, poolManager: Hex) {
  const tokenIs0 = BigInt(token) < BigInt(quote);
  return {
    currency0: tokenIs0 ? token : quote,
    currency1: tokenIs0 ? quote : token,
    hooks: launchpad,
    poolManager,
    fee: DYNAMIC_FEE,
    parameters: PARAMETERS,
  } as const;
}

/** About how much PNTH some USDC buys at the pool's recent average price, after the 1% fee. */
function estimate(usdc: bigint, sqrtP: bigint, pnthIs0: boolean): bigint {
  if (sqrtP === 0n) return 0n;
  const q192 = 1n << 192n;
  const out = pnthIs0 ? (usdc * q192) / (sqrtP * sqrtP) : (usdc * sqrtP * sqrtP) / q192;
  return (out * 99n) / 100n;
}

// ------------------------------------------------------------------ the screen

type Call = Parameters<ReturnType<typeof useTx>["run"]>[1][number];
const QUICK = 100n * 10n ** 6n; // the one-click buy: 100 test USDC

function Get({ d }: { d: Deployment & { swapper: Hex } }) {
  const { address, isConnected, chainId } = useConnection();
  const onChain = isConnected && chainId === elysium.id;
  const me = (address ?? zeroAddress) as Hex;
  const tx = useTx();
  const watch = useWatchAsset();
  const [amount, setAmount] = useState("100");

  const hype = useBalance({ address: me, chainId: elysium.id, query: { enabled: onChain, refetchInterval: 10_000 } });
  const reads = useReadContracts({
    contracts: [
      { address: d.usdc, abi: erc20Abi, functionName: "balanceOf", args: [me] },
      { address: d.pnth, abi: erc20Abi, functionName: "balanceOf", args: [me] },
      { address: d.usdc, abi: erc20Abi, functionName: "allowance", args: [me, d.swapper] },
      { address: d.launchpad, abi: LAUNCHPAD, functionName: "poolManager" },
      { address: d.launchpad, abi: LAUNCHPAD, functionName: "emaSqrtPrice", args: [d.pnthPool] },
    ],
    query: { refetchInterval: 10_000 },
  });
  const usdc = onChain ? (reads.data?.[0].result ?? 0n) : 0n;
  const pnth = onChain ? (reads.data?.[1].result ?? 0n) : 0n;
  const allowance = onChain ? (reads.data?.[2].result ?? 0n) : 0n;
  const pm = reads.data?.[3].result as Hex | undefined;
  const sqrtP = reads.data?.[4].result ?? 0n;

  const key = pm ? poolKey(d.pnth, d.usdc, d.launchpad, pm) : null;
  // The key must hash to PNTH's pool id, or the buy would go somewhere else: check before offering it.
  const keyOk = !!key && keccak256(encodeAbiParameters(POOL_KEY, [key])).toLowerCase() === d.pnthPool.toLowerCase();
  const pnthIs0 = key?.currency0.toLowerCase() === d.pnth.toLowerCase();
  const hasGas = (hype.data?.value ?? 0n) > 0n;

  const mint = (v: bigint): Call => ({ address: d.usdc, abi: MINTABLE, functionName: "mint", args: [me, v] });
  const approve = (v: bigint): Call => ({ address: d.usdc, abi: erc20Abi, functionName: "approve", args: [d.swapper, v] });
  const swap = (v: bigint): Call => ({ address: d.swapper, abi: swapperAbi, functionName: "swapExactIn", args: [key!, !pnthIs0, v] });

  /** Only the steps still needed, each named in the button while the wallet asks. */
  const buySteps = (v: bigint, makeUsdc: boolean) => {
    const steps: [string, Call][] = [];
    if (makeUsdc) steps.push(["Making test USDC", mint(v)]);
    if (allowance < v) steps.push(["Letting the swap use it", approve(v)]);
    steps.push(["Buying PNTH", swap(v)]);
    return tx.run(
      steps.map(([label], i) => (steps.length > 1 ? `${label} (${i + 1} of ${steps.length})` : label)),
      steps.map(([, call]) => call),
    );
  };

  let spend: bigint | null = null;
  try {
    spend = amount && Number(amount) > 0 ? parseUnits(amount, 6) : null;
  } catch {
    spend = null;
  }
  const blocked = !onChain ? "Connect your wallet first" : !hasGas ? "Get test HYPE for gas first" : !keyOk ? "Reading the pool…" : null;
  const customLabel = blocked ?? (!spend ? "Enter an amount" : spend > usdc ? "Not enough test USDC" : "Buy PNTH");

  return (
    <main className={s.page}>
      <header className={s.head}>
        <div>
          <p className={s.eyebrow}>App · Elysium testnet</p>
          <h1 className={s.h1}>Get test PNTH</h1>
          <p className={s.sub}>Try PANTHEON with free test money. These coins have no value: they’re only for trying it out.</p>
        </div>
        <WalletBar />
      </header>

      <div className={s.grid}>
        <div className={s.main}>
          <section className={s.cell}>
            <p className={s.label}>Your test wallet</p>
            <ol className={s.steps}>
              <Step
                done={hasGas}
                title="Test HYPE for gas"
                note={onChain ? `You have ${fmt(hype.data?.value)} HYPE. A little covers many transactions.` : "Every transaction needs a little. The faucet gives it for free."}
                action={
                  <a className={s.ghost} href={FAUCET} target="_blank" rel="noreferrer">
                    Faucet ↗
                  </a>
                }
              />
              <Step done={usdc > 0n} title="Test USDC" note={onChain ? `You have ${fmt(usdc, 6)} USDC.` : "Ascend’s test USDC, made for you as you buy."} />
              <Step done={pnth > 0n} title="PNTH" note={onChain ? `You have ${fmt(pnth)} PNTH.` : "Bought straight from PNTH’s pool on Ascend."} />
            </ol>
          </section>

          <section className={s.cell}>
            <button type="button" className={s.primary} disabled={!!blocked || !!tx.busy} onClick={() => buySteps(QUICK, usdc < QUICK)}>
              {tx.busy ?? blocked ?? "Get test PNTH"}
            </button>
            <p className={s.hint}>
              One click: we make 100 test USDC for you and buy about {fmt(estimate(QUICK, sqrtP, pnthIs0))} PNTH with it. Your wallet asks up to three times: to make the USDC, to let
              the swap use it, and to buy.
            </p>
            <TxNote error={tx.error} lastTx={tx.lastTx} />
            {pnth > 0n && (
              <div className={s.unlock}>
                <span>You have {fmt(pnth)} PNTH.</span>
                <span className={s.unlockActions}>
                  <button
                    type="button"
                    className={s.ghost}
                    disabled={watch.isPending || watch.isSuccess}
                    onClick={() => watch.mutate({ type: "ERC20", options: { address: d.pnth, symbol: "PNTH", decimals: 18 } })}
                  >
                    {watch.isSuccess ? "Added to your wallet" : "Add to your wallet"}
                  </button>
                  <Link href="/stake" className={s.primarySmall}>
                    Stake it
                  </Link>
                </span>
              </div>
            )}
          </section>

          <section className={s.cell}>
            <details className={s.more}>
              <summary>Buy a different amount</summary>
              <label className={s.field}>
                <span className={s.fieldTop}>
                  <span>You spend</span>
                  <button type="button" className={s.max} disabled={usdc === 0n} onClick={() => setAmount(String(Number(usdc) / 1e6))}>
                    Max
                  </button>
                </span>
                <span className={s.inputRow}>
                  <input inputMode="decimal" value={amount} placeholder="0" onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} />
                  <span className={s.unit}>USDC</span>
                </span>
              </label>
              <p className={s.hint}>You get about {fmt(spend ? estimate(spend, sqrtP, pnthIs0) : 0n)} PNTH, at the pool’s recent average price after the 1% fee.</p>
              <div className={s.actionsRow}>
                <button type="button" className={s.primarySmall} disabled={customLabel !== "Buy PNTH" || !!tx.busy} onClick={() => spend && buySteps(spend, false)}>
                  {customLabel}
                </button>
                <button type="button" className={s.linkBtn} disabled={!!blocked || !!tx.busy} onClick={() => tx.run("Making test USDC", [mint(MINT)])}>
                  Make 1,000 test USDC
                </button>
              </div>
            </details>
          </section>
        </div>

        <aside className={s.side}>
          <div className={s.cell}>
            <p className={s.label}>Where your 1% fee goes</p>
            <Row k="To Ascend" v="0.5%" />
            <Row k="To PANTHEON’s Covenant" v="0.5%" />
            <p className={s.hint}>On a buy, Covenant’s half goes toward the basket that’s paid out to stakers. On a sell, it’s burned.</p>
          </div>
          <div className={s.cell}>
            <p className={s.label}>Good to know</p>
            <p className={s.hint}>
              Ascend’s own app opens to the public soon. Until then, buys here go through a small swap helper whose code is{" "}
              <a href={explorer("address", d.swapper)} target="_blank" rel="noreferrer">
                verified on the explorer
              </a>
              . Prices move with every trade.
            </p>
          </div>
        </aside>
      </div>
    </main>
  );
}

function Step({ done, title, note, action }: { done: boolean; title: string; note: string; action?: ReactNode }) {
  return (
    <li className={s.step}>
      <span className={done ? s.stepDone : s.stepMark} aria-hidden>
        {done ? "✓" : ""}
      </span>
      <span className={s.stepText}>
        <span className={s.stepTitle}>{title}</span>
        <span className={s.stepNote}>{note}</span>
      </span>
      {action ?? <span />}
    </li>
  );
}
