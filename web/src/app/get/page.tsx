import type { Metadata } from "next";
import { GetApp } from "@/components/app/get-app";
import { SiteShell } from "@/components/site-shell";

export const metadata: Metadata = {
  title: "Get test PNTH · PANTHEON",
  description: "Try PANTHEON on the Elysium testnet with free test money: get test USDC, buy PNTH, then stake it.",
};

export default function Page() {
  return (
    <SiteShell quiet>
      <GetApp />
    </SiteShell>
  );
}
