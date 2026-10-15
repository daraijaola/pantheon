import type { Metadata } from "next";
import { TrialsApp } from "@/components/app/trials-app";
import { SiteShell } from "@/components/site-shell";

export const metadata: Metadata = {
  title: "Vote · The Trials · PANTHEON",
  description: "HYPE Passport holders vote coins into PANTHEON's basket. A vote is a free signature, and every ballot is public.",
};

export default function Page() {
  return (
    <SiteShell quiet>
      <TrialsApp />
    </SiteShell>
  );
}
