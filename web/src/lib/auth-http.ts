import { randomBytes } from "node:crypto";
import { createPublicClient, http } from "viem";
import { verifySiweMessage } from "viem/siwe";
import { NextRequest, NextResponse } from "next/server";
import { AuthError, createAuth, NONCE_COOKIE, NONCE_SECONDS, SESSION_COOKIE, SESSION_SECONDS, sessionSecret, type ReplayState } from "./auth";
import { network } from "./chain/deployments";

const state = globalThis as typeof globalThis & { pantheonAuth?: { secret: string; used?: Map<string, number>; replay?: ReplayState } };
const shared = state.pantheonAuth ??= { secret: randomBytes(32).toString("hex") };
const replay = shared.replay ??= { used: shared.used ?? new Map(), cutoff: Date.now() };
const client = createPublicClient({ transport: http(process.env.ELYSIUM_RPC ?? (network.testnet ? process.env.NEXT_PUBLIC_RPC_URL : undefined) ?? network.publicRpc, { timeout: 10_000, retryCount: 0 }) });
export const auth = createAuth({
  chainId: network.chainId,
  secret: () => sessionSecret(process.env, shared.secret), replay,
  verify: ({ message, signature }) => verifySiweMessage(client, { message, signature }),
});
export function origin(req: Request) {
  return new URL(process.env.AUTH_ORIGIN ?? req.url).origin;
}
export function sameOrigin(req: Request) {
  if (req.headers.get("sec-fetch-site") === "cross-site" || (req.headers.has("origin") && req.headers.get("origin") !== origin(req))) throw new AuthError(403, "WRONG_ORIGIN");
}
export function cookieOptions(req: Request, maxAge: number) {
  return { httpOnly: true, secure: process.env.NODE_ENV === "production" || new URL(origin(req)).protocol === "https:", sameSite: "lax" as const, path: "/", maxAge };
}
export function failure(error: unknown) {
  return NextResponse.json({ error: error instanceof AuthError ? error.message : "AUTH_UNAVAILABLE" }, { status: error instanceof AuthError ? error.status : 503, headers: { "cache-control": "no-store" } });
}
export function nonce(req: NextRequest) {
  try {
    sameOrigin(req);
    const { cookie, ...challenge } = auth.challenge(origin(req));
    const res = NextResponse.json(challenge, { headers: { "cache-control": "no-store" } });
    res.cookies.set(NONCE_COOKIE, cookie, cookieOptions(req, NONCE_SECONDS));
    return res;
  } catch (error) { return failure(error); }
}
export async function verify(req: NextRequest) {
  try {
    sameOrigin(req);
    if (req.headers.get("content-type")?.split(";")[0].trim() !== "application/json") throw new AuthError(415, "JSON_REQUIRED");
    const reader = req.body?.getReader();
    if (!reader) throw new AuthError(400, "INVALID_MESSAGE");
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 20_000) { await reader.cancel(); throw new AuthError(413, "MESSAGE_TOO_LARGE"); }
      chunks.push(value);
    }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new AuthError(400, "INVALID_MESSAGE"); }
    const session = await auth.verify(origin(req), req.cookies.get(NONCE_COOKIE)?.value, body?.message, body?.signature);
    const res = NextResponse.json({ wallet: session.wallet }, { headers: { "cache-control": "no-store" } });
    res.cookies.set(SESSION_COOKIE, session.cookie, cookieOptions(req, SESSION_SECONDS));
    res.cookies.set(NONCE_COOKIE, "", cookieOptions(req, 0));
    return res;
  } catch (error) {
    const res = failure(error);
    res.cookies.set(NONCE_COOKIE, "", cookieOptions(req, 0));
    return res;
  }
}
export function me(req: NextRequest) {
  try { return NextResponse.json({ wallet: auth.session(origin(req), req.cookies.get(SESSION_COOKIE)?.value) }, { headers: { "cache-control": "no-store" } }); }
  catch (error) { return failure(error); }
}
export function logout(req: NextRequest) {
  try {
    sameOrigin(req);
    const res = NextResponse.json({ wallet: null }, { headers: { "cache-control": "no-store" } });
    res.cookies.set(SESSION_COOKIE, "", cookieOptions(req, 0));
    res.cookies.set(NONCE_COOKIE, "", cookieOptions(req, 0));
    return res;
  } catch (error) { return failure(error); }
}
