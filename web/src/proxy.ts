import { NextResponse, type NextRequest } from "next/server";

// /upload is not public yet. It answers 404 unless a preview gate passes: ?preview=<token> once
// (sets an httpOnly cookie, then redirects to the clean URL), or that cookie on later visits.
// The token lives only in the server's environment (UPLOAD_PREVIEW_TOKEN), never in the repo.
const COOKIE = "pantheon_upload_preview";

export function proxy(req: NextRequest) {
  const token = process.env.UPLOAD_PREVIEW_TOKEN;
  if (token && token.length >= 16) {
    if (req.nextUrl.searchParams.get("preview") === token) {
      // Back to the clean URL on the host the visitor used (behind Caddy: the forwarded host and scheme).
      const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? req.nextUrl.host;
      const proto = req.headers.get("x-forwarded-proto") ?? req.nextUrl.protocol.replace(":", "");
      const res = NextResponse.redirect(`${proto}://${host}/upload`, 307);
      res.cookies.set(COOKIE, token, { httpOnly: true, secure: true, sameSite: "lax", path: "/upload", maxAge: 60 * 60 * 24 * 30 });
      return res;
    }
    if (req.cookies.get(COOKIE)?.value === token) return NextResponse.next();
  }
  // Same-origin rewrite to a route that doesn't exist: Next serves its 404 page with a 404 status.
  const hidden = req.nextUrl.clone();
  hidden.pathname = "/_hidden/upload";
  hidden.search = "";
  // Behind Caddy the URL says https, but this server speaks plain http: keep the rewrite internal.
  hidden.protocol = "http:";
  return NextResponse.rewrite(hidden);
}

export const config = { matcher: ["/upload"] };
