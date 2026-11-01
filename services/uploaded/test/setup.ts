// Tests never call live APIs (spec §13 P1): any fetch to a non-loopback host fails the test.
// Mocks (e.g. test/mockHl.ts) must serve from 127.0.0.1/localhost or stub fetch themselves.
const realFetch = globalThis.fetch;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (!LOOPBACK.has(url.hostname)) {
    return Promise.reject(new Error(`live network call blocked in tests: ${url.origin}`));
  }
  return realFetch(input, init);
};
