import type { Metadata } from "next";
import { Big_Shoulders, Geist, Geist_Mono, JetBrains_Mono, Space_Grotesk } from "next/font/google";
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

// Site UI (Firecrawl-style system): Geist + Geist Mono. The fonts above are for the /imagery tile only.
const geist = Geist({ subsets: ["latin"], variable: "--font-geist-sans" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });

const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-jetbrains",
});

export const metadata: Metadata = {
  title: "PANTHEON · The best of Ascend, in one token.",
  description: "The index of Ascend. Buys build the basket. Sells burn the supply.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${display.variable} ${sans.variable} ${mono.variable} ${geist.variable} ${geistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
