import type { Metadata } from "next";
import { SECURITY } from "@/components/feature-page/content";
import { FeaturePage } from "@/components/feature-page/feature-page";
import { SiteShell } from "@/components/site-shell";

export const metadata: Metadata = { title: "Security · PANTHEON", description: SECURITY.sub };

export default function Page() {
  return (
    <SiteShell>
      <FeaturePage page={SECURITY} />
    </SiteShell>
  );
}
