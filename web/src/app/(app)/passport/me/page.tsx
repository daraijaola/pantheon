import type { Metadata } from "next";
import { PassportBook } from "@/components/passport-book/passport-book";

export const metadata: Metadata = { title: "Your Passport · PANTHEON", description: "Your HYPE Passport and the stamps it carries." };

export default function Page() {
  return <PassportBook />;
}
