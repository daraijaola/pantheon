// Contract and market safety for one coin, printed as JSON; or a compact table for every coin in
// Kalos's list. Read-only: chain reads and dry runs on the explorer's node, and the verifier, explorer
// and Kalos HTTP APIs. Nothing is signed or sent. Live, so run it by hand:
//   node scripts/safety.ts <token>                          the report for one coin, as JSON
//   node scripts/safety.ts <token> --holder 0x… --amount N  test with this holder and N whole tokens
//   node scripts/safety.ts <token> --block N                pin every read to block N
//   node scripts/safety.ts <token> --record file.json       also save every answer (for test fixtures)
//   node scripts/safety.ts --kalos-all [--out dir]          every non-base coin in Kalos's list: a table
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAddress, isAddress, parseUnits, type Address } from "viem";
import { ContractsApi, ExplorerApi } from "../src/conduit.ts";
import type { Fetch } from "../src/http.ts";
import { KalosApi } from "../src/kalos.ts";
import { answerData, ethCall, short, wordUint } from "../src/reads.ts";
import { BatchRpc, EXPLORER_RPC } from "../src/rpc.ts";
import { checkSafety, defaultKnownTokens, type SafetyDeps, type SafetyReport } from "../src/safety.ts";
import { emptyTape, recordingFetch } from "../src/tape.ts";

const args = process.argv.slice(2);
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const fail = (msg: string): never => {
  console.error(msg);
  process.exit(2);
};
const log = (m: string) => console.error(`[delphi-safety] ${m}`);

const recordTo = flag("--record");
const tape = emptyTape(recordTo ? `recorded by scripts/safety.ts ${args.join(" ")}` : undefined);
const fetch: Fetch = recordTo ? recordingFetch(globalThis.fetch, tape) : globalThis.fetch;
const rpc = new BatchRpc(EXPLORER_RPC, { fetch });
const deps: SafetyDeps = { rpc, fetch, contracts: new ContractsApi({ fetch }), explorer: new ExplorerApi({ fetch }), kalosApi: new KalosApi({ fetch }) };
const block = flag("--block") ? BigInt(flag("--block")!) : undefined;

/** "--amount 1.5" in whole tokens → the token's smallest unit. */
async function amountOf(token: Address): Promise<bigint | undefined> {
  const a = flag("--amount");
  if (a === undefined) return undefined;
  if (!/^\d+(\.\d+)?$/.test(a)) fail("--amount needs a number of whole tokens, like 100 or 0.5");
  const [d] = await rpc.many([ethCall(token, "0x313ce567", "latest")]);
  return parseUnits(a!, Number(wordUint(answerData(d)) ?? 18n));
}

const json = (r: unknown) => JSON.stringify(r, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2);

/** One short line per check for the table. */
function row(r: SafetyReport) {
  const c = r.checks;
  const v = c.verified.facts.logic;
  const o = c.owner.facts;
  const p = c.code.facts.proxy;
  const live = c.powers.facts.found.filter((f) => !f.normal && f.usable !== "no");
  const dead = c.powers.facts.found.filter((f) => !f.normal && f.usable === "no");
  const t = c.transfer.facts.test;
  const s = c.sell.facts;
  const pct = (x: number | null | undefined) => (x === null || x === undefined ? "?" : `${Number(x.toFixed(2))}%`);
  const legText = (l: { ok: boolean; taxPct: number | null; revert: { reason: string | null } | null } | null | undefined) =>
    !l ? "-" : l.ok ? pct(l.taxPct) : `FAILS${l.revert?.reason ? ` (${l.revert.reason.slice(0, 30)})` : ""}`;
  return {
    coin: (r.symbol ?? "?").slice(0, 12),
    token: short(r.token),
    verified: v?.verified ? `yes (${(v.name ?? "").slice(0, 18)})` : c.verified.state === "unknown" ? "?" : "no",
    owner: o.owner ? (o.renounced ? "renounced" : short(o.owner)) : o.controllers.length ? `${short(o.controllers[0]!.address)} (${o.controllers[0]!.as.split(" ")[0]})` : "none",
    powers: [...live.map((f) => `${f.power}${f.usable === "yes" ? (f.by.includes("anyone") ? "(anyone)" : "") : "?"}`), ...dead.map((f) => `${f.power}(dead)`)].filter((x, i, a) => a.indexOf(x) === i).join(",") || "-",
    proxy: p ? `${p.kind}${c.code.facts.upgrade.possible ? ` upg:${short(c.code.facts.upgrade.by[0] ?? "?")}` : c.code.facts.upgrade.possible === null ? " upg:?" : ""}` : "no",
    transfer: t ? (t.blocked ? "BLOCKED" : `${pct(t.taxPct)}${t.onward?.blocked ? " onward BLOCKED" : ""}`) : "?",
    sell: s.pool ? `holder ${legText(s.holderSell)} / buy ${legText(s.roundTrip?.buy)} sell ${legText(s.roundTrip?.sell)}` : s.ascend ? "ascend only" : "no pool",
    fake: c.impersonation.state === "risk" ? `copies ${c.impersonation.facts.matches[0]!.known.symbol}` : "no",
    risks: r.risks.join(",") || "-",
  };
}

function table(rows: Array<Record<string, string>>) {
  if (!rows.length) return "";
  const keys = Object.keys(rows[0]!);
  const width = keys.map((k) => Math.max(k.length, ...rows.map((r) => r[k]!.length)));
  const line = (vals: string[]) => `| ${vals.map((v, i) => v.padEnd(width[i]!)).join(" | ")} |`;
  return [line(keys), line(width.map((w) => "-".repeat(w))), ...rows.map((r) => line(keys.map((k) => r[k]!)))].join("\n");
}

try {
  if (args.includes("--kalos-all")) {
    const tokens = await deps.kalosApi!.tokens();
    const base = tokens.filter((t) => t.wrappedNative || (t.approved && t.symbol === "USDC"));
    const todo = tokens.filter((t) => !base.includes(t));
    log(`${tokens.length} Kalos tokens; checking ${todo.length} (skipping the base currencies ${base.map((t) => t.symbol).join(", ")})`);
    const notes: string[] = [];
    const known = await defaultKnownTokens(deps, "latest", notes);
    const out = flag("--out");
    if (out) mkdirSync(out, { recursive: true });
    const rows = [];
    for (const t of todo) {
      const started = Date.now();
      try {
        const r = await checkSafety(deps, t.address, { known, block });
        rows.push(row(r));
        if (out) writeFileSync(join(out, `${r.token}.json`), `${json(r)}\n`);
        log(`${t.symbol} ${t.address}: ${r.risks.length ? `risks ${r.risks.join(", ")}` : "no risks"} (${Math.round((Date.now() - started) / 1000)} s)`);
      } catch (err) {
        log(`${t.symbol} ${t.address}: failed: ${(err as Error).message}`);
      }
    }
    console.log(table(rows));
  } else {
    const tokenArg = args.find((a) => !a.startsWith("--") && isAddress(a, { strict: false }));
    if (!tokenArg) fail("usage: node scripts/safety.ts <token> [--holder 0x…] [--amount N] [--block N] [--record file.json] | --kalos-all [--out dir]");
    const token = getAddress(tokenArg!);
    const holder = flag("--holder");
    if (holder !== undefined && !isAddress(holder, { strict: false })) fail("--holder needs an address");
    const r = await checkSafety(deps, token, { holder: holder ? getAddress(holder) : undefined, amount: await amountOf(token), block });
    console.log(json(r));
    log(`${r.symbol ?? "?"} (${r.name ?? ""}) at block ${r.block}: ${r.risks.length ? `risks: ${r.risks.join(", ")}` : "no risks"}${r.unknowns.length ? `; unknown: ${r.unknowns.join(", ")}` : ""}`);
    log(`${rpc.requests} node requests`);
  }
} finally {
  if (recordTo) {
    writeFileSync(recordTo, `${JSON.stringify(tape, null, 1)}\n`);
    log(`saved ${tape.rpc.length} RPC and ${tape.http.length} HTTP answers to ${recordTo}`);
  }
}
