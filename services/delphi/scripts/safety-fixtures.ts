// Re-records the safety test fixtures in test/fixtures/safety/ from the live chain. Read-only, like
// everything in DELPHI: chain reads and dry runs only. Live, so run it by hand:
//   node scripts/safety-fixtures.ts            all of them
//   node scripts/safety-fixtures.ts --only ta  one (ta, ta-taxed, kalos, whype, usdc, musdc, nfalc, rewards, pick-holder, helper-code)
// Each fixture is a tape (src/tape.ts) of one checkSafety run pinned to one block, with the holder
// given so the tape stays small. Two are built rather than plainly recorded, and say so in their note:
// - ta-taxed: TA lets any wallet set its tax (setTaxPips). The tape is recorded against a node whose
//   every dry run first calls setTaxPips(30000), a 3% tax, from a random wallet; that call's answer is
//   then dropped. Every other answer is the real node's, for TA as it would be with a 3% tax.
// - helper-code: the runtime code of a real contract with a fake PUSH4 (see test/bytecode.test.ts).
// Block traces (debug_traceBlockByNumber, used to find who created a contract) are trimmed to the
// calls that lead to the token's creation: the only part DELPHI reads. A near-genesis block's full
// trace is half a megabyte.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeFunctionData, getAddress, keccak256, parseAbi, toHex, type Address } from "viem";
import { ContractsApi, ExplorerApi } from "../src/conduit.ts";
import { pickHolder } from "../src/honeypot.ts";
import type { Fetch } from "../src/http.ts";
import { KalosApi } from "../src/kalos.ts";
import { BatchRpc, EXPLORER_RPC } from "../src/rpc.ts";
import { checkSafety, SAFETY_RULES } from "../src/safety.ts";
import { emptyTape, recordingFetch, type Tape } from "../src/tape.ts";

const DIR = "test/fixtures/safety";
const log = (m: string) => console.error(`[safety-fixtures] ${m}`);
const TA: Address = "0x4bD433648bACDe1FBd1522bb7737CdeCbdf21da9";
const TAXER = getAddress(`0x${keccak256(toHex("delphi-safety:fixture-taxer")).slice(26)}`);
const SET_TAX = encodeFunctionData({ abi: parseAbi(["function setTaxPips(uint256)"]), functionName: "setTaxPips", args: [30_000n] });

/** A node that sets TA's tax to 3% at the start of every dry run, and hides that it did. */
function taxingFetch(inner: Fetch): Fetch {
  return async (url, init) => {
    if (typeof init?.body !== "string" || !init.body.includes("eth_simulateV1")) return inner(url, init);
    type Req = { id: number; method: string; params: Array<{ blockStateCalls: Array<{ calls: unknown[] }> }> };
    const calls = JSON.parse(init.body) as Req[];
    const sims = new Set(calls.filter((c) => c.method === "eth_simulateV1").map((c) => c.id));
    const changed = calls.map((c) =>
      sims.has(c.id) ? { ...c, params: [{ ...c.params[0]!, blockStateCalls: [{ ...c.params[0]!.blockStateCalls[0]!, calls: [{ from: TAXER, to: TA, data: SET_TAX }, ...c.params[0]!.blockStateCalls[0]!.calls] }] }, ...c.params.slice(1)] } : c,
    );
    const res = await inner(url, { ...init, body: JSON.stringify(changed) });
    const answers = (await res.json()) as Array<{ id: number; result?: Array<{ calls: unknown[] }> }>;
    for (const a of answers) if (sims.has(a.id) && a.result) a.result[0]!.calls = a.result[0]!.calls.slice(1);
    return new Response(JSON.stringify(answers), { status: res.status, headers: res.headers });
  };
}

type Frame = { from: string; to?: string; type?: string; calls?: Frame[] };

/** The calls from the top of a trace down to the creation of `token`, or null; everything else dropped. */
function pathTo(f: Frame, token: string): Frame | null {
  const keep = { from: f.from, ...(f.to ? { to: f.to } : {}), ...(f.type ? { type: f.type } : {}) };
  if ((f.type === "CREATE" || f.type === "CREATE2") && f.to?.toLowerCase() === token.toLowerCase()) return keep;
  for (const c of f.calls ?? []) {
    const sub = pathTo(c, token);
    if (sub) return { ...keep, calls: [sub] };
  }
  return null;
}

function trimTraces(tape: Tape, token: string) {
  for (const e of tape.rpc) {
    if (e.method !== "debug_traceBlockByNumber" || !Array.isArray(e.result)) continue;
    e.result = (e.result as Array<{ txHash: string; result: Frame }>).flatMap((t) => {
      const path = pathTo(t.result, token);
      return path ? [{ txHash: t.txHash, result: path }] : [];
    });
  }
}

const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : undefined;
const wanted = (name: string) => !only || only === name;

async function record(name: string, token: Address, holder: Address | undefined, block: bigint, note: string, through: (f: Fetch) => Fetch = (f) => f) {
  if (!wanted(name)) return;
  const tape: Tape = { ...emptyTape(note), block: block.toString() };
  const fetch = recordingFetch(through(globalThis.fetch), tape);
  const rpc = new BatchRpc(EXPLORER_RPC, { fetch });
  const r = await checkSafety(
    { rpc, fetch, contracts: new ContractsApi({ fetch }), explorer: new ExplorerApi({ fetch }), kalosApi: new KalosApi({ fetch }) },
    token,
    { holder, block, now: new Date("2026-10-31T12:00:00Z") },
  );
  trimTraces(tape, token);
  writeFileSync(join(DIR, `${name}.json`), `${JSON.stringify(tape)}\n`);
  log(`${name}: ${r.symbol} at block ${block}: risks ${r.risks.join(", ") || "none"}; ${tape.rpc.length} RPC and ${tape.http.length} HTTP answers`);
}

mkdirSync(DIR, { recursive: true });
const head = BigInt(await new BatchRpc().call<string>("eth_blockNumber", []));
await record("kalos", "0x8a2201953AF29e8BE7700bcB53dA3ce5caD18726", "0x390ba3e6Cee71ba79F598312ab98936a3aDAddb8", head, "KALOS: a plain token with no owner, sold on Kalos");
await record("whype", "0xCD57F65c2B0e5881CFC2E609F7CD53b746E1F234", "0x9eD1413Cbb25f1030826398660Ff44CDAA8797Cd", head, "WHYPE: an EIP-1967 proxy whose admin's owner is Elysium's UpgradeExecutor");
await record("usdc", "0x7D29d8047B905000459c0E80c34a26CeedcB47b2", "0x9eD1413Cbb25f1030826398660Ff44CDAA8797Cd", head, "Kalos's USDC: a verified beacon proxy (ClonableBeaconProxy) whose implementation is not verified");
await record("musdc", "0x306eB30576814505df6cb0B35e4F4bfbACEeD54c", "0x7a58774d932dcf33C649a992187bbCd9cE56B19B", head, "mUSDC: a token its minter can still mint");
await record("ta", TA, "0x2256Ae4d037A65EEdbA3003C242aD708E1649d13", head, "TA: anyone can mint it and set its tax");
await record("ta-taxed", TA, "0x2256Ae4d037A65EEdbA3003C242aD708E1649d13", head, "TA as if its tax were 3%: every dry run was answered by the real node after a setTaxPips(30000) call that was then dropped (see scripts/safety-fixtures.ts)", taxingFetch);
await record("rewards", "0x64822eDfEA1226B9FB6a7F03806a1f039FD1b9De", "0xe600EDBB0E6F1A7b8f1039B24d1c392792148198", head, "TESTERR: a verified RewardsToken whose owner can still switch trading, exempt wallets from fees, rescue tokens and set the pair");
await record("nfalc", "0xCF52DE746CA0b5b8fCC2cC674A69C9B8B8768779", "0x45bd00c7cF7dCc7e7CbDCECc490f939b61B2a236", head, "NFALC: an EIP-1167 clone with no Kalos liquidity");

// The holder search on a quiet coin (BTC on Ascend: a few dozen transfers in its whole life).
if (wanted("pick-holder")) {
  const tape: Tape = { ...emptyTape("pickHolder for BTC (an Ascend coin with few transfers)"), block: head.toString() };
  const rpc = new BatchRpc(EXPLORER_RPC, { fetch: recordingFetch(globalThis.fetch, tape) });
  const pick = await pickHolder(rpc, "0xe9D57Df7e1cbb05DC1C8dAF0fC05aDf3bDCEc6a1", head, SAFETY_RULES.holder);
  writeFileSync(join(DIR, "pick-holder.json"), `${JSON.stringify({ ...tape, expected: pick && { ...pick, balance: pick.balance.toString(), fromBlock: pick.fromBlock.toString(), toBlock: pick.toBlock.toString() } })}\n`);
  log(`pick-holder: ${pick?.holder} after ${pick?.transfersSeen} transfers`);
}

// A real contract whose code pushes transfer()'s selector to call a token, but has no transfer() itself.
if (wanted("helper-code")) {
  const helper: Address = "0x8622C75F63205092EB9991741581f45DF10f50dB";
  const code = await new BatchRpc().call<string>("eth_getCode", [helper, toHex(head)]);
  writeFileSync(join(DIR, "helper-code.json"), `${JSON.stringify({ note: "runtime code of a liquidity helper that calls transfer() on tokens (TA's biggest holder)", address: helper, block: head.toString(), code })}\n`);
  log(`helper-code: ${(code.length - 2) / 2} bytes`);
}
