import type { Metadata } from "next";
import { COVENANT } from "@/components/feature-page/content";
import { FeaturePage } from "@/components/feature-page/feature-page";
import { SiteShell } from "@/components/site-shell";

export const metadata: Metadata = { title: "Covenant · PANTHEON", description: COVENANT.sub };

export default function Page() {
  return (
    <SiteShell>
      <FeaturePage page={COVENANT} />
    </SiteShell>
  );
}
