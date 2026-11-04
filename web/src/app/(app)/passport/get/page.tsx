import type { Metadata } from "next";
import { PassportApp } from "@/components/app/passport-app";

export const metadata: Metadata = { title: "Get your HYPE Passport · PANTHEON", description: "Prove you hold HYPE with one signature." };

export default function Page() {
  return <PassportApp />;
}
