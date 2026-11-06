import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getAddress, isAddress, verifyMessage, type Hex } from "viem";
import { parseSiweMessage, validateSiweMessage } from "viem/siwe";

export const SESSION_SECONDS = 7 * 24 * 60 * 60;
export const NONCE_SECONDS = 5 * 60;
export const NONCES_PER_CLIENT = 5;
export const SESSION_COOKIE = "pantheon_session";
export const NONCE_COOKIE = "pantheon_nonce";
export const ME_PATHS = new Map([
  ["bag", "bag"], ["rewards", "rewards"], ["stake", "stake"], ["standing", "standing"],
  ["guard", "guard"], ["trials/record", "record"], ["trials/ballot", "ballot"], ["scan", "scan"],
]);
type Challenge = { nonce: string; origin: string; issued: number; expires: number };
type Session = { wallet: string; origin: string; expires: number };
export type PendingNonce = { expires: number; client: string };

export function nonceClient(headers: Headers, remoteAddress = "local") {
  return headers.get("x-forwarded-for")?.split(",")[0].trim() || remoteAddress;
}

export class AuthError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export function sessionSecret(env: Record<string, string | undefined>, developmentSecret: string) {
  const secret = env.SESSION_SECRET ?? (env.NODE_ENV !== "production" ? developmentSecret : "");
  if (secret.length < 32) throw new AuthError(503, "AUTH_UNAVAILABLE");
  return secret;
}

export function createAuth(options: {
  secret: () => string;
  pending?: Map<string, PendingNonce>;
  now?: () => number;
  verify?: (args: { address: Hex; message: string; signature: Hex }) => Promise<boolean>;
}) {
  const pending = options.pending ?? new Map<string, PendingNonce>();
  const now = options.now ?? Date.now;
  const verify = options.verify ?? verifyMessage;
  function seal(kind: string, value: object) {
    const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${payload}.${createHmac("sha256", options.secret()).update(`${kind}.${payload}`).digest("base64url")}`;
  }
  function open<T>(kind: string, cookie?: string): T | null {
    const secret = options.secret();
    if (!cookie || cookie.length > 4096) return null;
    const [payload, mac, extra] = cookie.split(".");
    if (!payload || !mac || extra) return null;
    const expected = createHmac("sha256", secret).update(`${kind}.${payload}`).digest();
    const actual = Buffer.from(mac, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    try { return JSON.parse(Buffer.from(payload, "base64url").toString()) as T; } catch { return null; }
  }
  return {
    challenge(origin: string, client = "local") {
      const issued = now();
      let outstanding = 0;
      for (const [nonce, entry] of pending) {
        if (entry.expires <= issued) pending.delete(nonce);
        else if (entry.client === client) outstanding++;
      }
      if (outstanding >= NONCES_PER_CLIENT) throw new AuthError(429, "TRY_AGAIN_LATER");
      const value: Challenge = { nonce: randomBytes(24).toString("hex"), origin, issued, expires: issued + NONCE_SECONDS * 1000 };
      const cookie = seal("nonce", value);
      if (pending.size >= 10_000) pending.delete(pending.keys().next().value!);
      pending.set(value.nonce, { expires: value.expires, client });
      return { cookie, nonce: value.nonce, domain: new URL(origin).host, uri: origin, chainId: 99801, issuedAt: new Date(issued).toISOString(), expirationTime: new Date(value.expires).toISOString() };
    },
    async verify(origin: string, cookie: string | undefined, message: unknown, signature: unknown) {
      const challenge = open<Challenge>("nonce", cookie);
      if (!challenge || challenge.origin !== origin || challenge.expires <= now() || pending.get(challenge.nonce)?.expires !== challenge.expires) throw new AuthError(401, "INVALID_NONCE");
      pending.delete(challenge.nonce);
      if (typeof message !== "string" || message.length > 8192 || typeof signature !== "string" || !/^0x[0-9a-f]+$/i.test(signature) || signature.length > 8192) throw new AuthError(400, "INVALID_MESSAGE");
      let parsed;
      try { parsed = parseSiweMessage(message); } catch { throw new AuthError(401, "INVALID_MESSAGE"); }
      if (!parsed.address || !isAddress(parsed.address) || parsed.version !== "1" || parsed.chainId !== 99801 || parsed.uri !== origin || (parsed.scheme && `${parsed.scheme}:` !== new URL(origin).protocol) || parsed.issuedAt?.getTime() !== challenge.issued || parsed.expirationTime?.getTime() !== challenge.expires || !validateSiweMessage({ message: parsed, domain: new URL(origin).host, nonce: challenge.nonce, time: new Date(now()) })) throw new AuthError(401, "INVALID_MESSAGE");
      let valid = false;
      try { valid = await verify({ address: parsed.address, message, signature: signature as Hex }); } catch { /* Invalid signatures fail closed. */ }
      if (!valid) throw new AuthError(401, "INVALID_SIGNATURE");
      if (challenge.expires <= now()) throw new AuthError(401, "INVALID_NONCE");
      const wallet = getAddress(parsed.address).toLowerCase();
      return { wallet, cookie: seal("session", { wallet, origin, expires: now() + SESSION_SECONDS * 1000 }) };
    },
    session(origin: string, cookie?: string) {
      const session = open<Session>("session", cookie);
      return session && typeof session.wallet === "string" && isAddress(session.wallet) && session.origin === origin && session.expires > now() ? session.wallet.toLowerCase() : null;
    },
  };
}
