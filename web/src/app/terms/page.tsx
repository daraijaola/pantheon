import type { Metadata } from "next";
import { Terms } from "@/components/feature-page/terms";
import { SiteShell } from "@/components/site-shell";

export const metadata: Metadata = { title: "Terms of use · PANTHEON", description: "The plain rules for using PANTHEON." };

export default function Page() {
  return (
    <SiteShell>
      <Terms />
    </SiteShell>
  );
}
