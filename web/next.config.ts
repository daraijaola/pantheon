import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  // Our services on this machine, under our own domain: the Passport (services/passport), the Trials vote
  // (services/trials) and the live numbers (services/indexer).
  async rewrites() {
    const passport = process.env.PASSPORT_API ?? "http://127.0.0.1:8787";
    const trials = process.env.TRIALS_API ?? "http://127.0.0.1:8790";
    const indexer = process.env.INDEXER_API ?? "http://127.0.0.1:8789";
    return [
      { source: "/api/passport/:path*", destination: `${passport}/passport/:path*` },
      { source: "/api/trials/:path*", destination: `${trials}/trials/:path*` },
      { source: "/api/stats", destination: `${indexer}/stats` },
      { source: "/api/basket", destination: `${indexer}/basket` },
      { source: "/api/receipts", destination: `${indexer}/receipts` },
    ];
  },
  partialPrefetching: true,
  turbopack: {
    rules: {
      // Only the global stylesheet needs Tailwind; component CSS modules must keep their scoped class names.
      "globals.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
