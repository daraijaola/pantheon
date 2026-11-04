import type { Metadata } from "next";
import { TrialsApp } from "@/components/app/trials-app";

export const metadata: Metadata = {
  title: "Vote · The Trials · PANTHEON",
  description: "PNTH stakers vote coins into PANTHEON's basket, and a HYPE Passport adds votes. A vote is a free signature, and every ballot is public.",
};

export default function Page() {
  return <TrialsApp />;
}
