import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { useSession } = await import(new URL("./use-session.ts", import.meta.url).href) as typeof import("./use-session");

function Session() {
  const session = useSession();
  return createElement("output", null, session.isPending ? "loading" : session.data ?? "example");
}

for (const state of ["empty", "signed-in", "signed-out", "error"]) {
  test(`session renders the same loading snapshot with ${state} cache before mount`, (t) => {
    const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("must not fetch before mount"); });
    const client = new QueryClient();
    if (state === "signed-in") client.setQueryData(["me", "session"], "0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a");
    if (state === "signed-out") client.setQueryData(["me", "session"], null);
    if (state === "error") client.getQueryCache().build(client, { queryKey: ["me", "session"] }).setState({ status: "error", error: new Error("unavailable") });
    assert.equal(renderToString(createElement(QueryClientProvider, { client }, createElement(Session))), "<output>loading</output>");
    assert.equal(fetch.mock.callCount(), 0);
    client.clear();
  });
}
