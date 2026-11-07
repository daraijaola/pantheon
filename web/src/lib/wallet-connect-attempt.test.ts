import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { PairingProvider, WalletPhase } from "./wallet-connect-attempt";
const { walletAttempt } = await import(new URL("./wallet-connect-attempt.ts", import.meta.url).href) as typeof import("./wallet-connect-attempt");

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function setup(waitMs = 10) {
  const init = deferred<PairingProvider>();
  const pair = deferred<void>();
  const events = new EventEmitter();
  const relay = new EventEmitter();
  const phases: WalletPhase[] = [];
  let cleaned = 0;
  const expired: number[] = [];
  const provider: PairingProvider = Object.assign(events, {
    modal: { close: () => pair.reject(new Error("Connection request reset")) },
    signer: {
      cleanupPendingPairings: async (opts: { deletePairings: boolean }) => { assert.equal(opts.deletePairings, true); cleaned++; },
      client: { proposal: { getAll: () => [{ id: 123 }] }, core: { expirer: { set: (id: number) => { expired.push(id); } }, relayer: relay } },
    },
  });
  const attempt = walletAttempt({ init: () => init.promise, pair: () => pair.promise, disconnect: async () => {}, update: p => phases.push(p), waitMs });
  const empty = () => { assert.equal(events.listenerCount("display_uri"), 0); assert.equal(events.listenerCount("error"), 0); assert.equal(relay.listenerCount("relayer_error"), 0); };
  return { init, pair, provider, phases, attempt, events, relay, empty, expired, get cleaned() { return cleaned; } };
}

test("initialization does not consume pairing budget; slow pairing expires proposals and cleans listeners", async () => {
  const s = setup();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(s.phases, ["initializing"]);
  s.init.resolve(s.provider);
  await new Promise(resolve => setTimeout(resolve, 25));
  await s.attempt.done;
  assert.equal(s.phases.at(-1), "slow");
  assert.equal(s.cleaned, 1);
  assert.deepEqual(s.expired, [123]);
  s.empty();
});

test("URI stops watchdog; success removes listeners without disconnecting", async () => {
  const s = setup(); s.init.resolve(s.provider); await tick();
  s.events.emit("display_uri", "wc:fresh");
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(s.phases.at(-1), "ready");
  s.pair.resolve(); await s.attempt.done;
  assert.equal(s.phases.at(-1), "connected");
  await s.attempt.cancel(); assert.equal(s.cleaned, 0); s.empty();
});

for (const mode of ["cancel", "rejected", "relay", "provider", "reset", "init"] as const) {
  test(`${mode} removes all listeners and cannot later time out`, async () => {
    const s = setup();
    if (mode === "init") s.init.reject(new Error("initialization failed"));
    else {
      s.init.resolve(s.provider); await tick();
      if (mode === "cancel") await s.attempt.cancel();
      if (mode === "rejected") s.pair.reject(new Error("User rejected request"));
      if (mode === "reset") s.pair.reject(new Error("WebSocket connection reset by peer"));
      if (mode === "relay") s.relay.emit("relayer_error", new Error("transport failed"));
      if (mode === "provider") s.events.emit("error", new Error("transport failed"));
    }
    await s.attempt.done; await tick();
    const expected = mode === "cancel" || mode === "rejected" ? "cancelled" : mode === "relay" ? "relay-failed" : mode === "init" ? "init-failed" : "failed";
    assert.equal(s.phases.at(-1), expected);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(s.phases.at(-1), expected); s.empty();
  });
}

test("cancel during initialization never pairs and cleans a late provider", async () => {
  const s = setup();
  // No pairing was started, so closing the mock modal must not reject an unobserved promise.
  s.provider.modal = { close() {} };
  const cancelled = s.attempt.cancel(); s.init.resolve(s.provider);
  await cancelled; await s.attempt.done; await tick();
  assert.equal(s.phases.includes("pairing"), false);
  assert.equal(s.cleaned, 1); s.empty();
});

test("cancel disconnects a session that arrives while the pairing is settling", async () => {
  const events = new EventEmitter();
  const pairing = deferred<void>();
  let disconnected = false;
  const provider: PairingProvider = Object.assign(events, {
    session: undefined as unknown,
    modal: { close() { provider.session = {}; pairing.resolve(); } },
    signer: { cleanupPendingPairings: async () => {}, client: { proposal: { getAll: () => [] }, core: { expirer: { set() {} }, relayer: new EventEmitter() } } },
  });
  const attempt = walletAttempt({ init: async () => provider, pair: () => pairing.promise, disconnect: async () => { disconnected = true; }, update() {} });
  await tick(); await attempt.cancel(); await attempt.done;
  assert.equal(disconnected, true);
});

test("cancel during a stalled initialization settles immediately", async () => {
  const s = setup();
  s.provider.modal = { close() {} };
  await s.attempt.cancel();
  assert.deepEqual(s.phases, ["initializing", "cancelled"]);
  s.init.resolve(s.provider);
  await s.attempt.done; await tick();
  assert.equal(s.phases.includes("pairing"), false);
  assert.equal(s.cleaned, 1); s.empty();
});
