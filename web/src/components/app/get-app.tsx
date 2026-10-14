"use client";

// Get test PNTH: an inside screen, calm. Three steps with free test money (gas from the faucet,
// Ascend's test USDC, then a buy straight from PNTH's Ascend pool), and a link on to staking.

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { encodeAbiParameters, erc20Abi, keccak256, pad, parseAbi, parseUnits, toHex, zeroAddress } from "viem";
import { useBalance, useConnection, useReadContracts } from "wagmi";
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

function Get({ d }: { d: Deployment & { swapper: Hex } }) {
  const { address, isConnected, chainId } = useConnection();
  const onChain = isConnected && chainId === elysium.id;
  const me = (address ?? zeroAddress) as Hex;
  const tx = useTx();
  const [amount, setAmount] = useState("100");

  const hype = useBalance({ address: me, chainId: elysium.id, query: { enabled: onChain, refetchInterval: 10_000 } });
  const reads = useReadContracts({
    contracts: [
      { address: d.usdc, abi: erc20Abi, functionName: "balanceOf", args: [me] },
      { address: d.pnth, abi: erc20Abi, functionName: "balanceOf", args: [me] },
      { address: d.launchpad, abi: LAUNCHPAD, functionName: "poolManager" },
      { address: d.launchpad, abi: LAUNCHPAD, functionName: "emaSqrtPrice", args: [d.pnthPool] },
    ],
    query: { refetchInterval: 10_000 },
  });
  const usdc = onChain ? reads.data?.[0].result : undefined;
  const pnth = onChain ? reads.data?.[1].result : undefined;
  const pm = reads.data?.[2].result as Hex | undefined;
  const sqrtP = reads.data?.[3].result ?? 0n;

  const key = pm ? poolKey(d.pnth, d.usdc, d.launchpad, pm) : null;
  // The key must hash to PNTH's pool id, or the buy would go somewhere else: check before offering it.
  const keyOk = !!key && keccak256(encodeAbiParameters(POOL_KEY, [key])).toLowerCase() === d.pnthPool.toLowerCase();
  const pnthIs0 = key?.currency0.toLowerCase() === d.pnth.toLowerCase();

  let spend: bigint | null = null;
  try {
    spend = amount && Number(amount) > 0 ? parseUnits(amount, 6) : null;
  } catch {
    spend = null;
  }
  const about = spend ? estimate(spend, sqrtP, pnthIs0) : 0n;
  const hasGas = (hype.data?.value ?? 0n) > 0n;
  const tooMuch = spend !== null && usdc !== undefined && spend > usdc;

  const getUsdc = () => tx.run("Getting test USDC", [{ address: d.usdc, abi: MINTABLE, functionName: "mint", args: [me, MINT] }]);
  const buy = () =>
    key &&
    spend &&
    tx.run("Buying", [
      { address: d.usdc, abi: erc20Abi, functionName: "approve", args: [d.swapper, spend] },
      { address: d.swapper, abi: swapperAbi, functionName: "swapExactIn", args: [key, !pnthIs0, spend] },
    ]);

  const label = !onChain
    ? "Connect your wallet first"
    : !hasGas
      ? "Get test HYPE for gas first"
      : !keyOk
        ? "Reading the pool…"
        : !spend
          ? "Enter an amount"
          : tooMuch
            ? "Not enough test USDC"
            : "Buy PNTH";

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
            <p className={s.label}>Three steps</p>
            <ol className={s.steps}>
              <Step
                done={hasGas}
                title="Test HYPE for gas"
                note={onChain ? `You have ${fmt(hype.data?.value)} HYPE. A little covers many transactions.` : "Every transaction needs a little."}
                action={
                  <a className={s.ghost} href={FAUCET} target="_blank" rel="noreferrer">
                    Faucet ↗
                  </a>
                }
              />
              <Step
                done={(usdc ?? 0n) > 0n}
                title="Test USDC"
                note={onChain ? `You have ${fmt(usdc, 6)} USDC. Ascend’s test USDC is free to make.` : "Ascend’s test USDC is free to make."}
                action={
                  <button type="button" className={s.ghost} disabled={!onChain || !hasGas || !!tx.busy} onClick={getUsdc}>
                    Get 1,000
                  </button>
                }
              />
              <Step done={(pnth ?? 0n) > 0n} title="Buy PNTH" note={onChain ? `You have ${fmt(pnth)} PNTH.` : "Straight from PNTH’s pool on Ascend."} />
            </ol>
          </section>

          <section className={s.cell}>
            <label className={s.field}>
              <span className={s.fieldTop}>
                <span>You spend</span>
                <button type="button" className={s.max} disabled={!usdc} onClick={() => usdc && setAmount(String(Number(usdc) / 1e6))}>
                  Max
                </button>
              </span>
              <span className={s.inputRow}>
                <input inputMode="decimal" value={amount} placeholder="0" onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} />
                <span className={s.unit}>USDC</span>
              </span>
            </label>
            <p className={s.hint}>You get about {fmt(about)} PNTH, at the pool’s recent average price after the 1% fee.</p>
            <button type="button" className={s.primary} disabled={label !== "Buy PNTH" || !!tx.busy} onClick={buy}>
              {tx.busy ?? label}
            </button>
            <TxNote error={tx.error} lastTx={tx.lastTx} />
            {(pnth ?? 0n) > 0n && (
              <p className={s.hint}>
                Next: <Link href="/stake">stake your PNTH</Link> to earn a share of the basket.
              </p>
            )}
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
              The buy goes through a small swap helper whose code is{" "}
              <a href={explorer("address", d.swapper)} target="_blank" rel="noreferrer">
                verified on the explorer
              </a>
              . Prices move with every trade. Once PNTH launches for real, it’s bought on Ascend itself.
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
