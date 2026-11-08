import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { auth, origin } from "@/lib/auth-http";

export function proxy(req: NextRequest) {
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

export const config = { matcher: "/" };
