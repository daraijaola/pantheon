import type { Metadata } from "next";
import { NotPublished } from "@/components/delphi/delphi";
import { KalosIndex } from "@/components/delphi/kalos";
import { SiteShell } from "@/components/site-shell";
import { readDelphi } from "@/lib/delphi";

export const metadata: Metadata = {
  title: "DELPHI on Kalos · PANTHEON",
  description: "Every coin on Kalos, checked for bundled launches, wash trading, whales, contract powers and blocked sells, with the transactions behind every claim.",
  robots: { index: false, follow: false },
};

export default async function Page() {
  const data = await readDelphi();
  return <SiteShell quiet>{data?.kalos ? <KalosIndex data={data} /> : <NotPublished />}</SiteShell>;
}
