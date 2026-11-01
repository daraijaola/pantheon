import type { Metadata } from "next";
import { UploadApp } from "@/components/upload/upload-app";

export const metadata: Metadata = {
  title: "Get uploaded · PANTHEON",
  description: "Connect your wallet. DELPHI reads it and builds a space that is yours.",
  robots: { index: false, follow: false },
};

// Its own full-height page: no site menu or footer, just the way in.
export default function Page() {
  return <UploadApp />;
}
