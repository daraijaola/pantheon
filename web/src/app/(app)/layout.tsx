import type { ReactNode } from "react";
import { Providers } from "@/components/app/providers";
import { AppFrame } from "@/components/app-frame/app-frame";

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <Providers>
      <AppFrame>{children}</AppFrame>
    </Providers>
  );
}
