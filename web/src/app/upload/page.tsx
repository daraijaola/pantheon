import type { Metadata } from "next";
import { SiteShell } from "@/components/site-shell";
import { UploadApp } from "@/components/upload/upload-app";

export const metadata: Metadata = {
  title: "Get uploaded · PANTHEON",
  description: "DELPHI is ready to build your self.",
  robots: { index: false, follow: false },
};

export default function Page() {
  return (
    <SiteShell quiet>
      <UploadApp />
    </SiteShell>
  );
}
