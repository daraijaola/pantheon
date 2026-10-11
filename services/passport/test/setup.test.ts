import { describe, expect, it } from "vitest";

describe("test network guard", () => {
  it("blocks live hosts", async () => {
    await expect(fetch("https://api.hyperliquid.xyz/info", { method: "POST" })).rejects.toThrow(/blocked in tests/);
    await expect(fetch(new URL("https://rpc.hyperliquid.xyz/evm"))).rejects.toThrow(/blocked in tests/);
  });

  it("lets loopback through", async () => {
    // Nothing listens on port 9; the guard must pass the call on, so the error is a connection failure.
    await expect(fetch("http://127.0.0.1:9/")).rejects.not.toThrow(/blocked in tests/);
  });
});
