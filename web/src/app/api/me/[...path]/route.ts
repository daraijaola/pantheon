import { NextRequest } from "next/server";
import { AuthError, ME_PATHS, SESSION_COOKIE } from "@/lib/auth";
import { auth, failure, origin, sameOrigin } from "@/lib/auth-http";

export async function GET(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  try {
    const wallet = auth.session(origin(req), req.cookies.get(SESSION_COOKIE)?.value);
    if (!wallet) throw new AuthError(401, "SIGN_IN_REQUIRED");
    const path = (await params).path.join("/");
    const upstreamPath = ME_PATHS.get(path);
    if (!upstreamPath) throw new AuthError(404, "NOT_FOUND");
    const base = process.env.UPLOADED_API ?? "http://127.0.0.1:8791";
    const url = new URL(`${base.replace(/\/$/, "")}/wallets/${wallet}/${upstreamPath}`);
    url.search = req.nextUrl.search;
    const upstream = await fetch(url, { cache: "no-store", signal: AbortSignal.any([req.signal, AbortSignal.timeout(path === "scan" ? 180_000 : 30_000)]), headers: { accept: path === "scan" ? "text/event-stream" : "application/json" }, redirect: "error" });
    return new Response(upstream.body, { status: upstream.status, headers: { "content-type": upstream.headers.get("content-type") ?? "application/json", "cache-control": "no-store, no-transform", "x-accel-buffering": "no" } });
  } catch (error) {
    return failure(error instanceof AuthError ? error : new AuthError(502, "UPLOADED_UNAVAILABLE"));
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  try {
    sameOrigin(req);
    const wallet = auth.session(origin(req), req.cookies.get(SESSION_COOKIE)?.value);
    if (!wallet) throw new AuthError(401, "SIGN_IN_REQUIRED");
    if ((await params).path.join("/") !== "read") throw new AuthError(404, "NOT_FOUND");
    const base = process.env.UPLOADED_API ?? "http://127.0.0.1:8791";
    const upstream = await fetch(`${base.replace(/\/$/, "")}/wallets/${wallet}/read`, { method: "POST", cache: "no-store", signal: AbortSignal.timeout(180_000), redirect: "error" });
    return new Response(upstream.body, { status: upstream.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  } catch (error) {
    return failure(error instanceof AuthError ? error : new AuthError(502, "UPLOADED_UNAVAILABLE"));
  }
}
