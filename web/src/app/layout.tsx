import { networkLabel } from "@/lib/network-copy";
import type { Metadata } from "next";
import { Big_Shoulders, Geist, Geist_Mono, JetBrains_Mono, Space_Grotesk } from "next/font/google";
import { SITE_ORIGIN } from "@/lib/meta";
import "./globals.css";

// Variable font with an optical-size axis: large sizes render with display proportions.
const display = Big_Shoulders({
  subsets: ["latin"],
  axes: ["opsz"],
  variable: "--font-big-shoulders",
});

const sans = Space_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-space-grotesk",
});

// Site UI (Firecrawl-style system): Geist + Geist Mono. The fonts above back globals.css's older
// --font-display, --font-sans and --font-mono tokens.
const geist = Geist({ subsets: ["latin"], variable: "--font-geist-sans" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });

const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-jetbrains",
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_ORIGIN),
  title: "PANTHEON · The best of Ascend, in one token.",
  description: "The index of Ascend. Buys build the basket. Sells burn the supply.",
  // "./" is resolved against the page being rendered, so every route gets its own
  // canonical and og:url without replacing this openGraph object (which would drop the share image).
  alternates: { canonical: "./" },
  // How a shared link looks on X, Discord and Telegram (the image is app/opengraph-image.png).
  openGraph: {
    type: "website",
    siteName: "PANTHEON",
    url: "./",
    title: "PANTHEON · The best of Ascend, in one token.",
    description: `One token that holds the best Ascend coins. Buys fill the basket, sells burn PNTH. Live on ${networkLabel}.`,
  },
  twitter: {
    card: "summary_large_image",
    site: "@pantheonindex",
    title: "PANTHEON · The best of Ascend, in one token.",
    description: `One token that holds the best Ascend coins. Buys fill the basket, sells burn PNTH. Live on ${networkLabel}.`,
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${display.variable} ${sans.variable} ${mono.variable} ${geist.variable} ${geistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
