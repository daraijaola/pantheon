import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { auth, origin } from "@/lib/auth-http";
import { network } from "@/lib/chain/deployments";
import { mainnetGate } from "@/lib/mainnet-launch";

export function proxy(req: NextRequest) {
  const gate = mainnetGate(req.nextUrl.pathname, req.method, network.testnet);
  if (gate === "unavailable") return NextResponse.json({ error: "MAINNET_COMING_SOON", message: "Coming soon on mainnet" }, { status: 503, headers: { "cache-control": "no-store", "x-robots-tag": "noindex" } });
  if (gate === "page") {
    const response = NextResponse.rewrite(new URL("/coming-soon", req.url));
    response.headers.set("cache-control", "no-store");
    response.headers.set("x-robots-tag", "noindex");
    return response;
  }
  if (!network.testnet || req.nextUrl.pathname !== "/") return NextResponse.next();
  if (req.method !== "GET" || req.nextUrl.searchParams.get("home") === "1") return NextResponse.next();
  try {
    if (auth.session(origin(req), req.cookies.get(SESSION_COOKIE)?.value)) {
      const response = NextResponse.redirect(new URL("/space", req.url), 307);
      response.headers.set("cache-control", "private, no-store");
      response.headers.set("vary", "Cookie");
      return response;
    }
  } catch {
    return NextResponse.next();
  }
  return NextResponse.next();
}

export const config = { matcher: ["/", "/upload/:path*", "/space/:path*", "/passport/:path*", "/trials/:path*", "/delphi/:path*", "/stake/:path*", "/api/:path*"] };
