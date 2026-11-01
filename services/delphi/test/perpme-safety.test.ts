// The sale test for PerpMe coins, replayed from real answers recorded on Elysium testnet (made by
// scripts/perpme-fixtures.ts): checkSafety on WHY DOGE at the head, long after its launch window, and 200
// blocks after its launch, inside the window. Two cases change one recorded dry-run answer to show what
// DELPHI says when a trade is refused inside the window and outside it; each edit is spelled out here.
import { readFileSync } from "node:fs";
import { encodeErrorResult, getAddress, parseAbi, type Address, type Hex } from "viem";
import { beforeAll, describe, expect, it } from "vitest";
import { ContractsApi, ExplorerApi } from "../src/conduit.ts";
import { PERPME_VENUE, TEST_WALLETS } from "../src/honeypot.ts";
import { KALOS_CONTRACTS, KalosApi } from "../src/kalos-api.ts";
import { BatchRpc } from "../src/rpc.ts";
import { checkSafety, type SafetyReport } from "../src/safety.ts";
import { replayFetch, type Tape } from "../src/tape.ts";

const load = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/perpme/${name}.json`, import.meta.url), "utf8")) as Tape;
const quiet = async () => {};
const NOW = new Date("2026-11-01T12:00:00Z");
const WHYDOGE = getAddress("0x4ddd716f0627693d12f237e0c42692fe23da0999");
const POOL = getAddress("0x7e3fa460573a5dd46b5c4af7701a08483655a4ce");
const CREATOR = getAddress("0x41145ba8C2a9e84548Eaf80ee0313e41EC227896");
/** The holders the tapes were recorded with: the biggest wallet at the head, and the creator inside the window. */
const HOLDER = { "sell-normal": getAddress("0xee68ef03470e86c62761021a2c0eab45533ab407"), "sell-restricted": CREATOR } as const;
const SWAP = "0x414bf389"; // exactInputSingle
const EXACT_OUT = "0xdb3e2198"; // exactOutputSingle

async function replay(name: keyof typeof HOLDER, edit?: (tape: Tape) => void): Promise<SafetyReport> {
  const tape = load(name);
  edit?.(tape);
  const fetch = replayFetch(tape);
  const rpc = new BatchRpc("http://node.test", { fetch, gapMs: 0, sleep: quiet, retries: 0 });
  const deps = { rpc, fetch, contracts: new ContractsApi({ fetch, sleep: quiet }), explorer: new ExplorerApi({ fetch, sleep: quiet }), kalosApi: new KalosApi({ fetch, sleep: quiet }) };
  return checkSafety(deps, WHYDOGE, { holder: HOLDER[name], block: BigInt(tape.block!), now: NOW });
}

type SimCall = { from: Address; to: Address; data: Hex };
type SimAnswer = { status: Hex; returnData?: Hex; gasUsed: Hex; logs?: unknown[]; error?: { code: number; message: string; data?: Hex } };
type SimEntry = { method: string; params: unknown[]; result?: unknown };
const simCalls = (e: SimEntry) => (e.params[0] as { blockStateCalls: Array<{ calls: SimCall[] }> }).blockStateCalls[0]!.calls;
const sims = (tape: Tape) => (tape.rpc as SimEntry[]).filter((e) => e.method === "eth_simulateV1");
/** Replaces one call's answer in the recorded dry runs that `match` picks. */
function editSim(tape: Tape, match: (calls: SimCall[]) => number | null, answer: SimAnswer) {
  let n = 0;
  for (const e of sims(tape)) {
    const i = match(simCalls(e));
    if (i === null) continue;
    (e.result as Array<{ calls: SimAnswer[] }>)[0]!.calls[i] = answer;
    n++;
  }
  if (!n) throw new Error("no recorded dry run matched");
}
const refusedTF: SimAnswer = {
  status: "0x0",
  returnData: "0x",
  gasUsed: "0x1f2a5",
  logs: [],
  error: { code: 3, message: "execution reverted: TF", data: encodeErrorResult({ abi: parseAbi(["error Error(string)"]), errorName: "Error", args: ["TF"] }) },
};

describe("a PerpMe coin long after its launch window (WHY DOGE at the head, recorded live)", () => {
  let r: SafetyReport;
  beforeAll(async () => {
    r = await replay("sell-normal");
  });

  it("finds its PerpMe launch from who made it, and tests the sale in its PerpMe pool", () => {
    expect(r.checks.owner.facts.deployment).toMatchObject({ tx: "0x62b7dcb2e455411dba64329b62d86a8aed4daa01039ae6bb6806a7225402715a", sender: CREATOR, factory: PERPME_VENUE.coinDeployer, block: "13816777" });
    const s = r.checks.sell.facts;
    expect(s.perpme!.launch).toEqual({
      factory: PERPME_VENUE.launchFactory,
      deployer: CREATOR,
      pool: POOL,
      pairToken: PERPME_VENUE.whype,
      fee: 10_000,
      positionId: "242",
      restrictionEndBlock: "67619580",
      initialBuyTokens: "26938492840937230301916",
      tx: "0x62b7dcb2e455411dba64329b62d86a8aed4daa01039ae6bb6806a7225402715a",
      block: "13816777",
    });
    expect(s.pool).toMatchObject({ pool: POOL, fee: 10_000, quote: PERPME_VENUE.whype });
    expect(r.checks.sell.evidence).toEqual(
      expect.arrayContaining([
        { what: "PerpMe pool against PerpMe's WHYPE (fee 1%)", address: POOL },
        { what: "launched on PerpMe", tx: "0x62b7dcb2e455411dba64329b62d86a8aed4daa01039ae6bb6806a7225402715a", address: PERPME_VENUE.launchFactory },
      ]),
    );
  });

  it("sells, and buys and sells back, at exactly PerpMe's quote, with launch protection over", () => {
    const s = r.checks.sell.facts;
    for (const leg of [s.holderSell!, s.roundTrip!.buy, s.roundTrip!.sell!]) {
      expect(leg.ok).toBe(true);
      expect(leg.taxPct).toBe(0);
      expect(leg.received).toBe(leg.quoted);
    }
    expect(s.perpme!.protection).toEqual({ active: false, maxWallet: "20000000000000000000000000", endBlock: "67619580", parentBlock: expect.stringMatching(/^\d+$/) });
    expect(BigInt(s.perpme!.protection!.parentBlock!)).toBeGreaterThan(67_619_580n);
    expect(s.perpme!.capProbe).toBeNull();
    expect(r.checks.sell.state).toBe("ok");
    expect(r.checks.sell.summary).toBe("Test sales on PerpMe by a real holder and a fresh wallet that had just bought went through and paid exactly what PerpMe's quoter said: no buy or sell tax.");
    expect(r.checks.transfer.state).toBe("ok");
  });

  it("trades through PerpMe's router and quoter, priced in PerpMe's WHYPE, never Kalos's", () => {
    const tos = new Set(sims(load("sell-normal")).flatMap((e) => simCalls(e).map((c) => getAddress(c.to))));
    expect(tos.has(PERPME_VENUE.swapRouter)).toBe(true);
    expect(tos.has(PERPME_VENUE.quoterV2)).toBe(true);
    for (const a of [KALOS_CONTRACTS.swapRouter, KALOS_CONTRACTS.quoterV2, KALOS_CONTRACTS.whype]) expect(tos.has(getAddress(a))).toBe(false);
    expect([...tos].every((a) => [PERPME_VENUE.swapRouter, PERPME_VENUE.quoterV2, PERPME_VENUE.whype, WHYDOGE].includes(a))).toBe(true);
  });

  it("calls a refused sale outside the window a risk", async () => {
    // Edit: the real holder's sale (its exactInputSingle) is refused "TF".
    const rr = await replay("sell-normal", (t) => editSim(t, (calls) => (calls[0]?.from === HOLDER["sell-normal"] && calls[4]?.data.startsWith(SWAP) ? 4 : null), refusedTF));
    expect(rr.checks.sell.state).toBe("risk");
    expect(rr.checks.sell.summary).toBe('A test sale by a real holder on PerpMe failed: "TF".');
  });
});

describe("a PerpMe coin inside its launch window (WHY DOGE 200 blocks after launch, recorded live)", () => {
  let r: SafetyReport;
  beforeAll(async () => {
    r = await replay("sell-restricted");
  });

  it("reads the window from the coin: on, 335 parent blocks left, 2% of the supply per wallet", () => {
    expect(r.checks.sell.facts.perpme!.protection).toEqual({ active: true, maxWallet: "20000000000000000000000000", endBlock: "67619580", parentBlock: "67619245" });
  });

  it("keeps its test buy small, and sees a buy of just over 2% refused, as designed", () => {
    const s = r.checks.sell.facts;
    expect(s.roundTrip!.buy.ok).toBe(true);
    expect(BigInt(s.roundTrip!.buy.received!)).toBeLessThan(10_000_000n * 10n ** 18n); // under half the cap
    expect(s.roundTrip!.sell!.ok).toBe(true);
    expect(s.holderSell!.ok).toBe(true);
    expect(s.perpme!.capProbe).toMatchObject({ ok: false, revert: { reason: "TF" } });
    const probe = sims(load("sell-restricted")).find((e) => simCalls(e)[0]!.data.startsWith(EXACT_OUT))!;
    expect(getAddress(simCalls(probe)[0]!.from)).toBe(TEST_WALLETS.probe);
    expect(r.checks.sell.state).toBe("ok");
    expect(r.checks.sell.summary).toBe(
      "Test sales on PerpMe by a real holder and a fresh wallet that had just bought went through and paid exactly what PerpMe's quoter said: no buy or sell tax. " +
        "Buying is restricted by design until parent-chain block 67619580 (335 blocks, about 6 min): PerpMe's launch protection lets no wallet hold more than 2% of the supply. " +
        "A test buy of just over 2% was refused, as designed.",
    );
  });

  it("says restricted, not honeypot, when a test buy is refused inside the window", async () => {
    // Edit: the fresh wallet's buy (its first dry run's exactInputSingle) is refused "TF".
    const rr = await replay("sell-restricted", (t) => editSim(t, (calls) => (calls.length === 3 && calls[1]?.from === TEST_WALLETS.buyer && calls[1]?.data.startsWith(SWAP) ? 1 : null), refusedTF));
    expect(rr.checks.sell.state).toBe("unknown");
    expect(rr.risks).not.toContain("sell");
    expect(rr.checks.sell.summary).toBe(
      "Buying is restricted by design until parent-chain block 67619580 (335 blocks, about 6 min): PerpMe's launch protection lets no wallet hold more than 2% of the supply. " +
        'A small test buy by a fresh wallet on PerpMe was refused: "TF"; DELPHI calls that restricted, not a honeypot, and can tell once the window ends.',
    );
  });

  it("notes when the cap does not hold", async () => {
    // Edit: the buy of just over 2% goes through.
    const rr = await replay("sell-restricted", (t) => editSim(t, (calls) => (calls[0]?.data.startsWith(EXACT_OUT) ? 0 : null), { status: "0x1", returnData: `0x${"0".repeat(63)}1`, gasUsed: "0x1", logs: [] }));
    expect(rr.checks.sell.summary).toMatch(/A test buy of just over 2% went through, so the cap did not hold\.$/);
  });
});
