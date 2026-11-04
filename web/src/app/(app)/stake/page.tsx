import type { Metadata } from "next";
import { StakeApp } from "@/components/app/stake-app";
import { readLive } from "@/lib/live";

export const metadata: Metadata = { title: "Stake · PANTHEON", description: "Stake PNTH and earn Ascend's best coins." };

export default async function Page() {
  // The same indexer read the home page uses. Null when it isn't published yet, so the screen
  // waits instead of claiming the basket is empty.
  const live = await readLive();
  const initialBasket = live.basket?.coins.map((c) => ({ token: c.token, symbol: c.symbol, weightPct: c.weightPct })) ?? null;
  return <StakeApp initialBasket={initialBasket} />;
}
