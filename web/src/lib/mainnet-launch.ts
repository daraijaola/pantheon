const deferredPages = ["/upload", "/space", "/passport", "/trials", "/delphi", "/stake"];
const authRoutes = ["/api/auth/nonce", "/api/auth/verify", "/api/auth/me", "/api/auth/logout"];

export function mainnetGate(pathname: string, method: string, testnet: boolean): "page" | "unavailable" | null {
  if (testnet) return null;
  const path = pathname.replace(/\/+$/, "") || "/";
  if (["/upload/delphi.png", "/upload/caspian-tile.webp"].includes(path)) return null;
  if (path === "/api" || path.startsWith("/api/")) return authRoutes.includes(path) ? null : "unavailable";
  if (!deferredPages.some(prefix => path === prefix || path.startsWith(`${prefix}/`))) return null;
  return !["GET", "HEAD"].includes(method) || path.includes("/opengraph-image") ? "unavailable" : "page";
}

export function backendRewrites(testnet: boolean, env: Record<string, string | undefined>) {
  if (!testnet) return [];
  const passport = env.PASSPORT_API ?? "http://127.0.0.1:8787";
  const trials = env.TRIALS_API ?? "http://127.0.0.1:8790";
  const indexer = env.INDEXER_API ?? "http://127.0.0.1:8789";
  return [
    { source: "/api/passport/:path*", destination: `${passport}/passport/:path*` },
    { source: "/api/trials/:path*", destination: `${trials}/trials/:path*` },
    { source: "/api/stats", destination: `${indexer}/stats` },
    { source: "/api/basket", destination: `${indexer}/basket` },
    { source: "/api/receipts", destination: `${indexer}/receipts` },
  ];
}
