import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  // The HYPE Passport service (services/passport) answers under /api/passport on our own domain.
  async rewrites() {
    const api = process.env.PASSPORT_API ?? "http://127.0.0.1:8787";
    return [{ source: "/api/passport/:path*", destination: `${api}/passport/:path*` }];
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
