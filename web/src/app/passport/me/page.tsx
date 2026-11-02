import type { Metadata } from "next";
import { PassportBook } from "@/components/passport-book/passport-book";
import { SiteShell } from "@/components/site-shell";

export const metadata: Metadata = { title: "Your Passport · PANTHEON", description: "Your HYPE Passport and the stamps it carries." };

export default function Page() {
  return (
    <SiteShell quiet>
      <PassportBook />
    </SiteShell>
  );
}
