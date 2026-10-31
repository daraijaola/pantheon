// Safety checks replayed from real answers recorded on Elysium testnet (test/fixtures/safety/, made by
// scripts/safety-fixtures.ts). A few cases change one recorded answer to show what DELPHI does with
// a coin that refuses transfers or a verifier entry for other code; each such edit is spelled out here.
import { readFileSync } from "node:fs";
import { encodeErrorResult, parseAbi, type Address, type Hex } from "viem";
import { beforeAll, describe, expect, it } from "vitest";
import { ContractsApi, ExplorerApi } from "../src/conduit.ts";
import { pickHolder } from "../src/honeypot.ts";
import { KalosApi } from "../src/kalos.ts";
import { BatchRpc } from "../src/rpc.ts";
import { checkSafety, PROXY_SLOTS, SAFETY_RULES, type SafetyOptions, type SafetyReport } from "../src/safety.ts";
import { replayFetch, type Tape } from "../src/tape.ts";

const load = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/safety/${name}.json`, import.meta.url), "utf8")) as Tape;
const NOW = new Date("2026-10-31T12:00:00Z");
const quiet = async () => {};

/** The tokens and holders the fixtures were recorded with (scripts/safety-fixtures.ts). */
const T = {
  kalos: ["0x8a2201953AF29e8BE7700bcB53dA3ce5caD18726", "0x390ba3e6Cee71ba79F598312ab98936a3aDAddb8"],
  whype: ["0xCD57F65c2B0e5881CFC2E609F7CD53b746E1F234", "0x9eD1413Cbb25f1030826398660Ff44CDAA8797Cd"],
  usdc: ["0x7D29d8047B905000459c0E80c34a26CeedcB47b2", "0x9eD1413Cbb25f1030826398660Ff44CDAA8797Cd"],
  musdc: ["0x306eB30576814505df6cb0B35e4F4bfbACEeD54c", "0x7a58774d932dcf33C649a992187bbCd9cE56B19B"],
  ta: ["0x4bD433648bACDe1FBd1522bb7737CdeCbdf21da9", "0x2256Ae4d037A65EEdbA3003C242aD708E1649d13"],
  "ta-taxed": ["0x4bD433648bACDe1FBd1522bb7737CdeCbdf21da9", "0x2256Ae4d037A65EEdbA3003C242aD708E1649d13"],
  rewards: ["0x64822eDfEA1226B9FB6a7F03806a1f039FD1b9De", "0xe600EDBB0E6F1A7b8f1039B24d1c392792148198"],
  nfalc: ["0xCF52DE746CA0b5b8fCC2cC674A69C9B8B8768779", "0x45bd00c7cF7dCc7e7CbDCECc490f939b61B2a236"],
} as const satisfies Record<string, readonly [Address, Address]>;
const UPGRADE_EXECUTOR = "0xFa78c1a82455a6ce83aA82CF464D74e88b384600";

async function replay(name: keyof typeof T, edit?: (tape: Tape) => void, opts: SafetyOptions = {}): Promise<SafetyReport> {
  const tape = load(name);
  edit?.(tape);
  const fetch = replayFetch(tape);
  const rpc = new BatchRpc("http://node.test", { fetch, gapMs: 0, sleep: quiet, retries: 0 });
  const [token, holder] = T[name];
  const deps = { rpc, fetch, contracts: new ContractsApi({ fetch, sleep: quiet }), explorer: new ExplorerApi({ fetch, sleep: quiet }), kalosApi: new KalosApi({ fetch, sleep: quiet }) };
  return checkSafety(deps, token, { holder, block: BigInt(tape.block!), now: NOW, ...opts });
}

type SimEntry = { method: string; params: unknown[]; result?: unknown };
type SimCallAnswer = { status: Hex; returnData?: Hex; gasUsed: Hex; logs?: unknown[]; error?: { code: number; message: string; data?: Hex } };
const simCalls = (e: SimEntry) => (e.params[0] as { blockStateCalls: Array<{ calls: Array<{ from: string; to: string; data: Hex }> }> }).blockStateCalls[0]!.calls;
/** Replaces one call's answer in the recorded dry runs that `match` picks. */
function editSim(tape: Tape, match: (calls: ReturnType<typeof simCalls>) => number | null, answer: SimCallAnswer) {
  let n = 0;
  for (const e of tape.rpc as SimEntry[]) {
    if (e.method !== "eth_simulateV1") continue;
    const i = match(simCalls(e));
    if (i === null) continue;
    (e.result as Array<{ calls: SimCallAnswer[] }>)[0]!.calls[i] = answer;
    n++;
  }
  if (!n) throw new Error("no recorded dry run matched");
}
const errorString = (reason: string) => encodeErrorResult({ abi: parseAbi(["error Error(string)"]), errorName: "Error", args: [reason] });
const refused = (reason: string): SimCallAnswer => ({ status: "0x0", returnData: "0x", gasUsed: "0x5f29", logs: [], error: { code: 3, message: `execution reverted: ${reason}`, data: errorString(reason) } });
const TRANSFER = "0xa9059cbb";

describe("a plain token with no owner (KALOS, recorded live)", () => {
  let r: SafetyReport;
  beforeAll(async () => {
    r = await replay("kalos");
  });

  it("is clean except for its unpublished source", () => {
    expect(r.rules).toBe(SAFETY_RULES.version);
    expect(r.risks).toEqual(["verified"]);
    expect(r.unknowns).toEqual([]);
    expect(r.checks.code.summary).toBe("It is a contract (1,785 bytes) and its code cannot be changed.");
    expect(r.checks.owner.summary).toBe("It has no owner: nobody controls it.");
    expect(r.checks.powers.facts).toMatchObject({ source: "bytecode", readable: true, found: [], otherFunctions: [] });
    expect(r.checks.impersonation.summary).toBe("This is the real KALOS (KALOS's own contract).");
  });

  it("names who deployed it and in which transaction", () => {
    expect(r.checks.owner.facts.deployment).toEqual({ tx: "0x934d7d8a60b378cfd569cfb8240f0d45364d7f358dd7195ec3d02ea15840bd3e", sender: "0x9332e35e87eAc40a0810813a7a12C458E8043184", factory: null, block: "8128219" });
  });

  it("moves and sells without losing anything to a tax", () => {
    const t = r.checks.transfer.facts.test!;
    expect(t).toMatchObject({ blocked: false, taxPct: 0, sideTransfers: [] });
    expect(t.received).toBe(t.amount);
    expect(t.onward).toMatchObject({ blocked: false, received: t.amount });
    const s = r.checks.sell.facts;
    expect(s.pool).toMatchObject({ pool: "0xc826B2A15a7d6BDB0e88F6d72900bf2C2D2E9127", fee: 20_000 });
    for (const leg of [s.holderSell!, s.roundTrip!.buy, s.roundTrip!.sell!]) {
      expect(leg.ok).toBe(true);
      expect(leg.received).toBe(leg.quoted);
      expect(leg.taxPct).toBe(0);
    }
    expect(r.checks.sell.state).toBe("ok");
  });
});

describe("a proxy the chain owner can upgrade (WHYPE, recorded live)", () => {
  let r: SafetyReport;
  beforeAll(async () => {
    r = await replay("whype");
  });

  it("reads the implementation and admin from the EIP-1967 slots, and the admin's owner", () => {
    expect(r.checks.code.facts.proxy).toEqual({
      kind: "eip1967",
      implementation: "0x88B0e068f77Cb73157dc27C78C80CbcFDb21e24f",
      beacon: null,
      admin: "0xc54AC04834d2A54dd20245a9f71e04A31DdfCB75",
      adminOwner: UPGRADE_EXECUTOR,
      implementationSize: 6961,
    });
    expect(r.checks.code.evidence).toContainEqual({ what: "implementation, in the EIP-1967 slot", address: "0x88B0e068f77Cb73157dc27C78C80CbcFDb21e24f", slot: PROXY_SLOTS.implementation });
    expect(PROXY_SLOTS.implementation).toBe("0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc");
    expect(PROXY_SLOTS.admin).toBe("0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103");
    expect(PROXY_SLOTS.beacon).toBe("0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50");
  });

  it("calls it upgradeable by the admin's owner, and reads the implementation's code for powers", () => {
    expect(r.checks.code.state).toBe("risk");
    expect(r.checks.code.summary).toContain("can be replaced at any time by Elysium's UpgradeExecutor (the chain owner) 0xFa78c1…4600");
    expect(r.checks.owner.facts.controllers).toEqual([{ address: UPGRADE_EXECUTOR, as: "can replace the code" }]);
    expect(r.checks.powers.facts.scanned).toBe("0x88B0e068f77Cb73157dc27C78C80CbcFDb21e24f");
    // The bridge's own mint and burn are normal for a bridged token, not a power over holders.
    expect(r.checks.powers.facts.found.map((f) => [f.signature, f.normal])).toEqual([
      ["bridgeMint(address,uint256)", true],
      ["bridgeBurn(address,uint256)", true],
    ]);
    expect(r.checks.powers.state).toBe("ok");
  });

  it("finds the factory that created it through the block trace", () => {
    expect(r.checks.owner.facts.deployment).toMatchObject({ factory: "0x78752f8fF01cC549E4586cD96822B669dE3a2737", block: "24305" });
    expect(r.checks.sell.summary).toBe("It is Kalos's wrapped HYPE, the currency other coins are sold for.");
  });
});

describe("a verified proxy over unpublished code (Kalos's USDC, recorded live)", () => {
  let r: SafetyReport;
  beforeAll(async () => {
    r = await replay("usdc");
  });

  it("follows the beacon and does not count the proxy's verified source for the code it runs", () => {
    expect(r.checks.code.facts.proxy).toMatchObject({ kind: "eip1967-beacon", beacon: "0x03BE231DfF6da11F7E0F320bCCb3eEafaDb54DFF", implementation: "0x49735D0A84434efE861ACc9C62a4dcF43E53eC81", adminOwner: UPGRADE_EXECUTOR });
    expect(r.checks.verified.facts.proxy).toMatchObject({ verified: true, name: "ClonableBeaconProxy", match: "exact_match", codeMatches: true });
    expect(r.checks.verified.facts.logic).toMatchObject({ verified: false });
    expect(r.checks.verified.state).toBe("risk");
    expect(r.checks.verified.summary).toMatch(/^The proxy's own source is published \(ClonableBeaconProxy\), but the code it runs is not/);
  });

  it("is the real USDC even though Ascend's USDC has the same name", () => {
    expect(r.checks.impersonation.state).toBe("ok");
    expect(r.checks.impersonation.summary).toBe("This is the real USDC (Kalos's approved list); the USDC Ascend prices its coins in (0x4b4fb5…f140) has the same name and is real too.");
  });
});

describe("an owned token with mint (mUSDC, recorded live)", () => {
  let r: SafetyReport;
  beforeAll(async () => {
    r = await replay("musdc");
  });

  it("finds mint in the bytecode and proves the minter can call it", () => {
    const [mint] = r.checks.powers.facts.found;
    expect(mint).toMatchObject({ power: "mint", signature: "mint(address,uint256)", selector: "0x40c10f19", usable: "yes", by: ["0x48E327406eB28e47c7339296f5017d3488D2B07c"] });
    expect(mint!.probes).toEqual([
      { from: "anyone", ok: false },
      { from: "0x48E327406eB28e47c7339296f5017d3488D2B07c", ok: true },
    ]);
    expect(r.checks.owner.facts.minter).toBe("0x48E327406eB28e47c7339296f5017d3488D2B07c");
    expect(r.checks.owner.summary).toBe("0x48E327…B07c still controls it and can create new tokens or set balances.");
    expect(r.risks).toEqual(["verified", "owner", "powers"]);
  });
});

describe("a token anyone can mint and tax (TA, recorded live)", () => {
  let r: SafetyReport;
  beforeAll(async () => {
    r = await replay("ta");
  });

  it("says anyone can mint and set the tax, because a random wallet's dry run went through", () => {
    expect(r.checks.powers.facts.found.map((f) => [f.signature, f.usable, f.by])).toEqual([
      ["mint(address,uint256)", "yes", ["anyone"]],
      ["setTaxPips(uint256)", "yes", ["anyone"]],
    ]);
    expect(r.checks.powers.summary).toMatch(/^Anyone can create new tokens or set balances and set or raise the buy, sell or transfer tax/);
    expect(r.checks.owner.state).toBe("risk");
    expect(r.checks.transfer.facts.test!.taxPct).toBe(0); // its tax is 0 today
  });
});

describe("a taxed coin (TA with a 3% tax: real node answers, see scripts/safety-fixtures.ts)", () => {
  let r: SafetyReport;
  beforeAll(async () => {
    r = await replay("ta-taxed");
  });

  it("measures the transfer tax", () => {
    const t = r.checks.transfer.facts.test!;
    expect([t.amount, t.received, t.taxPct]).toEqual(["10000000", "9700000", 3]);
    expect(t.onward).toMatchObject({ amount: "9700000", received: "9409000" });
    expect(r.checks.transfer.summary).toBe("A test transfer lost 3% on the way: the coin keeps part of every transfer.");
  });

  it("measures the buy tax against Kalos's quote, and reports the pool refusing the sale", () => {
    const s = r.checks.sell.facts;
    expect(s.roundTrip!.buy).toMatchObject({ ok: true, taxPct: 2.9999 });
    expect(s.holderSell).toMatchObject({ ok: false, revert: { reason: "IIA" } });
    expect(s.roundTrip!.sell).toMatchObject({ ok: false, revert: { reason: "IIA" } });
    expect(r.checks.sell.summary).toBe(`A test sale on Kalos by a real holder failed: "IIA". The pool got fewer coins than it was sent, which is what happens when a coin keeps part of every transfer.`);
  });
});

describe("a verified token (TESTERR, a RewardsToken, recorded live)", () => {
  let r: SafetyReport;
  beforeAll(async () => {
    r = await replay("rewards");
  });

  it("reads its powers from the verified ABI, by name where the arguments differ from the table", () => {
    expect(r.checks.verified).toMatchObject({ state: "ok", facts: { logic: { verified: true, name: "RewardsToken", codeMatches: true } } });
    expect(r.checks.powers.facts.source).toBe("verified-abi");
    const found = Object.fromEntries(r.checks.powers.facts.found.map((f) => [f.signature, [f.power, f.usable]]));
    expect(found).toEqual({
      "enableTrading()": ["trading", "no"],
      "setFeeExempt(address,bool)": ["exempt", "yes"],
      "rescueToken(address,address)": ["rescue", "yes"],
      "setPair(address,address,uint8,uint256)": ["router", "yes"],
      "transferOwnership(address)": ["ownership", "yes"],
      "renounceOwnership()": ["ownership", "yes"],
    });
    // enableTrading takes no arguments and the owner's dry run was refused: trading is already on.
    expect(r.checks.powers.facts.found.find((f) => f.signature === "enableTrading()")!.note).toMatch(/used already/);
    expect(r.checks.owner.summary).toBe("0xe600ED…8198 still controls it and can let chosen wallets skip the tax or the limits, pull tokens or HYPE out of the token contract and point the token at a different router or trading pair.");
  });
});

describe("a minimal proxy (NFALC, recorded live)", () => {
  let r: SafetyReport;
  beforeAll(async () => {
    r = await replay("nfalc");
  });
  it("reads the clone's target from its code and calls it fixed", () => {
    expect(r.checks.code.facts.proxy).toMatchObject({ kind: "eip1167", implementation: "0xd82516B3307Bafa36AB956FF193d773608BB8bE9", admin: null });
    expect(r.checks.code.facts.upgrade.possible).toBe(false);
    expect(r.checks.code.state).toBe("ok");
    expect(r.checks.sell.summary).toBe("It has no Kalos pool against WHYPE with liquidity, so DELPHI could not test a sale.");
  });
});

describe("answers DELPHI must not take at face value (one recorded answer changed)", () => {
  it("a transfer the coin refuses is a risk, with the coin's own reason", async () => {
    const r = await replay("kalos", (t) => editSim(t, (calls) => (calls.length === 4 && calls[1]!.data.startsWith(TRANSFER) ? 1 : null), refused("Trading is not open yet")));
    expect(r.checks.transfer.state).toBe("risk");
    expect(r.checks.transfer.summary).toBe(`A test transfer from a real holder was refused: "Trading is not open yet".`);
    expect(r.checks.transfer.facts.test!.revert!.data).toBe(errorString("Trading is not open yet"));
  });

  it("a new holder who cannot pass the coin on is a risk", async () => {
    const r = await replay("kalos", (t) => editSim(t, (calls) => (calls.length === 3 && calls[1]!.data.startsWith(TRANSFER) && calls[1]!.from !== T.kalos[1] ? 1 : null), refused("Only approved wallets")));
    expect(r.checks.transfer.state).toBe("risk");
    expect(r.checks.transfer.summary).toBe(`A wallet that had just received it could not pass it on: "Only approved wallets". New holders may be stuck.`);
  });

  it("a verifier entry for other code, or a bare name, is not verified source", async () => {
    const fake = (body: unknown) => (t: Tape) => {
      const e = t.http.find((h) => h.url.includes(`/v2/contract/99801/${T.kalos[0]}`))!;
      e.status = 200;
      e.response = body;
    };
    const transferAbi = [{ type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }] }];
    const other = await replay("kalos", fake({ match: "exact_match", runtimeMatch: "exact_match", creationMatch: null, abi: transferAbi, compilation: { name: "KALOS" }, runtimeBytecode: { onchainBytecode: "0x6080604052" } }));
    expect(other.checks.verified.state).toBe("risk");
    expect(other.checks.verified.summary).toBe("It has a published source, but not for the code on chain now, so it does not count.");
    expect(other.checks.powers.facts.source).toBe("bytecode");
    const nameOnly = await replay("kalos", fake({ match: null, runtimeMatch: null, creationMatch: null, compilation: { name: "KALOS" } }));
    expect(nameOnly.checks.verified.facts.logic).toMatchObject({ verified: false, name: "KALOS" });
    expect(nameOnly.checks.verified.summary).toMatch(/is not published/);
  });
});

describe("an address with no contract", () => {
  it("is a risk, and nothing else is checked", async () => {
    // A node that knows nothing: no code, empty slots, no answers.
    const fetch = async (_url: string, init?: RequestInit) => {
      const calls = JSON.parse(String(init!.body)) as Array<{ id: number; method: string }>;
      const answer = (m: string) => (m === "eth_chainId" ? "0x185d9" : m === "eth_blockNumber" ? "0x10" : m === "eth_getStorageAt" ? `0x${"0".repeat(64)}` : "0x");
      return new Response(JSON.stringify(calls.map((c) => ({ jsonrpc: "2.0", id: c.id, result: answer(c.method) }))));
    };
    const rpc = new BatchRpc("http://node.test", { fetch, gapMs: 0, sleep: quiet });
    const r = await checkSafety({ rpc, fetch }, "0x00000000000000000000000000000000000fa4e1", { known: [], now: NOW });
    expect(r.checks.code).toMatchObject({ state: "risk", summary: "There is no contract at this address, so it is not a token." });
    expect(r.risks).toEqual(["code"]);
    expect(r.unknowns).toEqual(["verified", "owner", "powers", "transfer", "sell", "impersonation"]);
  });
});

describe("pickHolder (BTC on Ascend, recorded live)", () => {
  it("walks back through a quiet coin's whole history and picks its biggest wallet", async () => {
    const tape = load("pick-holder") as Tape & { expected: { holder: string; balance: string; transfersSeen: number; fromBlock: string; toBlock: string } };
    const rpc = new BatchRpc("http://node.test", { fetch: replayFetch(tape), gapMs: 0, sleep: quiet, retries: 0 });
    const pick = await pickHolder(rpc, "0xe9D57Df7e1cbb05DC1C8dAF0fC05aDf3bDCEc6a1", BigInt(tape.block!), SAFETY_RULES.holder);
    expect(pick && { ...pick, balance: pick.balance.toString(), fromBlock: pick.fromBlock.toString(), toBlock: pick.toBlock.toString() }).toEqual(tape.expected);
    expect(tape.expected.holder).toBe("0xCd6FD4F3Fc2767ecF058EC94c88E728db706C733");
  });
});
