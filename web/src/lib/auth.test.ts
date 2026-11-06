import assert from "node:assert/strict";
import { test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { QueryClient, QueryObserver } from "@tanstack/react-query";

const { createAuth, sessionSecret, nonceClient, ME_PATHS, NONCE_SECONDS, NONCES_PER_CLIENT, SESSION_SECONDS } = await import(new URL("./auth.ts", import.meta.url).href) as typeof import("./auth");
const { clearSession } = await import(new URL("./auth-client.ts", import.meta.url).href) as typeof import("./auth-client");
const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
const other = privateKeyToAccount(`0x${"22".repeat(32)}`);
const origin = "https://pantheon.example";
const secret = "test-only-session-key-with-at-least-32-characters";
function setup() {
  let time = Date.parse("2026-11-06T00:00:00Z");
  const auth = createAuth({ secret: () => secret, now: () => time });
  const challenge = auth.challenge(origin);
  const fields = { address: account.address, domain: challenge.domain, uri: challenge.uri, nonce: challenge.nonce, chainId: 99801, version: "1" as const, issuedAt: new Date(challenge.issuedAt), expirationTime: new Date(challenge.expirationTime) };
  return { auth, challenge, fields, advance: (ms: number) => { time += ms; } };
}
test("SIWE signs in the signing wallet; session expires after seven days", async () => {
  const { auth, challenge, fields, advance } = setup();
  const message = createSiweMessage(fields);
  const signed = await auth.verify(origin, challenge.cookie, message, await account.signMessage({ message }));
  assert.equal(signed.wallet, account.address.toLowerCase());
  assert.equal(auth.session(origin, signed.cookie), signed.wallet);
  assert.equal(auth.session("https://other.example", signed.cookie), null);
  assert.equal(auth.session(origin, challenge.cookie), null);
  advance(SESSION_SECONDS * 1000 - 1);
  assert.equal(auth.session(origin, signed.cookie), signed.wallet);
  advance(1);
  assert.equal(auth.session(origin, signed.cookie), null);
});
test("no cookie, malformed cookies and tampered sessions never authenticate", async () => {
  const { auth, challenge, fields } = setup();
  assert.equal(auth.session(origin), null);
  for (const value of ["", "x.y", "{}.signature", "a.b.c", "x".repeat(5000)]) assert.equal(auth.session(origin, value), null);
  const message = createSiweMessage(fields);
  const signed = await auth.verify(origin, challenge.cookie, message, await account.signMessage({ message }));
  assert.equal(auth.session(origin, `x${signed.cookie}`), null);
  assert.equal(auth.session(origin, signed.cookie.slice(0, -3)), null);
});
test("a nonce is single use, including concurrent verification", async () => {
  const { auth, challenge, fields } = setup();
  const message = createSiweMessage(fields), signature = await account.signMessage({ message });
  const results = await Promise.allSettled([auth.verify(origin, challenge.cookie, message, signature), auth.verify(origin, challenge.cookie, message, signature)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  await assert.rejects(auth.verify(origin, challenge.cookie, message, signature), /INVALID_NONCE/);
});
test("nonces require the bound cookie, origin, live challenge and signing key", async () => {
  for (const kind of ["missing", "tampered", "expired", "origin", "restart", "signature"] as const) {
    const { auth, challenge, fields, advance } = setup();
    const message = createSiweMessage(fields);
    const signature = await (kind === "signature" ? other : account).signMessage({ message });
    if (kind === "expired") advance(NONCE_SECONDS * 1000);
    const verifier = kind === "restart" ? createAuth({ secret: () => secret }) : auth;
    await assert.rejects(verifier.verify(kind === "origin" ? "https://other.example" : origin, kind === "missing" ? undefined : kind === "tampered" ? `x${challenge.cookie}` : challenge.cookie, message, signature), /INVALID_/);
  }
});
test("domain, URI, chain, nonce, issue time and expiry cannot be supplied by the signer", async () => {
  const changes = [
    { domain: "other.example" }, { uri: `${origin}/wrong` }, { chainId: 1 }, { nonce: "anothernonce123" },
    { issuedAt: new Date("2026-11-05T00:00:00Z") }, { expirationTime: new Date("2027-01-01T00:00:00Z") },
    { expirationTime: undefined }, { notBefore: new Date("2026-11-07T00:00:00Z") }, { scheme: "http" },
  ];
  for (const change of changes) {
    const { auth, challenge, fields } = setup();
    const message = createSiweMessage({ ...fields, ...change });
    await assert.rejects(auth.verify(origin, challenge.cookie, message, await account.signMessage({ message })), /INVALID_MESSAGE/);
  }
});
test("empty, malformed and oversized message/signature inputs fail closed", async () => {
  for (const [message, signature] of [[null, null], ["", "0x"], ["bad message", "0x1234"], ["x".repeat(9000), "0x1234"], [{}, {}]]) {
    const { auth, challenge } = setup();
    await assert.rejects(auth.verify(origin, challenge.cookie, message, signature), /INVALID_/);
  }
});
test("production requires a strong server secret; development can use an ephemeral key", () => {
  assert.throws(() => sessionSecret({ NODE_ENV: "production" }, secret), /AUTH_UNAVAILABLE/);
  assert.throws(() => sessionSecret({ NODE_ENV: "production", SESSION_SECRET: "short" }, secret), /AUTH_UNAVAILABLE/);
  assert.equal(sessionSecret({ NODE_ENV: "production", SESSION_SECRET: secret }, ""), secret);
  assert.equal(sessionSecret({ NODE_ENV: "development" }, secret), secret);
  const auth = createAuth({ secret: () => sessionSecret({ NODE_ENV: "production" }, secret) });
  assert.throws(() => auth.session(origin), /AUTH_UNAVAILABLE/);
  assert.throws(() => auth.challenge(origin), /AUTH_UNAVAILABLE/);
});
test("pending nonces are bounded and expired challenges are pruned", () => {
  const pending = new Map(Array.from({ length: 10_000 }, (_, i) => [String(i), { expires: 10_000, client: String(i) }]));
  let time = 0;
  const auth = createAuth({ secret: () => secret, pending, now: () => time });
  const challenge = auth.challenge(origin, "new-client");
  assert.equal(pending.size, 10_000);
  assert.equal(pending.has("0"), false);
  assert.equal(pending.has(challenge.nonce), true);
  time = NONCE_SECONDS * 1000;
  auth.challenge(origin);
  assert.equal(pending.size, 1);
});
test("one client cannot exhaust other clients' nonce capacity", async () => {
  const { auth, challenge, fields, advance } = setup();
  for (let i = 1; i < NONCES_PER_CLIENT; i++) auth.challenge(origin);
  for (let i = 0; i < 100; i++) assert.throws(() => auth.challenge(origin), /TRY_AGAIN_LATER/);
  assert.ok(auth.challenge(origin, "another-client").nonce);
  const message = createSiweMessage(fields);
  const signed = await auth.verify(origin, challenge.cookie, message, await account.signMessage({ message }));
  assert.equal(auth.session(origin, signed.cookie), account.address.toLowerCase());
  assert.ok(auth.challenge(origin).nonce);
  assert.throws(() => auth.challenge(origin), /TRY_AGAIN_LATER/);
  advance(NONCE_SECONDS * 1000);
  assert.ok(auth.challenge(origin).nonce);
});
test("nonce client uses the first trusted forwarded hop or remote address", () => {
  assert.equal(nonceClient(new Headers({ "x-forwarded-for": " 192.0.2.1, 198.51.100.2 " }), "127.0.0.1"), "192.0.2.1");
  assert.equal(nonceClient(new Headers(), "127.0.0.1"), "127.0.0.1");
  assert.equal(nonceClient(new Headers({ "x-forwarded-for": " " }), "127.0.0.1"), "127.0.0.1");
});
test("gateway exposes only the dashboard reads and scan, never arbitrary wallet paths", () => {
  assert.deepEqual([...ME_PATHS.keys()], ["bag", "rewards", "stake", "standing", "guard", "trials/record", "trials/ballot", "scan"]);
  assert.equal(ME_PATHS.get("trials/record"), "record");
  assert.equal(ME_PATHS.get("trials/ballot"), "ballot");
  for (const path of ["", "../bag", "/bag", "wallets/0x123/bag", "footprint", "elsewhere", "stake/unstake-preview", "bag/extra"]) assert.equal(ME_PATHS.has(path), false);
});
test("logout clears private reads and notifies active session observers", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "/api/auth/logout");
    assert.equal(init.method, "POST");
    return Response.json({ wallet: null });
  });
  const client = new QueryClient();
  client.setQueryData(["me", "session"], account.address);
  client.setQueryData(["me", "bag", account.address], { coins: ["private"] });
  client.setQueryData(["auth", "nonce", account.address], "challenge");
  const session = new QueryObserver<string | null>(client, { queryKey: ["me", "session"], enabled: false });
  let observed: unknown = account.address;
  const unsubscribe = session.subscribe((result) => { observed = result.data; });
  await clearSession(client);
  assert.equal(observed, null);
  assert.equal(client.getQueryData(["me", "session"]), null);
  assert.equal(client.getQueryData(["me", "bag", account.address]), undefined);
  assert.equal(client.getQueryData(["auth", "nonce", account.address]), undefined);
  unsubscribe();
  client.clear();
});
