import type { Metadata } from "next";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { CoinReport, NotPublished } from "@/components/delphi/delphi";
import { SiteShell } from "@/components/site-shell";
import { liveRound, readDelphi } from "@/lib/delphi";
import { readLive } from "@/lib/live";

export const metadata: Metadata = {
  title: "Coin report · DELPHI · PANTHEON",
  description: "DELPHI's report on one Ascend coin, in plain words, with the transactions behind every claim.",
};

async function Report({ token }: { token: string }) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(token)) notFound();
  const data = await readDelphi();
  if (data && !data.coins.some((coin) => coin.token.toLowerCase() === token.toLowerCase())) notFound();
  const live = await readLive();
  const current = liveRound(live.basket?.coins.map((c) => c.token) ?? null);
  return data ? <CoinReport data={data} token={token} current={current} /> : <NotPublished />;
}

export default function Page({ params }: PageProps<"/delphi/[token]">) {
  return (
    <SiteShell quiet>
      <Suspense>{params.then(({ token }) => <Report token={token} />)}</Suspense>
    </SiteShell>
  );
}
