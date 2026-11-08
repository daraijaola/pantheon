import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
const { afterPaint } = await import(new URL("./after-paint.ts", import.meta.url).href) as typeof import("./after-paint");

function clock(t: TestContext, idle = true) {
  let id = 0;
  const frames = new Map<number, () => void>(), jobs = new Map<number, () => void>();
  let visible: (value: boolean) => void = () => {};
  const set = (name: string, value: unknown) => {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    t.after(() => { if (original) Object.defineProperty(globalThis, name, original); else Reflect.deleteProperty(globalThis, name); });
  };
  const queue = (fn: () => void) => { jobs.set(++id, fn); return id; };
  set("window", { requestIdleCallback: idle ? queue : undefined, cancelIdleCallback: (n: number) => jobs.delete(n), setTimeout: queue, clearTimeout: (n: number) => jobs.delete(n) });
  set("requestAnimationFrame", (fn: () => void) => { frames.set(++id, fn); return id; });
  set("cancelAnimationFrame", (n: number) => frames.delete(n));
  set("IntersectionObserver", class {
    constructor(fn: (entries: { isIntersecting: boolean }[]) => void) { visible = value => fn([{ isIntersecting: value }]); }
    observe() {}
    disconnect() {}
  });
  const flush = (map: Map<number, () => void>) => { const batch = [...map.values()]; map.clear(); batch.forEach(fn => fn()); };
  return { frame: () => flush(frames), idle: () => flush(jobs), visible: (value: boolean) => visible(value) };
}

for (const idle of [true, false]) test(`Setup follows two paint opportunities and ${idle ? "idle" : "timer fallback"}`, t => {
  const c = clock(t, idle);
  let started = 0, stopped = 0;
  const cancel = afterPaint(() => { started++; return () => { stopped++; }; });
  assert.equal(started, 0);
  c.frame(); assert.equal(started, 0);
  c.frame(); assert.equal(started, 0);
  c.idle(); assert.equal(started, 1);
  cancel(); assert.equal(stopped, 1);
});

for (const stage of [0, 1, 2]) test(`Unmount cancels pending setup at stage ${stage}`, t => {
  const c = clock(t);
  let started = false;
  const cancel = afterPaint(() => { started = true; });
  for (let i = 0; i < stage; i++) c.frame();
  cancel(); c.frame(); c.frame(); c.idle();
  assert.equal(started, false);
});

test("Hidden orbs do not initialize until visible", t => {
  const c = clock(t);
  let started = 0;
  const cancel = afterPaint(() => { started++; }, {} as Element);
  c.visible(false); c.frame(); c.frame(); c.idle(); assert.equal(started, 0);
  c.visible(true); c.frame(); c.frame(); c.idle(); assert.equal(started, 1);
  cancel();
});

test("A late visibility notification cannot initialize an unmounted orb", t => {
  const c = clock(t);
  let started = false;
  const cancel = afterPaint(() => { started = true; }, {} as Element);
  cancel(); c.visible(true); c.frame(); c.frame(); c.idle();
  assert.equal(started, false);
});

test("Setup errors are not swallowed", t => {
  const c = clock(t);
  const cancel = afterPaint(() => { throw new Error("WebGL unavailable"); });
  c.frame(); c.frame();
  assert.throws(c.idle, /WebGL unavailable/);
  cancel();
});
