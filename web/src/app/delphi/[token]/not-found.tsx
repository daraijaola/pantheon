import { Suspense } from "react";
import { SiteShell } from "@/components/site-shell";
import { MissingReport } from "@/components/delphi/missing-report";

export default function NotFound() {
  return <SiteShell quiet><Suspense><MissingReport /></Suspense></SiteShell>;
}
