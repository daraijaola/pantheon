import type { Address } from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GENESIS_WINDOW_MS, HL_WEIGHT } from "../src/config.ts";
import { HlClient, HlError } from "../src/hl/client.ts";
import { WeightLimiter } from "../src/ratelimit.ts";
import { loadFixtures, startMockHl, type MockHl } from "./mockHl.ts";

const fixtures = loadFixtures();
const addr = (name: string) => fixtures[name]!.address as Address;

let mock: MockHl;
let slept: number[];

function client(opts: { timeoutMs?: number; limiter?: WeightLimiter } = {}) {
  return new HlClient({
    url: mock.url,
    limiter: opts.limiter ?? new WeightLimiter(100_000),
    sleep: async (ms) => void slept.push(ms),
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
  });
}

beforeAll(async () => {
  mock = await startMockHl(fixtures);
});
afterAll(() => mock.close());
beforeEach(() => {
  mock.requests.length = 0;
  slept = [];
});

describe("HlClient against the fixtures", () => {
  it.each(Object.keys(fixtures))("parses every response for %s", async (name) => {
    const hl = client();
    const user = addr(name);
    const fx = fixtures[name]!;
    await expect(hl.userRole(user)).resolves.toMatchObject({ role: expect.any(String) });
    await hl.spotClearinghouseState(user);
    await hl.borrowLendUserState(user);
    await hl.delegatorSummary(user);
    await expect(hl.userNonFundingLedgerUpdates(user, 0)).resolves.toHaveLength(fx.ledger0.length);
    await hl.userNonFundingLedgerUpdates(user, GENESIS_WINDOW_MS.start, GENESIS_WINDOW_MS.end);
    await hl.portfolio(user);
    await hl.subAccounts(user);
    await hl.userToMultiSigSigners(user);
  });

  it("returns [] for sub-accounts when the API says null", async () => {
    expect(fixtures.supplied_spot!.subAccounts).toBeNull();
    await expect(client().subAccounts(addr("supplied_spot"))).resolves.toEqual([]);
    await expect(client().subAccounts(addr("small"))).resolves.toHaveLength(5);
  });

  it("exposes the master behind an API wallet", async () => {
    const role = await client().userRole(addr("agent"));
    expect(role.role).toBe("agent");
    expect(role.data?.user).toBe("0x5b5d51203a0f9079f8aeb098a6523a13f298c060");
    const agents = await client().extraAgents(role.data!.user as Address);
    expect(agents.map((a) => a.address)).toContain(addr("agent"));
  });

  it("keeps HL's decimal strings intact and finds HYPE by token index", async () => {
    const spot = await client().spotClearinghouseState(addr("supplied_spot"));
    expect(spot.balances.find((b) => b.token === 150)?.total).toBe("781.70434285");
    const pf = await client().portfolio(addr("staker100"));
    expect(pf.find(([period]) => period === "allTime")?.[1].vlm).toMatch(/^\d+(\.\d+)?$/);
  });

  it("answers a never-used address like the live API", async () => {
    const nobody = "0x00000000000000000000000000000000000000aa";
    await expect(client().userRole(nobody)).resolves.toEqual({ role: "missing" });
    await expect(client().userNonFundingLedgerUpdates(nobody, 0)).resolves.toEqual([]);
  });

  it("accepts API wallets without expiry and typed multi-sig answers", async () => {
    const agent = { name: "bot", address: addr("agent"), validUntil: null };
    mock.failNext(1, { status: 200, body: JSON.stringify([agent]) });
    await expect(client().extraAgents(addr("small"))).resolves.toEqual([agent]);

    const multisig = { authorizedUsers: [addr("small"), addr("staker100")], threshold: 2 };
    mock.failNext(1, { status: 200, body: JSON.stringify(multisig) });
    await expect(client().userToMultiSigSigners(addr("small"))).resolves.toEqual(multisig);
    await expect(client().userToMultiSigSigners(addr("small"))).resolves.toBeNull();
  });

  it("accepts spot entries without a token (HIP-4 outcome positions, seen live)", async () => {
    const spot = {
      balances: [
        { coin: "HYPE", token: 150, total: "12.5", hold: "0.0", entryNtl: "0.0" },
        { coin: "o458", total: "0.0", hold: "0.0", entryNtl: "0.0" },
        { coin: "+103990", total: "0.0", hold: "0.0", entryNtl: "0.0" },
      ],
    };
    mock.failNext(1, { status: 200, body: JSON.stringify(spot) });
    const got = await client().spotClearinghouseState(addr("small"));
    expect(got.balances.find((b) => b.token === 150)?.total).toBe("12.5");
    expect(got.balances).toHaveLength(3);
  });

  it("parses perps state in the live shape", async () => {
    await expect(client().clearinghouseState(addr("small"))).resolves.toMatchObject({ marginSummary: { accountValue: "0.0" } });
  });

  it("sends the request type, a lowercase user and the time window", async () => {
    const user = addr("staker100");
    await client().userNonFundingLedgerUpdates(user.toUpperCase().replace("0X", "0x") as Address, 5, 9);
    expect(mock.requests.at(-1)).toEqual({ type: "userNonFundingLedgerUpdates", user: user.toLowerCase(), startTime: 5, endTime: 9 });
  });
});

describe("HlClient budget", () => {
  it("charges each request its §2.11 weight", async () => {
    const limiter = new WeightLimiter(800);
    const hl = client({ limiter });
    await hl.userRole(addr("small"));
    await hl.spotClearinghouseState(addr("small"));
    await hl.delegatorSummary(addr("small"));
    expect(800 - limiter.available()).toBe(HL_WEIGHT.userRole + HL_WEIGHT.spotClearinghouseState + HL_WEIGHT.delegatorSummary);
  });
});

describe("HlClient failures", () => {
  const user = () => addr("small");

  it.each([503, 500, 429])("retries HTTP %i three times with 5/10/20 s backoff", async (status) => {
    mock.failNext(3, { status });
    await expect(client().delegatorSummary(user())).resolves.toMatchObject({ undelegated: expect.any(String) });
    expect(slept).toEqual([5_000, 10_000, 20_000]);
    expect(mock.requests).toHaveLength(4);
  });

  it("gives up with a typed UNAVAILABLE error after the third retry", async () => {
    mock.failNext(4, { status: 502 });
    const err = await client().delegatorSummary(user()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HlError);
    expect(err).toMatchObject({ code: "UNAVAILABLE", status: 502, requestType: "delegatorSummary" });
    expect(mock.requests).toHaveLength(4);
  });

  it("charges the budget for every attempt", async () => {
    const limiter = new WeightLimiter(800);
    mock.failNext(2, { status: 503 });
    await client({ limiter }).delegatorSummary(user());
    expect(800 - limiter.available()).toBe(3 * HL_WEIGHT.delegatorSummary);
  });

  it("honours a longer Retry-After", async () => {
    mock.failNext(1, { status: 429, headers: { "retry-after": "30" } });
    await client().delegatorSummary(user());
    expect(slept).toEqual([30_000]);
  });

  it("does not retry a refused request (HL's 422)", async () => {
    mock.failNext(1, { status: 422, body: "Failed to deserialize the JSON body into the target type" });
    await expect(client().delegatorSummary(user())).rejects.toMatchObject({ code: "BAD_REQUEST", status: 422 });
    expect(slept).toEqual([]);
  });

  it("retries dropped connections and timeouts", async () => {
    mock.failNext(1, { destroy: true });
    mock.failNext(1, { hangMs: 300 });
    await client({ timeoutMs: 100 }).delegatorSummary(user());
    expect(slept).toEqual([5_000, 10_000]);
  });

  it("rejects a 200 that is not JSON or has the wrong shape", async () => {
    mock.failNext(1, { status: 200, body: "<html>maintenance</html>" });
    await expect(client().delegatorSummary(user())).rejects.toMatchObject({ code: "BAD_RESPONSE" });
    mock.failNext(1, { status: 200, body: JSON.stringify({ delegated: 103.1 }) });
    await expect(client().delegatorSummary(user())).rejects.toMatchObject({ code: "BAD_RESPONSE" });
    expect(slept).toEqual([]);
  });

  it("refuses a malformed address without calling HL", async () => {
    await expect(client().userRole("0x1234" as Address)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(mock.requests).toHaveLength(0);
  });
});
