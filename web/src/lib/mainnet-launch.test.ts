import assert from "node:assert/strict";
import { test } from "node:test";

const { mainnetGate, backendRewrites } = await import(new URL("./mainnet-launch.ts", import.meta.url).href) as typeof import("./mainnet-launch");

test("mainnet defers every backend page, including deep public Passport links", () => {
  for (const path of ["/upload", "/space", "/passport", "/passport/get", "/passport/me", "/passport/0x123", "/trials", "/trials/vote", "/delphi", "/delphi/chat", "/delphi/dispute", "/delphi/kalos", "/delphi/0x123"]) {
    assert.equal(mainnetGate(path, "GET", false), "page", path);
    assert.equal(mainnetGate(path, "HEAD", false), "page", path);
    assert.equal(mainnetGate(path, "POST", false), "unavailable", path);
    assert.equal(mainnetGate(path, "GET", true), null, path);
  }
});
test("staking is available on mainnet without opening staking or Passport APIs", () => {
  for (const path of ["/stake", "/stake/"]) for (const method of ["GET", "HEAD"]) assert.equal(mainnetGate(path, method, false), null);
  for (const path of ["/api/stake", "/api/passport/multiplier", "/api/delphi/feed"]) assert.equal(mainnetGate(path, "GET", false), "unavailable");
});
test("mainnet blocks APIs and Passport images without blocking wallet authentication", () => {
  for (const path of ["/api/me/read", "/api/passport/me", "/api/passport/0x123", "/api/trials/current", "/api/stats", "/api/basket", "/api/receipts", "/api/ask-delphi", "/api/health", "/api/unknown", "/passport/0x123/opengraph-image", "/passport/0x123/opengraph-image.png"]) {
    for (const method of ["GET", "POST", "HEAD", "OPTIONS"]) assert.equal(mainnetGate(path, method, false), "unavailable", `${method} ${path}`);
  }
  for (const path of ["/", "/get", "/terms", "/security", "/coming-soon", "/upload/delphi.png", "/upload/caspian-tile.webp", "/api/auth/nonce", "/api/auth/verify", "/api/auth/me", "/api/auth/logout"]) assert.equal(mainnetGate(path, "GET", false), null, path);
});
test("mainnet has no backend rewrites, even when testnet upstreams are in the environment", () => {
  const env = { PASSPORT_API: "http://testnet.invalid", TRIALS_API: "http://testnet.invalid", INDEXER_API: "http://testnet.invalid" };
  assert.deepEqual(backendRewrites(false, env), []);
  assert.equal(backendRewrites(true, {}).length, 5);
  assert.equal(backendRewrites(true, {}).at(-1)?.destination, "http://127.0.0.1:8789/receipts");
  assert.equal(backendRewrites(true, env)[0].destination, "http://testnet.invalid/passport/:path*");
  assert.equal(mainnetGate("/api/me/read", "POST", true), null);
});
