import { networkText } from "@/lib/network-copy";
import type { Metadata } from "next";
import { GetApp } from "@/components/app/get-app";
import { SiteShell } from "@/components/site-shell";

export const metadata: Metadata = {
  title: networkText("Get test PNTH · PANTHEON", "Buy PNTH · PANTHEON"),
  description: networkText("Try PANTHEON on the Elysium testnet with free test money: get test USDC, buy PNTH, then stake it.", "PNTH is live on Elysium mainnet. Buy PNTH on Ascend."),
};

export default function Page() {
  return (
    <SiteShell quiet>
      <GetApp />
    </SiteShell>
  );
}
