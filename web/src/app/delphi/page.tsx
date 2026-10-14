import type { Metadata } from "next";
import { DelphiIndex, NotPublished } from "@/components/delphi/delphi";
import { SiteShell } from "@/components/site-shell";
import { readDelphi } from "@/lib/delphi";

export const metadata: Metadata = {
  title: "DELPHI · PANTHEON",
  description: "Every Ascend coin, checked for bundled launches, wash trading and hidden whales, with the transactions behind every claim.",
};

export default async function Page() {
  const data = await readDelphi();
  return <SiteShell quiet>{data ? <DelphiIndex data={data} /> : <NotPublished />}</SiteShell>;
}
