// OAuth 1.0a request signing (HMAC-SHA1) for X's user-context endpoints: reading DELPHI's mentions
// and posting her replies as @heydelph. Only the query string and the oauth_* values are signed; a
// JSON or multipart body never is (that is how X expects it).
import { createHmac, randomBytes } from "node:crypto";

export type OAuthCreds = Readonly<{ apiKey: string; apiSecret: string; accessToken: string; accessSecret: string }>;

/** RFC 3986 percent-encoding, as OAuth 1.0a requires (stricter than encodeURIComponent). */
export const pct = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export function signature(method: string, url: string, params: Record<string, string>, consumerSecret: string, tokenSecret: string): string {
  const pairs = Object.entries(params)
    .map(([k, v]) => [pct(k), pct(v)] as const)
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0));
  const base = [method.toUpperCase(), pct(url), pct(pairs.map(([k, v]) => `${k}=${v}`).join("&"))].join("&");
  return createHmac("sha1", `${pct(consumerSecret)}&${pct(tokenSecret)}`).update(base).digest("base64");
}

/**
 * The Authorization header for one request. `url` may carry a query string; it is signed too.
 * `oauth` adds oauth_* values (oauth_callback, oauth_verifier) for the sign-in handshake; an empty
 * access token is left out (the first step of the handshake has none yet).
 */
export function authHeader(
  creds: OAuthCreds,
  method: string,
  url: string,
  opts: { nonce?: string; timestamp?: number; extra?: Record<string, string>; oauth?: Record<string, string> } = {},
): string {
  const u = new URL(url);
  const query: Record<string, string> = {};
  u.searchParams.forEach((v, k) => (query[k] = v));
  const oauth: Record<string, string> = {
    oauth_consumer_key: creds.apiKey,
    oauth_nonce: opts.nonce ?? randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(opts.timestamp ?? Math.floor(Date.now() / 1000)),
    ...(creds.accessToken ? { oauth_token: creds.accessToken } : {}),
    oauth_version: "1.0",
    ...(opts.oauth ?? {}),
  };
  const sig = signature(method, `${u.origin}${u.pathname}`, { ...query, ...(opts.extra ?? {}), ...oauth }, creds.apiSecret, creds.accessSecret);
  const all = { ...oauth, oauth_signature: sig };
  return `OAuth ${Object.entries(all)
    .map(([k, v]) => `${pct(k)}="${pct(v)}"`)
    .join(", ")}`;
}
