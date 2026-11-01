// The facts behind a wallet's standing, with stand-ins for the services: no network.
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/api.ts";
import type { WalletNow } from "../src/history.ts";
import type { StakeInfo } from "../src/stake.ts";
import { roundVoters, StandingReader, type StandingDeps } from "../src/standing.ts";
import { Verdicts } from "../src/verdicts.ts";

const FIXTURE = new URL("./fixtures/scan.json", import.meta.url).pathname;
const WALLET = "0x79a320a02db0c1cbe7a5f2cd47210ea6f3b9f23a";
const OTHER = "0x7a988b8fa5d66de4950ee5f94c55c7820b6e562f";
const FIRST = { block: "5", time: "2026-10-08T02:07:50.000Z" };
const coin = (verdict: string) => ({ token: "0xa", symbol: "A", venue: "ascend", verdict, reason: "r", disputeUrl: "d" });
const NOW: WalletNow = { wallet: WALLET, network: "testnet", readAt: "2026-11-01T00:00:00.000Z", txsSent: 5, hype: "1", coinsLaunched: [coin("CLEAN"), coin("FLAG"), coin("FLAG")] as never };
const STAKE = { staked: { raw: "7", amount: "0.000000000000000007" }, stakeStart: "2026-10-20T00:00:00.000Z", passportBoost: 1.2, passportTier: 2 } as StakeInfo;

const deps = (over: Partial<StandingDeps> = {}): StandingDeps => ({
  history: { quick: async () => NOW, firstDay: async () => FIRST },
  stake: { read: async () => STAKE },
  indexer: { stakes: async () => ({ times: [1_800_000_500, 1_800_000_000, 1_800_000_900], whole: true }) },
  voters: async () =>
    new Map([
      [5, new Set([WALLET])],
      [3, new Set([WALLET, OTHER])],
      [4, new Set([OTHER])],
    ]),
  ...over,
});

describe("a wallet's facts", () => {
  it("gathers every fact, and names no role", async () => {
    const got = await new StandingReader(deps()).read(WALLET);
    expect(got).toMatchObject({
      wallet: WALLET,
      network: "testnet",
      firstSeen: FIRST,
      staking: { now: STAKE.staked, bonusSince: STAKE.stakeStart, firstStaked: new Date(1_800_000_000_000).toISOString() },
      roundsVoted: [3, 5],
      coinsLaunched: { total: 3, byVerdict: { CLEAN: 1, FLAG: 2 } },
      passport: { tier: 2, boost: 1.2 },
      complete: true,
    });
    expect(JSON.stringify(got)).not.toMatch(/Staker|Councillor|Creator|Pillar|Genesis/);
  });

  it("gives a wallet that's done nothing plain empty facts, because it checked", async () => {
    const got = await new StandingReader(
      deps({ history: { quick: async () => ({ ...NOW, coinsLaunched: [] }), firstDay: async () => null }, indexer: { stakes: async () => ({ times: [], whole: true }) }, voters: async () => new Map() }),
    ).read(WALLET);
    expect(got).toMatchObject({ firstSeen: null, roundsVoted: [], coinsLaunched: { total: 0, byVerdict: {} }, complete: true });
    expect(got.staking.firstStaked).toBeNull();
  });

  it("finds a wallet however its address is written", async () => {
    const got = await new StandingReader(deps()).read(WALLET.toUpperCase().replace("0X", "0x"));
    expect(got.roundsVoted).toEqual([3, 5]);
  });

  it("says votes are unknown when Trials is down, never that the wallet didn't vote", async () => {
    const got = await new StandingReader(deps({ voters: () => Promise.reject(new Error("down")) })).read(WALLET);
    expect(got.roundsVoted).toBeNull();
    expect(got.complete).toBe(false);
    expect(got.coinsLaunched.total).toBe(3);
  });

  it("says it's incomplete when the indexer is down, or there were too many stakes to read", async () => {
    const down = await new StandingReader(deps({ indexer: { stakes: () => Promise.reject(new Error("down")) } })).read(WALLET);
    expect(down).toMatchObject({ complete: false, staking: { firstStaked: null } });
    const partial = await new StandingReader(deps({ indexer: { stakes: async () => ({ times: [5], whole: false }) } })).read(WALLET);
    expect(partial).toMatchObject({ complete: false, staking: { firstStaked: null } });
  });

  it("fails out loud when the chain fails", async () => {
    await expect(new StandingReader(deps({ stake: { read: () => Promise.reject(new Error("node down")) } })).read(WALLET)).rejects.toThrow("node down");
  });

  it("remembers a wallet and the voters for a minute", async () => {
    let t = 0;
    let voterReads = 0;
    const r = new StandingReader({ ...deps({ voters: async () => (voterReads++, new Map()) }), now: () => t });
    await r.read(WALLET);
    await r.read(WALLET);
    await r.read(OTHER);
    expect(voterReads).toBe(1);
    t = 60_000;
    await r.read(WALLET);
    expect(voterReads).toBe(2);
  });
});

describe("reading who voted", () => {
  const round = (n: number, voters: string[]) => ({ round: n, status: "closed", closesAt: 1, seats: 3, leaders: [], candidates: [], ballotList: voters.map((voter) => ({ voter, coins: [], weight: 1, receivedAt: 1 })) });

  it("keeps each round's voters, addresses lowercase", async () => {
    const got = await roundVoters(async () => [round(3, [WALLET.toUpperCase().replace("0X", "0x")]), round(4, [])])();
    expect([...got.keys()]).toEqual([3, 4]);
    expect(got.get(3)!.has(WALLET)).toBe(true);
    expect(got.get(4)!.size).toBe(0);
  });
});

describe("asking the server", () => {
  const v = new Verdicts(FIXTURE);
  it("answers with the facts", async () => {
    const res = await buildApp(v, { standing: new StandingReader(deps()) }).inject({ url: `/wallets/${WALLET}/standing` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ roundsVoted: [3, 5] });
  });

  it("refuses a bad address, and answers 503 when the chain fails", async () => {
    const app = buildApp(v, { standing: new StandingReader(deps({ stake: { read: () => Promise.reject(new Error("detail")) } })) });
    expect((await app.inject({ url: "/wallets/nope/standing" })).statusCode).toBe(400);
    const res = await app.inject({ url: `/wallets/${WALLET}/standing` });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "CHAIN_UNAVAILABLE" });
  });
});
