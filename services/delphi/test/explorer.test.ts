import { describe, expect, it } from "vitest";
import { Explorer, ExplorerBudgetError, ExplorerError } from "../src/explorer.ts";

const W = "0x797dd8b5da7a10bf6e6534d549a9c256f8f4f0ab";
const FAUCET = "0xf272Cc84C3BA9f1B498adE29aaeED1e7D2D9f3fD";
const VAULT = "0x2B738A9A69b7a45C9dA6B519f6bE6efBfb912aec";
const h = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

// Shapes copied from real Blockscout v2 answers on the Elysium explorer (2026-10-14), trimmed.
const txPage = {
  items: [
    { hash: h(1), from: { hash: FAUCET }, value: "100000000000000000", status: "ok", timestamp: "2026-10-10T07:17:16.000000Z", method: null },
    { hash: h(2), from: { hash: FAUCET }, value: "0", status: "ok", timestamp: "2026-10-10T08:00:00.000000Z" },
    { hash: h(3), from: { hash: FAUCET }, value: "5", status: "error", timestamp: "2026-10-10T09:00:00.000000Z" },
  ],
  next_page_params: null,
};
const internalPage = {
  items: [{ transaction_hash: h(4), from: { hash: VAULT }, value: "39225443390690414", success: true, timestamp: "2026-10-09T03:33:57.000000Z", type: "call" }],
  next_page_params: null,
};

function mock(routes: Record<string, () => Response>) {
  const calls: string[] = [];
  const fetch = async (url: string) => {
    calls.push(url);
    const hit = Object.entries(routes).find(([k]) => url.includes(k));
    if (!hit) throw new Error(`unexpected ${url}`);
    return hit[1]();
  };
  return { calls, fetch };
}
const json = (body: unknown, status = 200, remaining = "1990") =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-ratelimit-remaining": remaining } });
const noSleep = async () => {};

describe("Explorer.fundings", () => {
  it("keeps successful, non-zero payments, oldest first, asking for the earliest transactions", async () => {
    const m = mock({ "/transactions?": () => json(txPage), "/internal-transactions?": () => json(internalPage) });
    const ex = new Explorer("https://x.test/api/v2/", { fetch: m.fetch, sleep: noSleep });
    const got = await ex.fundings(W);
    expect(got.map((f) => [f.via, f.from, f.value, f.tx])).toEqual([
      ["internal", VAULT, 39_225_443_390_690_414n, h(4)],
      ["tx", FAUCET, 100_000_000_000_000_000n, h(1)],
    ]);
    expect(got[0]!.wallet).toBe("0x797DD8B5dA7a10BF6e6534D549A9c256F8F4f0AB");
    expect(m.calls.find((u) => u.includes("/transactions?"))).toBe(
      "https://x.test/api/v2/addresses/0x797DD8B5dA7a10BF6e6534D549A9c256F8F4f0AB/transactions?filter=to&sort=block_number&order=asc",
    );
    expect(ex.remaining).toBe(1990);
  });

  it("rejects an answer that does not look like the explorer's", async () => {
    const bad = { items: [{ ...txPage.items[0], from: { hash: "not-an-address" } }] };
    const m = mock({ "/transactions?": () => json(bad), "/internal-transactions?": () => json(internalPage) });
    await expect(new Explorer("https://x.test", { fetch: m.fetch, sleep: noSleep }).fundings(W)).rejects.toThrow(ExplorerError);
  });
});

describe("Explorer limits", () => {
  it("stops on 429 instead of hammering the explorer", async () => {
    const m = mock({ "/counters": () => json({}, 429) });
    await expect(new Explorer("https://x.test", { fetch: m.fetch, sleep: noSleep }).txCount(W)).rejects.toThrow(ExplorerBudgetError);
    expect(m.calls).toHaveLength(1);
  });

  it("stops before the allowance runs out, without another request", async () => {
    const m = mock({ "/counters": () => json({ transactions_count: "64" }, 200, "100") });
    const ex = new Explorer("https://x.test", { fetch: m.fetch, sleep: noSleep, reserve: 100 });
    expect(await ex.txCount(W)).toBe(64);
    await expect(ex.txCount(W)).rejects.toThrow(ExplorerBudgetError);
    expect(m.calls).toHaveLength(1);
  });

  it("retries a server error, then succeeds", async () => {
    let n = 0;
    const m = mock({ "/counters": () => (++n < 3 ? json({}, 502) : json({ transactions_count: "164840" })) });
    expect(await new Explorer("https://x.test", { fetch: m.fetch, sleep: noSleep }).txCount(FAUCET)).toBe(164_840);
    expect(n).toBe(3);
  });

  it("gives up on a client error with a clear message", async () => {
    const m = mock({ "/counters": () => json({ errors: [] }, 422) });
    await expect(new Explorer("https://x.test", { fetch: m.fetch, sleep: noSleep }).txCount(W)).rejects.toThrow(/explorer 422/);
  });
});
