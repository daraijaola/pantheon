import type { Metadata } from "next";
import { CovenantLaunchApp } from "@/components/app/covenant-app";

export const metadata: Metadata = {
  title: "Launch on Covenant · PANTHEON",
  description: "Launch a coin on Ascend whose fees follow rules nobody can change: burn, pay a wallet, or feed the PANTHEON basket.",
};

export default function Page() {
  return <CovenantLaunchApp />;
}
