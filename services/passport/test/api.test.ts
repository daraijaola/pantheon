import { recoverTypedDataAddress, type Address } from "viem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { passportDomain, passportTypes, toSignable } from "../src/eip712.ts";
import { hlKeyOf } from "../src/link.ts";
import { AGENT, ELY, ELY2, harness, HL_EMPTY, HL_T1, HL_T2, key } from "./harness.ts";

let h: Awaited<ReturnType<typeof harness>>;
beforeEach(async () => {
  h = await harness();
});
afterEach(() => h.close());

const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
  h.app.inject({ method: "POST", url, payload: payload as object, headers });
const get = (url: string, headers: Record<string, string> = {}) => h.app.inject({ method: "GET", url, headers });

async function link(hl = HL_T2, ely = ELY, relay = false) {
  const c = await post("/passport/challenge", { hyperliquidAccount: hl.address, elysiumAccount: ely.address });
  expect(c.statusCode).toBe(200);
  const { nonce, typedData } = c.json();
  const td = toSignable(typedData);
  const hlSignature = await hl.signTypedData(td);
  const elysiumSignature = hl.address === ely.address ? undefined : await ely.signTypedData(td);
  return post("/passport/verify", { nonce, hlSignature, elysiumSignature, relay });
}

/** No HL address (either case) and no score or balance may ever leave the API (§8). */
function assertPrivate(body: string, hl: Address) {
  expect(body.toLowerCase()).not.toContain(hl.toLowerCase().slice(2));
  expect(body).not.toMatch(/score|balance|staked|liquid|volume/i);
}

describe("POST /passport/challenge", () => {
  it("returns a nonce and the Link typed data", async () => {
    const r = await post("/passport/challenge", { hyperliquidAccount: HL_T2.address, elysiumAccount: ELY.address });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ nonce: expect.stringMatching(/^0x[0-9a-f]{64}$/), typedData: { primaryType: "Link" } });
  });

  it("turns away an API wallet with 403 and names the main account", async () => {
    const r = await post("/passport/challenge", { hyperliquidAccount: AGENT.address, elysiumAccount: ELY.address });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ error: "AGENT_WALLET", detail: `sign with your main account ${HL_T2.address.toLowerCase()}` });
  });

  it.each([
    [{ hyperliquidAccount: "0x12", elysiumAccount: ELY.address }, 400, "INVALID_ADDRESS"],
    [{ hyperliquidAccount: HL_T2.address }, 400, "BAD_REQUEST"],
    [{ hyperliquidAccount: 7, elysiumAccount: ELY.address }, 400, "BAD_REQUEST"],
  ])("refuses a bad body %#", async (payload, status, error) => {
    const r = await post("/passport/challenge", payload);
    expect(r.statusCode).toBe(status);
    expect(r.json().error).toBe(error);
  });

  it("answers malformed JSON with 400", async () => {
    const r = await h.app.inject({ method: "POST", url: "/passport/challenge", payload: "{nope", headers: { "content-type": "application/json" } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe("BAD_REQUEST");
  });

  it("limits each IP to 10 per minute (behind Caddy, by X-Forwarded-For)", async () => {
    const body = { hyperliquidAccount: HL_T2.address, elysiumAccount: ELY.address };
    for (let i = 0; i < 10; i++) expect((await post("/passport/challenge", body, { "x-forwarded-for": "203.0.113.7" })).statusCode).toBe(200);
    const r = await post("/passport/challenge", body, { "x-forwarded-for": "203.0.113.7" });
    expect(r.statusCode).toBe(429);
    expect(Number(r.headers["retry-after"])).toBeGreaterThan(0);
    expect((await post("/passport/challenge", body, { "x-forwarded-for": "198.51.100.9" })).statusCode).toBe(200);
    h.clock.ms += 60_001;
    expect((await post("/passport/challenge", body, { "x-forwarded-for": "203.0.113.7" })).statusCode).toBe(200);
  });

  it("keeps one IP from spending the HL budget: 2 uncached lookups per minute", async () => {
    const fresh = (i: number) => `0x${(0xa000 + i).toString(16).padStart(40, "0")}`;
    const ask = (i: number, ip = "203.0.113.7") =>
      post("/passport/challenge", { hyperliquidAccount: fresh(i), elysiumAccount: ELY.address }, { "x-forwarded-for": ip });
    const before = h.service.deps.hl.limiter.available();
    const replies = [];
    for (let i = 0; i < 10; i++) replies.push(await ask(i));
    expect(replies.map((r) => r.statusCode)).toEqual([200, 200, 429, 429, 429, 429, 429, 429, 429, 429]);
    expect(replies[2]!.json()).toEqual({ error: "RATE_LIMITED", detail: "busy checking accounts, retry shortly" });
    expect(Number(replies[2]!.headers["retry-after"])).toBeGreaterThan(0);
    expect(before - h.service.deps.hl.limiter.available()).toBe(2 * 80); // not 10 × 80 = the whole budget
    expect((await ask(0, "203.0.113.8")).statusCode).toBe(200); // cached: costs no HL weight
  });

  it("caps uncached lookups at 5 per minute across all IPs (half the HL budget)", async () => {
    const codes = [];
    for (let i = 0; i < 7; i++) {
      const r = await post("/passport/challenge", { hyperliquidAccount: `0x${(0xb000 + i).toString(16).padStart(40, "0")}`, elysiumAccount: ELY.address }, { "x-forwarded-for": `198.51.100.${i}` });
      codes.push(r.statusCode);
    }
    expect(codes).toEqual([200, 200, 200, 200, 200, 429, 429]);
    h.clock.ms += 60_001;
    const r = await post("/passport/challenge", { hyperliquidAccount: `0x${(0xb100).toString(16).padStart(40, "0")}`, elysiumAccount: ELY.address }, { "x-forwarded-for": "198.51.100.99" });
    expect(r.statusCode).toBe(200);
  });

  it("re-checks a cached role after 10 minutes", async () => {
    const body = { hyperliquidAccount: HL_T2.address, elysiumAccount: ELY.address };
    await post("/passport/challenge", body);
    const reqs = () => h.hlServer.requests.filter((r) => r.type === "userRole").length;
    const n = reqs();
    await post("/passport/challenge", body);
    expect(reqs()).toBe(n);
    h.clock.ms += 10 * 60_000;
    await post("/passport/challenge", body);
    expect(reqs()).toBe(n + 1);
  });

  it("refuses accounts the registry already binds elsewhere, or that are cooling down", async () => {
    const hlKey = hlKeyOf(`0x${"42".repeat(32)}`, HL_T2.address);
    const nowSec = Math.floor(h.clock.ms / 1000);
    h.registry.apply({ account: ELY2.address, hlKey, tier: 2, stamps: 0, issuedAt: nowSec, expiry: nowSec + 86_400 });
    const taken = await post("/passport/challenge", { hyperliquidAccount: HL_T2.address, elysiumAccount: ELY.address });
    expect([taken.statusCode, taken.json().error]).toEqual([409, "HL_ALREADY_LINKED"]);
    const busy = await post("/passport/challenge", { hyperliquidAccount: HL_T1.address, elysiumAccount: ELY2.address });
    expect([busy.statusCode, busy.json().error]).toEqual([409, "ACCOUNT_ALREADY_LINKED"]);

    h.registry.passports.clear();
    h.registry.holders.clear();
    h.registry.rebind.set(hlKey.toLowerCase(), nowSec + 3_600);
    const cooling = await post("/passport/challenge", { hyperliquidAccount: HL_T2.address, elysiumAccount: ELY.address });
    expect([cooling.statusCode, cooling.json().error, cooling.headers["retry-after"]]).toEqual([409, "REBIND_COOLDOWN", "3600"]);
  });
});

describe("POST /passport/verify", () => {
  it("scores, signs and returns an attestation the attestor really signed", async () => {
    const r = await link();
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b).toMatchObject({ tier: 2, stamps: 189, multiplier: "1.20", stampNames: ["STAKER", "GENESIS", "VETERAN", "TRADER", "HYPURR", "SEASONED"] });
    expect(b.attestation).toMatchObject({ account: ELY.address, tier: 2, stamps: 189, chainId: 99801 });
    expect(b.attestation.expiry - b.attestation.issuedAt).toBe(7 * 86_400);
    const a = b.attestation;
    const signer = await recoverTypedDataAddress({
      domain: passportDomain(h.registry.address),
      types: { Attestation: passportTypes.Attestation },
      primaryType: "Attestation",
      message: { ...a, issuedAt: BigInt(a.issuedAt), expiry: BigInt(a.expiry), deadline: BigInt(a.deadline), chainId: BigInt(a.chainId) },
      signature: b.signature,
    });
    expect(signer).toBe(h.attestor.address);
    assertPrivate(r.body, HL_T2.address);
  });

  it("answers tier 0 with reasons and creates no binding", async () => {
    const r = await link(HL_EMPTY, ELY);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ tier: 0, reasons: ["SCORE_BELOW_10"] });
    expect((await get("/passport/stats")).json().linked).toBe(0);
  });

  it("maps link errors to HTTP codes", async () => {
    const c = (await post("/passport/challenge", { hyperliquidAccount: HL_T2.address, elysiumAccount: ELY.address })).json();
    const td = toSignable(c.typedData);
    const wrong = await post("/passport/verify", { nonce: c.nonce, hlSignature: await key(9).signTypedData(td), elysiumSignature: await ELY.signTypedData(td) });
    expect([wrong.statusCode, wrong.json().error]).toEqual([401, "BAD_HL_SIGNATURE"]);
    const good = { nonce: c.nonce, hlSignature: await HL_T2.signTypedData(td), elysiumSignature: await ELY.signTypedData(td) };
    expect((await post("/passport/verify", good)).statusCode).toBe(200);
    const again = await post("/passport/verify", good);
    expect([again.statusCode, again.json().error]).toEqual([409, "CHALLENGE_USED"]);
    const unknown = await post("/passport/verify", { ...good, nonce: `0x${"ab".repeat(32)}` });
    expect([unknown.statusCode, unknown.json().error]).toEqual([404, "CHALLENGE_NOT_FOUND"]);
  });

  it("allows 5 verifications per hour per account", async () => {
    for (let i = 0; i < 5; i++) {
      h.clock.ms += 1_000;
      h.registry.passports.clear();
      h.registry.holders.clear();
      expect((await link()).statusCode).toBe(200);
    }
    h.clock.ms += 1_000;
    const r = await link();
    expect([r.statusCode, r.json().error]).toEqual([429, "RATE_LIMITED"]);
  });

  it("reports an unreachable Hyperliquid as 503, not a low tier", async () => {
    const c = (await post("/passport/challenge", { hyperliquidAccount: HL_T2.address, elysiumAccount: ELY.address })).json();
    const td = toSignable(c.typedData);
    h.hlServer.failNext(40, { status: 502 });
    const r = await post("/passport/verify", { nonce: c.nonce, hlSignature: await HL_T2.signTypedData(td), elysiumSignature: await ELY.signTypedData(td) });
    expect([r.statusCode, r.json().error]).toEqual([503, "UPSTREAM_UNAVAILABLE"]);
  });

  it("relays when asked and a relayer is configured", async () => {
    await h.close();
    const submitted: unknown[] = [];
    h = await harness({
      relayer: {
        submit: async (a) => (submitted.push(a), `0x${"cd".repeat(32)}`),
        submitMany: async () => [],
        balance: async () => 10n ** 18n,
      },
    });
    const r = await link(HL_T2, ELY, true);
    expect(r.json().txHash).toBe(`0x${"cd".repeat(32)}`);
    expect(submitted).toHaveLength(1);
  });
});

describe("GET /passport/:address", () => {
  it("shows what the registry holds, without the HL address", async () => {
    const v = (await link()).json();
    h.registry.apply(v.attestation); // as if the user submitted it
    const r = await get(`/passport/${ELY.address.toLowerCase()}`);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      address: ELY.address,
      valid: true,
      tier: 2,
      stamps: 189,
      stampNames: ["STAKER", "GENESIS", "VETERAN", "TRADER", "HYPURR", "SEASONED"],
      multiplier: "1.20",
      issuedAt: v.attestation.issuedAt,
      expiry: v.attestation.expiry,
      linkedAt: Math.floor(h.clock.ms / 1000),
      source: "chain",
    });
    assertPrivate(r.body, HL_T2.address);
  });

  it("shows an unlinked address as tier 0, 1.00×", async () => {
    expect((await get(`/passport/${ELY2.address}`)).json()).toMatchObject({ valid: false, tier: 0, multiplier: "1.00", source: "chain" });
  });

  it("caches the chain read for 30 s", async () => {
    await get(`/passport/${ELY.address}`);
    h.registry.down = true;
    expect((await get(`/passport/${ELY.address}`)).statusCode).toBe(200);
    h.clock.ms += 30_001;
    const r = await get(`/passport/${ELY.address}`);
    expect([r.statusCode, r.json().error]).toEqual([503, "UPSTREAM_UNAVAILABLE"]);
  });

  it("refuses a bad address", async () => {
    expect((await get("/passport/0xnope")).json()).toEqual({ error: "INVALID_ADDRESS", detail: "address" });
  });
});

describe("POST /passport/refresh", () => {
  it("needs an existing link", async () => {
    const r = await post("/passport/refresh", { elysiumAccount: ELY.address });
    expect([r.statusCode, r.json().error]).toEqual([404, "NOT_LINKED"]);
  });

  it("re-checks and re-signs, once per 10 minutes", async () => {
    const v = (await link()).json();
    h.registry.apply(v.attestation);
    h.clock.ms += 60_000;
    const r = await post("/passport/refresh", { elysiumAccount: ELY.address });
    expect(r.statusCode).toBe(200);
    expect(r.json().attestation.issuedAt).toBeGreaterThan(v.attestation.issuedAt);
    expect(r.json().attestation.linkedAt).toBeUndefined();
    const again = await post("/passport/refresh", { elysiumAccount: ELY.address });
    expect([again.statusCode, again.json().error]).toEqual([429, "RATE_LIMITED"]);
    assertPrivate(r.body, HL_T2.address);
  });
});

describe("stats, health, unknown routes", () => {
  it("counts linked and valid passports by tier and stamp", async () => {
    await link();
    h.clock.ms += 61_000; // past the 60 s stats cache
    const s = (await get("/passport/stats")).json();
    expect(s).toMatchObject({ linked: 1, valid: 1, byTier: { "1": 0, "2": 1, "3": 0 } });
    expect(s.byStamp).toMatchObject({ STAKER: 1, GENESIS: 1, HYPURR: 1, KHYPE: 0 });
    assertPrivate(JSON.stringify(s), HL_T2.address);
  });

  it("reports budgets and the chain on /health and /passport/health", async () => {
    for (const path of ["/health", "/passport/health"]) {
      const r = await get(path);
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ ok: true, hlBudgetLeft: expect.any(Number), evmBudgetLeft: expect.any(Number), registry: h.registry.address, lastBlock: "1" });
    }
    h.registry.down = true;
    expect((await get("/health")).statusCode).toBe(503);
  });

  it("answers unknown routes with 404 JSON", async () => {
    expect((await get("/nope")).json()).toEqual({ error: "NOT_FOUND" });
  });
});

describe("log redaction", () => {
  it("keeps an unexpected error's name, first line and code locations, but no call data", async () => {
    const { ContractFunctionExecutionError, ContractFunctionRevertedError, parseAbi } = await import("viem");
    const { redactError } = await import("../src/api.ts");
    const abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
    const hl = "0xcf2181b5d5f0ea3ee5d3a1a2f44d2e3b1f87ad7c";
    const err = new ContractFunctionExecutionError(new ContractFunctionRevertedError({ abi, functionName: "balanceOf" }), {
      abi,
      functionName: "balanceOf",
      args: [hl],
      contractAddress: "0x0000000000000000000000000000000000000001",
    });
    expect(err.message.toLowerCase()).toContain(hl.slice(2)); // viem puts the call (and the address) in the message
    const out = redactError(err);
    expect(JSON.stringify(out).toLowerCase()).not.toContain(hl.slice(2));
    expect(out.type).toBe("ContractFunctionExecutionError");
    expect(out.stack).toMatch(/^\s*at /);
    expect(redactError("plain text")).toMatchObject({ type: "Error", message: "plain text" });
  });
});
