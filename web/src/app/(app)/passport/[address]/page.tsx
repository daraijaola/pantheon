import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isAddress } from "viem";
import { PassportBook } from "@/components/passport-book/passport-book";

type Props = { params: Promise<{ address: string }> };

export const instant = false;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { address } = await params;
  const title = "HYPE Passport · PANTHEON";
  const description = "Public Passport tier, boost and stamps on Elysium. No Hyperliquid address or balances.";
  return { title, description, alternates: { canonical: `/passport/${address.toLowerCase()}` }, openGraph: { title, description, url: `/passport/${address.toLowerCase()}` }, twitter: { card: "summary_large_image", title, description } };
}

export default async function Page({ params }: Props) {
  const { address } = await params;
  if (!isAddress(address, { strict: false })) notFound();
  return <PassportBook publicAddress={address.toLowerCase() as `0x${string}`} />;
}
