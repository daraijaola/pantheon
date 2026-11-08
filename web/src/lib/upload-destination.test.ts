import { test } from "node:test";
import assert from "node:assert/strict";
const { uploadDestination } = await import(new URL("./upload-destination.ts", import.meta.url).href) as typeof import("./upload-destination");

for (const state of ["returning", "empty", "disconnected", "error"]) {
  test(`upload destination: ${state}`, async () => {
    const fetcher = (async (url: string) => {
      if (state === "error") throw new Error("offline");
      return Response.json(url.endsWith("/me") ? { wallet: state === "disconnected" ? null : "wallet" } : { read: state === "returning" ? { readAt: 1 } : null });
    }) as typeof fetch;
    assert.equal(await uploadDestination(fetcher), state === "returning" ? "/space" : "/upload");
  });
}
