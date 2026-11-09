import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";
import { StakeApp } from "@/components/app/stake-app";
import { readLive } from "@/lib/live";
import { network } from "@/lib/chain/config";
import { readStakeWindow } from "@/lib/stake-window";

export const metadata: Metadata = { title: "Stake · PANTHEON", description: "Stake PNTH and earn Ascend's best coins." };

export default function Page() {
  return <Suspense fallback={<p>Loading staking…</p>}><StakePage /></Suspense>;
}

async function StakePage() {
  if (!network.testnet) await connection();
  // The same indexer read the home page uses. Null when it isn't published yet, so the screen
  // waits instead of claiming the basket is empty.
  const live = network.testnet ? await readLive() : null;
  const initialBasket = live?.basket?.coins.map((c) => ({ token: c.token, symbol: c.symbol, weightPct: c.weightPct })) ?? null;
  return <StakeApp initialBasket={initialBasket} stakeWindow={network.testnet ? null : readStakeWindow(process.env)} />;
}
