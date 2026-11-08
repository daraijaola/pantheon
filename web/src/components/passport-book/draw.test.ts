import { test } from "node:test";
import assert from "node:assert/strict";
const { makeProgram } = await import(new URL("./draw.ts", import.meta.url).href) as typeof import("./draw");

function canvas(available = true, compiled = true) {
  const calls: string[] = [];
  const gl = new Proxy({}, { get: (_, property) => {
    const key = String(property);
    if (key === key.toUpperCase()) return 1;
    return () => {
      calls.push(key);
      if (key.startsWith("create")) return {};
      if (key === "getShaderParameter" || key === "getProgramParameter") return compiled;
      return null;
    };
  } }) as WebGLRenderingContext;
  const element = {
    getContext: () => available ? gl : null,
    addEventListener: () => { calls.push("listen"); },
    removeEventListener: () => { calls.push("unlisten"); },
  } as unknown as HTMLCanvasElement;
  return { element, calls };
}

test("Glass cleanup deletes its GPU resources without synchronously losing the context", () => {
  const { element, calls } = canvas();
  const program = makeProgram(element, "precision highp float;", []);
  assert.ok(program);
  program.texture(0); program.texture(1);
  calls.length = 0;
  program.destroy();
  assert.deepEqual(calls, ["unlisten", "useProgram", "deleteTexture", "deleteTexture", "deleteBuffer", "deleteProgram", "deleteShader", "deleteShader"]);
  calls.length = 0;
  program.destroy();
  assert.deepEqual(calls, []);
});

test("Missing WebGL retains the no-glass fallback", () => {
  const { element, calls } = canvas(false);
  assert.equal(makeProgram(element, "", []), null);
  assert.deepEqual(calls, []);
});

test("Shader errors retain the no-glass fallback", t => {
  const warning = t.mock.method(console, "warn", () => {});
  const { element, calls } = canvas(true, false);
  assert.equal(makeProgram(element, "", []), null);
  assert.equal(calls.includes("listen"), false);
  assert.equal(warning.mock.callCount(), 3);
});
