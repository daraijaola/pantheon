import type { Metadata } from "next";
import { TRIALS } from "@/components/feature-page/content";
import { FeaturePage } from "@/components/feature-page/feature-page";
import { SiteShell } from "@/components/site-shell";

export const metadata: Metadata = { title: "The Trials · PANTHEON", description: TRIALS.sub };

export default function Page() {
  return (
    <SiteShell>
      <FeaturePage page={TRIALS} />
    </SiteShell>
  );
}
