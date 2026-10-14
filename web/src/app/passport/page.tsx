import type { Metadata } from "next";
import { PASSPORT } from "@/components/feature-page/content";
import { FeaturePage } from "@/components/feature-page/feature-page";
import { SiteShell } from "@/components/site-shell";

export const metadata: Metadata = { title: "HYPE Passport · PANTHEON", description: PASSPORT.sub };

export default function Page() {
  return (
    <SiteShell>
      <FeaturePage page={PASSPORT} />
    </SiteShell>
  );
}
