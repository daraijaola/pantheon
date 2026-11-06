import type { Metadata } from "next";
import { YourSpace } from "@/components/space/space";

export const metadata: Metadata = {
  title: "Your space · PANTHEON",
  description: "Your wallet through DELPHI's eyes: your bag, what you earn, your stake and your votes.",
  robots: { index: false, follow: false },
};

export default function Page() {
  return <YourSpace />;
}
