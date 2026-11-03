import type { MetadataRoute } from "next";
import { readDelphi } from "@/lib/delphi";
import { SITE_ORIGIN } from "@/lib/meta";

// Public pages. /trials/vote and /covenant/launch are linked from the site and the README, so they
// are listed with the rest. Coin reports are added only when DELPHI's published scan is on disk.
const PATHS = [
  "/",
  "/security",
  "/trials",
  "/trials/vote",
  "/stake",
  "/delphi",
  "/passport",
  "/passport/get",
  "/covenant",
  "/covenant/launch",
  "/get",
  "/terms",
] as const;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const pages: MetadataRoute.Sitemap = PATHS.map((path) => ({
    url: path === "/" ? SITE_ORIGIN : `${SITE_ORIGIN}${path}`,
  }));

  const delphi = await readDelphi();
  if (!delphi) return pages;

  const seen = new Set<string>();
  for (const coin of delphi.coins) {
    const token = coin.token.toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(token) || seen.has(token)) continue;
    seen.add(token);
    pages.push({
      url: `${SITE_ORIGIN}/delphi/${coin.token}`,
      ...(delphi.generatedAt ? { lastModified: delphi.generatedAt } : {}),
    });
  }
  return pages;
}
