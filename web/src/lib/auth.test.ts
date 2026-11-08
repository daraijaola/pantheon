import assert from "node:assert/strict";
import { test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { QueryClient, QueryObserver } from "@tanstack/react-query";

const { createAuth, sessionSecret, ME_PATHS, NONCE_SECONDS, SESSION_SECONDS } = await import(new URL("./auth.ts", import.meta.url).href) as typeof import("./auth");
const { clearSession } = await import(new URL("./auth-client.ts", import.meta.url).href) as typeof import("./auth-client");
const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
const other = privateKeyToAccount(`0x${"22".repeat(32)}`);
const origin = "https://pantheon.example";
const secret = "test-only-session-key-with-at-least-32-characters";
function setup(used = new Map<string, number>()) {
  let time = Date.parse("2026-11-06T00:00:00Z");
  const replay = { used, cutoff: -Infinity };
  const auth = createAuth({ secret: () => secret, now: () => time, replay });
  const challenge = auth.challenge(origin);
  const fields = { address: account.address, domain: challenge.domain, uri: challenge.uri, nonce: challenge.nonce, chainId: 99801, version: "1" as const, issuedAt: new Date(challenge.issuedAt), expirationTime: new Date(challenge.expirationTime) };
  return { auth, challenge, fields, replay, advance: (ms: number) => { time += ms; } };
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
  for (const kind of ["missing", "tampered", "expired", "origin", "signature"] as const) {
    const { auth, challenge, fields, advance } = setup();
    const message = createSiweMessage(fields);
    const signature = await (kind === "signature" ? other : account).signMessage({ message });
    if (kind === "expired") advance(NONCE_SECONDS * 1000);
    await assert.rejects(auth.verify(kind === "origin" ? "https://other.example" : origin, kind === "missing" ? undefined : kind === "tampered" ? `x${challenge.cookie}` : challenge.cookie, message, signature), /INVALID_/);
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
test("unsigned challenges allocate no server state and cancelled prompts never block retries", async () => {
  const used = new Map<string, number>();
  const { auth, challenge, fields } = setup(used);
  for (let i = 0; i < 10_001; i++) assert.ok(auth.challenge(origin).nonce);
  assert.equal(used.size, 0);
  const message = createSiweMessage(fields);
  const signed = await auth.verify(origin, challenge.cookie, message, await account.signMessage({ message }));
  assert.equal(auth.session(origin, signed.cookie), account.address.toLowerCase());
  assert.equal(used.size, 1);
});
test("only a valid signature consumes a nonce; failed signatures can be retried", async () => {
  const used = new Map<string, number>();
  const { auth, challenge, fields } = setup(used);
  const message = createSiweMessage(fields);
  await assert.rejects(auth.verify(origin, challenge.cookie, "malformed", "0x1234"), /INVALID_MESSAGE/);
  await assert.rejects(auth.verify(origin, challenge.cookie, message, await other.signMessage({ message })), /INVALID_SIGNATURE/);
  assert.equal(used.size, 0);
  await auth.verify(origin, challenge.cookie, message, await account.signMessage({ message }));
  assert.equal(used.get(challenge.nonce), Date.parse(challenge.expirationTime));
});
test("the signed cookie proves issuance without a pending record", async () => {
  const used = new Map<string, number>();
  const replay = { used, cutoff: -Infinity };
  const { challenge, fields } = setup();
  const verifier = createAuth({ secret: () => secret, replay, now: () => fields.issuedAt.getTime() });
  const message = createSiweMessage(fields), signature = await account.signMessage({ message });
  assert.equal((await verifier.verify(origin, challenge.cookie, message, signature)).wallet, account.address.toLowerCase());
  const second = createAuth({ secret: () => secret, replay, now: () => fields.issuedAt.getTime() });
  await assert.rejects(second.verify(origin, challenge.cookie, message, signature), /INVALID_NONCE/);
});
test("a fresh auth instance rejects pre-start challenges but accepts newly issued ones", async () => {
  const { auth: previous, challenge, fields } = setup();
  const message = createSiweMessage(fields), signature = await account.signMessage({ message });
  await previous.verify(origin, challenge.cookie, message, signature);
  let time = fields.issuedAt.getTime() + 1000;
  const fresh = createAuth({ secret: () => secret, now: () => time });
  await assert.rejects(fresh.verify(origin, challenge.cookie, message, signature), /INVALID_NONCE/);
  const next = fresh.challenge(origin);
  assert.ok(Date.parse(next.issuedAt) > time);
  const nextMessage = createSiweMessage({ ...fields, nonce: next.nonce, issuedAt: new Date(next.issuedAt), expirationTime: new Date(next.expirationTime) });
  time += 2;
  assert.equal((await fresh.verify(origin, next.cookie, nextMessage, await account.signMessage({ message: nextMessage }))).wallet, account.address.toLowerCase());
});
test("expired replay records are pruned without raising the cutoff", async () => {
  const expires = Date.parse("2026-11-06T00:00:01Z");
  const used = new Map(Array.from({ length: 10_000 }, (_, i) => [String(i), expires]));
  const { auth, challenge, fields, advance, replay } = setup(used);
  assert.ok(auth.challenge(origin).nonce);
  const message = createSiweMessage(fields), signature = await account.signMessage({ message });
  advance(1000);
  await auth.verify(origin, challenge.cookie, message, signature);
  assert.equal(used.size, 1);
  assert.equal(used.has(challenge.nonce), true);
  assert.equal(replay.cutoff, -Infinity);
});
test("eviction rejects replay and old outstanding challenges, but fresh nonces remain usable", async () => {
  const used = new Map<string, number>();
  const { auth, challenge, fields, advance, replay } = setup(used);
  const message = createSiweMessage(fields), signature = await account.signMessage({ message });
  await auth.verify(origin, challenge.cookie, message, signature);
  for (let i = 0; i < 9999; i++) used.set(`other-${i}`, Date.parse(challenge.expirationTime));
  const old = auth.challenge(origin);
  const oldMessage = createSiweMessage({ ...fields, nonce: old.nonce });
  advance(1);
  const next = auth.challenge(origin);
  const nextMessage = createSiweMessage({ ...fields, nonce: next.nonce, issuedAt: new Date(next.issuedAt), expirationTime: new Date(next.expirationTime) });
  await auth.verify(origin, next.cookie, nextMessage, await account.signMessage({ message: nextMessage }));
  assert.equal(used.size, 10_000);
  assert.equal(used.has(challenge.nonce), false);
  assert.equal(replay.cutoff, fields.issuedAt.getTime());
  await assert.rejects(auth.verify(origin, challenge.cookie, message, signature), /INVALID_NONCE/);
  await assert.rejects(auth.verify(origin, old.cookie, oldMessage, await account.signMessage({ message: oldMessage })), /INVALID_NONCE/);
  const second = createAuth({ secret: () => secret, replay, now: () => fields.issuedAt.getTime() + 1 });
  await assert.rejects(second.verify(origin, challenge.cookie, message, signature), /INVALID_NONCE/);
  advance(-1);
  const fresh = auth.challenge(origin);
  assert.ok(Date.parse(fresh.issuedAt) > replay.cutoff);
  const freshMessage = createSiweMessage({ ...fields, nonce: fresh.nonce, issuedAt: new Date(fresh.issuedAt), expirationTime: new Date(fresh.expirationTime) });
  await auth.verify(origin, fresh.cookie, freshMessage, await account.signMessage({ message: freshMessage }));
  assert.equal(used.size, 10_000);
});
test("a cutoff raised while the signature verifier awaits is checked again", async () => {
  const { challenge, fields, replay } = setup();
  const auth = createAuth({ secret: () => secret, replay, now: () => fields.issuedAt.getTime(), verify: async () => {
    replay.cutoff = fields.issuedAt.getTime();
    return true;
  } });
  const message = createSiweMessage(fields);
  await assert.rejects(auth.verify(origin, challenge.cookie, message, await account.signMessage({ message })), /INVALID_NONCE/);
  assert.equal(replay.used.size, 0);
});
test("gateway exposes only the dashboard reads and scan, never arbitrary wallet paths", () => {
  assert.deepEqual([...ME_PATHS.keys()], ["bag", "rewards", "stake", "standing", "guard", "trials/record", "trials/ballot", "scan", "read"]);
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
