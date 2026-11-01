// Checks for the chat's server side (delphi-chat.ts). From web/: node --test src/lib/delphi-chat.test.ts
// (Node 22.18 or later runs TypeScript as it is.)

import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { test } from "node:test";

// delphi-chat.ts imports "@/lib/delphi", which only Next resolves. These checks need only its
// headline(), so a stand-in takes its place.
type Resolve = (specifier: string, context: object, next: (specifier: string, context: object) => object) => object;
const { registerHooks } = nodeModule as unknown as { registerHooks(hooks: { resolve: Resolve }): void };
registerHooks({
  resolve: (specifier, context, next) =>
    specifier === "@/lib/delphi" ? { url: "data:text/javascript,export const headline = (h) => h;", shortCircuit: true } : next(specifier, context),
});
const chat = (await import(new URL("./delphi-chat.ts", import.meta.url).href)) as typeof import("./delphi-chat");

const ask = (content: string) => ({ role: "user", content });

test("only JSON from this site is read", () => {
  const json = { "content-type": "application/json" };
  assert.equal(chat.refuse(new Headers(json)), null);
  assert.equal(chat.refuse(new Headers({ "content-type": "Application/JSON; charset=utf-8", "sec-fetch-site": "same-origin" })), null);
  assert.equal(chat.refuse(new Headers({ ...json, "sec-fetch-site": "none" })), null);
  assert.equal(chat.refuse(new Headers({ "content-type": "text/plain" }))?.status, 415);
  assert.equal(chat.refuse(new Headers())?.status, 415);
  assert.equal(chat.refuse(new Headers({ ...json, "sec-fetch-site": "cross-site" }))?.status, 403);
  assert.equal(chat.refuse(new Headers({ ...json, "sec-fetch-site": "same-site" }))?.status, 403);
});

test("a visitor can ask 6 questions a minute and 30 an hour", () => {
  const t0 = Date.UTC(2026, 10, 1);
  for (let i = 0; i < 6; i++) assert.equal(chat.waitFor("a", t0 + i), 0);
  const minute = chat.waitFor("a", t0 + 10);
  assert.ok(minute > 0 && minute <= 60, `waits ${minute}s`);
  assert.equal(chat.waitFor("b", t0 + 10), 0, "someone else still can");
  assert.equal(chat.waitFor("a", t0 + 60_000), 0, "a minute on, they can again");

  // Two a minute stays under the minute's limit, but uses up the hour's at 30.
  for (let i = 0; i < 30; i++) assert.equal(chat.waitFor("c", t0 + i * 30_000), 0);
  const hour = chat.waitFor("c", t0 + 30 * 30_000);
  assert.ok(hour > 60, `waits ${hour}s`);
  assert.equal(chat.waitFor("c", t0 + 3_600_000), 0, "an hour after the first, they can again");
});

test("the newest messages are kept, up to 12 and 8,000 characters", () => {
  const long = Array.from({ length: 6 }, (_, i) => ask(String(i).repeat(2000)));
  assert.deepEqual(chat.parseMessages({ messages: long })?.map((m) => m.content[0]), ["2", "3", "4", "5"]);
  assert.equal(chat.parseMessages({ messages: Array.from({ length: 20 }, (_, i) => ask(`q${i}`)) })?.length, 12);
  assert.equal(chat.parseMessages({ messages: [ask("x".repeat(9000))] })?.[0].content.length, 2000);
  assert.equal(chat.parseMessages({ messages: Array.from({ length: 41 }, () => ask("q")) }), null);
  assert.equal(chat.parseMessages({ messages: [ask("q"), { role: "assistant", content: "a" }] }), null);
});
