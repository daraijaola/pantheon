import type { Metadata } from "next";
import { StakeApp } from "@/components/app/stake-app";
import { SiteShell } from "@/components/site-shell";

export const metadata: Metadata = { title: "Stake · PANTHEON", description: "Stake PNTH and earn Ascend's best coins." };

export default function Page() {
  return (
    <SiteShell quiet>
      <StakeApp />
    </SiteShell>
  );
}
