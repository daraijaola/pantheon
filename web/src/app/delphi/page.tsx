import type { Metadata } from "next";
import { DelphiIndex, NotPublished } from "@/components/delphi/delphi";
import { SiteShell } from "@/components/site-shell";
import { liveRound, readDelphi } from "@/lib/delphi";
import { readLive } from "@/lib/live";

export const metadata: Metadata = {
  title: "DELPHI · PANTHEON",
  description: "Every Ascend coin, checked for bundled launches, wash trading and hidden whales, with the transactions behind every claim.",
};

export default async function Page() {
  const [data, live] = await Promise.all([readDelphi(), readLive()]);
  const current = liveRound(live.basket?.coins.map((c) => c.token) ?? null);
  return <SiteShell quiet>{data ? <DelphiIndex data={data} current={current} /> : <NotPublished />}</SiteShell>;
}
