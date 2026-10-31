// The small HTTP clients behind the safety checks, fed real answers (recorded 2026-10-31) or their
// exact shapes, and the record/replay tape the other safety tests run on.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ContractsApi, ExplorerApi } from "../src/conduit.ts";
import { HttpError } from "../src/http.ts";
import { KALOS_CONTRACTS, KalosApi } from "../src/kalos.ts";
import { BatchRpc } from "../src/rpc.ts";
import { recordingFetch, replayFetch, emptyTape, type Tape } from "../src/tape.ts";

const load = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/safety/${name}.json`, import.meta.url), "utf8")) as Tape;
const quiet = async () => {};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A fake server: each URL answers from a list, in turn. */
function server(routes: Record<string, unknown[]>) {
  const seen: Array<{ url: string; ua: string | null }> = [];
  const fetch = async (url: string, init?: RequestInit) => {
    seen.push({ url, ua: new Headers(init?.headers).get("user-agent") });
    const key = Object.keys(routes).find((k) => url.endsWith(k));
    if (!key || !routes[key]!.length) throw new Error(`unexpected ${url}`);
    const next = routes[key]!.shift();
    return next instanceof Response ? next : json(next);
  };
  return { fetch, seen };
}

describe("KalosApi", () => {
  const recorded = load("kalos").http.find((h) => h.url.endsWith("/v2/dex/tokens"))!.response as { rows: Array<{ symbol: string }> };

  it("reads the token list, waiting out a 'refreshing' answer, and sends a User-Agent", async () => {
    const refreshing = { error: "unavailable", message: "This data is refreshing. Try again in a moment.", detail: { reason: "refreshing" } };
    const s = server({ "/v2/dex/tokens": [refreshing, recorded] });
    const tokens = await new KalosApi({ fetch: s.fetch, sleep: quiet }).tokens();
    expect(tokens).toHaveLength(22);
    expect(tokens.filter((t) => t.approved).map((t) => t.symbol)).toEqual(["USDC", "WHYPE", "ELYZ"]);
    expect(tokens.find((t) => t.symbol === "WHYPE")).toMatchObject({ address: KALOS_CONTRACTS.whype, wrappedNative: true });
    expect(s.seen).toHaveLength(2);
    expect(s.seen[0]!.ua).toMatch(/^delphi/);
  });

  it("follows the `next` cursor", async () => {
    const rows = recorded.rows;
    const s = server({ "/v2/dex/tokens": [{ rows: rows.slice(0, 10), next: "0xabc" }], "/v2/dex/tokens?cursor=0xabc": [{ rows: rows.slice(10), next: null }] });
    expect(await new KalosApi({ fetch: s.fetch, sleep: quiet }).tokens()).toHaveLength(22);
  });

  it("reads Kalos's contract addresses", async () => {
    const s = server({ "/v2/dex/config": [{ enabled: true, chainId: 99801, contracts: { ...KALOS_CONTRACTS, multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11" } }] });
    expect(await new KalosApi({ fetch: s.fetch, sleep: quiet }).config()).toEqual({ chainId: 99801, contracts: KALOS_CONTRACTS });
  });

  it("refuses an answer that is not a token list", async () => {
    const s = server({ "/v2/dex/tokens": [{ rows: [{ address: "nope", symbol: "X" }] }] });
    await expect(new KalosApi({ fetch: s.fetch, sleep: quiet }).tokens()).rejects.toBeInstanceOf(HttpError);
  });
});

describe("ContractsApi (Conduit's Sourcify)", () => {
  const usdc = load("usdc").http.find((h) => h.url.includes("/v2/contract/99801/0x7D29d8047B905000459c0E80c34a26CeedcB47b2"))!;

  it("reads a verified contract: match, name, compiler, ABI and the bytecode it was matched against", async () => {
    const s = server({ [usdc.url.slice(usdc.url.indexOf("/v2/"))]: [usdc.response] });
    const v = await new ContractsApi({ fetch: s.fetch, sleep: quiet }).verification(99801, "0x7D29d8047B905000459c0E80c34a26CeedcB47b2");
    expect(v).toMatchObject({ matched: true, runtimeMatch: "exact_match", name: "ClonableBeaconProxy", compiler: "0.8.16+commit.07a7930e", proxy: { type: "EIP1967Proxy" } });
    expect(v.abi.length).toBeGreaterThan(0);
    expect(v.onchainBytecode).toMatch(/^0x6080/);
  });

  it("reads a 404 as not verified", async () => {
    const s = server({ "?fields=abi,compilation.name,compilation.compilerVersion,compilation.language,runtimeBytecode.onchainBytecode,proxyResolution": [json({ match: null, creationMatch: null, runtimeMatch: null, chainId: "99801", address: "0x8a2201953AF29e8BE7700bcB53dA3ce5caD18726" }, 404)] });
    const v = await new ContractsApi({ fetch: s.fetch, sleep: quiet }).verification(99801, "0x8a2201953AF29e8BE7700bcB53dA3ce5caD18726");
    expect(v).toMatchObject({ matched: false, abi: [], name: null });
  });
});

describe("ExplorerApi", () => {
  it("names the deploying transaction of a wallet's deploy, and only the block of a factory's", async () => {
    const kalos = load("kalos").http.find((h) => h.url.includes("/api/contract/creation/"))!.response;
    const nfalc = load("nfalc").http.find((h) => h.url.includes("/api/contract/creation/"))!.response;
    const s = server({ "/api/contract/creation/0x8a2201953AF29e8BE7700bcB53dA3ce5caD18726": [kalos], "/api/contract/creation/0xCF52DE746CA0b5b8fCC2cC674A69C9B8B8768779": [nfalc] });
    const api = new ExplorerApi({ fetch: s.fetch, sleep: quiet });
    expect(await api.creation("0x8a2201953AF29e8BE7700bcB53dA3ce5caD18726")).toEqual({ block: 8_128_219n, time: 1_791_846_760, tx: "0x934d7d8a60b378cfd569cfb8240f0d45364d7f358dd7195ec3d02ea15840bd3e", sender: "0x9332e35e87eAc40a0810813a7a12C458E8043184" });
    expect(await api.creation("0xCF52DE746CA0b5b8fCC2cC674A69C9B8B8768779")).toEqual({ block: 10_460_864n, time: 1_792_226_512, tx: null, sender: null });
  });
});

describe("tape", () => {
  it("records JSON-RPC calls one by one, so a replay does not care how they were batched", async () => {
    const node = async (_url: string, init?: RequestInit) => {
      const calls = JSON.parse(String(init!.body)) as Array<{ id: number; params: number[] }>;
      return json(calls.map((c) => ({ jsonrpc: "2.0", id: c.id, result: c.params[0]! * 2 })));
    };
    const tape = emptyTape();
    const live = new BatchRpc("http://node.test", { fetch: recordingFetch(node, tape), gapMs: 0, sleep: quiet, batchSize: 3 });
    await live.many([1, 2, 3, 4].map((n) => ({ method: "eth_getBalance", params: [n] })));
    expect(tape.rpc).toHaveLength(4);
    const replayed = new BatchRpc("http://node.test", { fetch: replayFetch(tape), gapMs: 0, sleep: quiet, retries: 0 });
    expect((await replayed.many([4, 1].map((n) => ({ method: "eth_getBalance", params: [n] })))).map((a) => a.result)).toEqual([8, 2]);
    await expect(replayed.call("eth_getBalance", [9])).rejects.toThrow(/not on the tape/);
  });

  it("records other HTTP answers by method, URL and body", async () => {
    const tape = emptyTape();
    const f = recordingFetch(async () => json({ ok: 1 }), tape);
    await f("https://x.test/a", { method: "POST", body: '{"q":1}' });
    expect(tape.http).toEqual([{ method: "POST", url: "https://x.test/a", body: '{"q":1}', status: 200, response: { ok: 1 } }]);
    expect(await (await replayFetch(tape)("https://x.test/a", { method: "POST", body: '{"q":1}' })).json()).toEqual({ ok: 1 });
    await expect(replayFetch(tape)("https://x.test/a")).rejects.toThrow(/not on the tape/);
  });
});
