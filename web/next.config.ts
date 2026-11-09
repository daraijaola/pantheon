import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { NextConfig } from "next";
import { deploymentName, network } from "./src/lib/chain/deployments";

console.info(`[network] ${deploymentName} chainId=${network.chainId}`);

// Where the build lives. On the server, scripts/deploy.sh builds into the slot that isn't serving and then
// switches, so the live site never serves a half-written build (that was the 502s during every deploy).
// NEXT_DIST_DIR wins (the deploy script sets it while building), then the slot the site last switched to,
// then Next's default. Only these three names are accepted.
const SLOTS = [".next", ".next-a", ".next-b"];
const slot = existsSync(".dist-slot") ? readFileSync(".dist-slot", "utf8").trim() : "";
const distDir = [process.env.NEXT_DIST_DIR, slot].find((d) => d && SLOTS.includes(d)) ?? ".next";

const nextConfig: NextConfig = {
  env: { NEXT_PUBLIC_DEPLOYMENT: deploymentName },
  distDir,
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
    root: path.resolve(process.cwd(), ".."),
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
