// A case file per coin DELPHI flags or watches: who the big wallets really are, what ties a group
// together, and who exactly makes the round trips. For a person reviewing verdicts before they ship,
// not for the public. Reads DELPHI's cache (no new funding lookups):
//   node scripts/review.ts                 every FLAG and WATCH, one file each in out/review/
//   node scripts/review.ts --only 0x…      one coin (any verdict)
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAddress, isAddress } from "viem";
import { makeClient } from "../src/chain.ts";
import { loadConfig, supplyOf } from "../src/config.ts";
import { balances, pct, roundTrips } from "../src/detect.ts";
import { clusters, groupsOf, isSystem } from "../src/graph.ts";
import { collect } from "../src/ingest.ts";
import { analyze } from "../src/report.ts";
import { BatchRpc } from "../src/rpc.ts";
import { Store } from "../src/store.ts";
import type { CoinData, Link } from "../src/types.ts";

const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : undefined;
if (only !== undefined && !isAddress(only, { strict: false })) throw new Error("--only needs a token address");
const lc = (a: string) => a.toLowerCase();
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const cfg = loadConfig();
const store = new Store(cfg.dbPath);
const log = (m: string) => console.error(`[review] ${m}`);

type StoredFunding = { from: string; via: "tx" | "internal"; time: number };

/** Every coin's wallets that a wallet handed this coin to, and that sent trades for it. */
function fanout(d: CoinData) {
  const passedTo = new Map<string, Set<string>>();
  for (const t of d.transfers) {
    if (isSystem(d, t.from) || isSystem(d, t.to)) continue;
    if (!passedTo.has(lc(t.from))) passedTo.set(lc(t.from), new Set());
    passedTo.get(lc(t.from))!.add(lc(t.to));
  }
  return passedTo;
}

function reasons(links: Link[]): string {
  const n = new Map<string, number>();
  for (const l of links) n.set(l.reason, (n.get(l.reason) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1]).map(([r, c]) => `${r} ×${c}`).join(", ");
}

function caseFile(d: CoinData, verdict: string, findings: string[], allCoins: CoinData[]): string {
  const c = d.coin;
  const supply = supplyOf(c);
  const bal = balances(d);
  const held = [...bal.values()].reduce((s, v) => s + v, 0n);
  const passed = fanout(d);
  const groups = groupsOf(d.links).sort((a, b) => b.members.size - a.members.size);
  const groupOf = new Map<string, number>();
  groups.forEach((g, i) => g.members.forEach((m) => groupOf.has(m) || groupOf.set(m, i)));
  const funding = (w: string) => store.recall<StoredFunding[]>("funding", w)?.filter((f) => lc(f.from) !== w).sort((a, b) => a.time - b.time)[0];
  const launchedBy = (w: string) => allCoins.filter((o) => lc(o.coin.creator) === w).map((o) => o.coin.symbol ?? short(o.coin.token));
  const lines: string[] = [];
  const say = (s = "") => lines.push(s);

  say(`# ${c.symbol ?? short(c.token)} (${c.market ?? "ascend"}): ${verdict}`);
  say(`token ${c.token} · creator ${c.creator}${lc(c.launcher) !== lc(c.creator) ? ` · launch sent by ${c.launcher}` : ""}`);
  say(`launched ${new Date(c.launchTime * 1000).toISOString()} · trades ${d.trades.length} · holders ${bal.size} · links ${d.links.length}${c.windowFrom !== undefined ? ` · windowed from block ${c.windowFrom}` : ""}`);
  say(`creator also launched: ${launchedBy(lc(c.creator)).join(", ") || "nothing else DELPHI reads"} · creator handed this coin to ${passed.get(lc(c.creator))?.size ?? 0} wallets`);
  say();
  say("## Findings");
  for (const f of findings) say(`- ${f}`);
  say();
  say("## Biggest holders (share of total supply)");
  const top = [...bal].sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0)).slice(0, 12);
  for (const [w, v] of top) {
    const f = funding(w);
    const tags = [
      w === lc(c.creator) ? "CREATOR" : "",
      groupOf.has(w) ? `group#${groupOf.get(w)} (${groups[groupOf.get(w)!]!.members.size})` : "",
      passed.get(w)?.size ? `handed out to ${passed.get(w)!.size}` : "",
      f ? `first funded by ${short(f.from)}${f.via === "internal" ? " (contract)" : ""}` : "funding unknown",
      launchedBy(w).length ? `launched ${launchedBy(w).length} coins` : "",
    ].filter(Boolean);
    say(`- ${short(w)} ${pct(v, supply)}% of supply (${pct(v, held)}% of wallets') · ${tags.join(" · ")}`);
  }
  say();
  say("## Groups");
  for (const [i, g] of groups.slice(0, 4).entries()) {
    const gHeld = [...g.members].reduce((s, m) => s + (bal.get(m) ?? 0n), 0n);
    const lead = [...g.members].sort((a, b) => ((bal.get(b) ?? 0n) > (bal.get(a) ?? 0n) ? 1 : -1))[0]!;
    say(`- group#${i}: ${g.members.size} wallets, anchor ${short(g.anchor)}, holds ${pct(gHeld, supply)}% of supply; biggest member ${short(lead)} ${pct(bal.get(lead) ?? 0n, supply)}%`);
    say(`  links: ${reasons(g.links)}`);
    const vias = new Map<string, number>();
    for (const l of g.links) if (l.via) vias.set(lc(l.via), (vias.get(lc(l.via)) ?? 0) + 1);
    const topVias = [...vias].sort((a, b) => b[1] - a[1]).slice(0, 5);
    if (topVias.length) say(`  shared funders: ${topVias.map(([v, n]) => `${short(v)}×${n}${v === lc(c.creator) ? " (CREATOR)" : ""}`).join(", ")}`);
  }
  say();
  say("## Round trips (who makes them)");
  const matched = roundTrips(d);
  const cl = clusters(d.links, [...matched.keys()].map((t) => lc(t.holder)));
  const byActor = new Map<string, bigint>();
  for (const [t, m] of matched) {
    const k = cl.get(lc(t.holder)) ?? lc(t.holder);
    byActor.set(k, (byActor.get(k) ?? 0n) + m);
  }
  const washTotal = [...byActor.values()].reduce((s, v) => s + v, 0n);
  const volume = d.trades.filter((t) => !isSystem(d, t.holder)).reduce((s, t) => s + t.tokens, 0n);
  const ranked = [...byActor].sort((a, b) => (b[1] > a[1] ? 1 : -1));
  say(`round-trip volume ${pct(washTotal, volume)}% of all volume, by ${byActor.size} actors (wallets or linked groups)`);
  const top10 = ranked.slice(0, 10).reduce((s, [, v]) => s + v, 0n);
  say(`top 1 actor: ${ranked[0] ? pct(ranked[0][1], washTotal) : 0}% of round trips · top 10: ${pct(top10, washTotal)}%`);
  for (const [a, v] of ranked.slice(0, 6)) {
    const g = groups.find((x) => x.anchor === a);
    say(`- ${short(a)}${g ? ` (group of ${g.members.size})` : ""}${a === lc(c.creator) || g?.members.has(lc(c.creator)) ? " CREATOR'S" : ""}: ${pct(v, washTotal)}% of round trips`);
  }
  say();
  say("## Launch window (first 30 s)");
  const early = d.trades.filter((t) => t.side === "buy" && t.time <= c.launchTime + 30 && !isSystem(d, t.holder));
  const earlyBy = new Map<string, bigint>();
  for (const t of early) earlyBy.set(lc(t.holder), (earlyBy.get(lc(t.holder)) ?? 0n) + t.tokens);
  for (const [w, v] of [...earlyBy].sort((a, b) => (b[1] > a[1] ? 1 : -1)).slice(0, 8)) {
    const f = funding(w);
    say(`- ${short(w)} bought ${pct(v, supply)}%${w === lc(c.creator) ? " CREATOR" : ""}${groupOf.has(w) ? ` group#${groupOf.get(w)}` : ""} · ${f ? `funded by ${short(f.from)}` : "funding unknown"}`);
  }
  return lines.join("\n");
}

try {
  const client = makeClient(cfg.elysiumRpc);
  const { coins } = await collect({ client, store, cfg, explorer: null, kalos: { rpc: new BatchRpc() }, log });
  const now = new Date();
  const dir = join(cfg.outDir, "review");
  mkdirSync(dir, { recursive: true });
  const index: string[] = [];
  for (const d of coins) {
    const r = analyze(d, { explorerWeb: cfg.explorerWeb, now });
    if (only ? lc(d.coin.token) !== lc(getAddress(only)) : r.verdict !== "FLAG" && r.verdict !== "WATCH") continue;
    const file = `${d.coin.symbol ?? "x"}-${d.coin.token.slice(2, 8)}.md`.replace(/[^\w.-]/g, "_");
    writeFileSync(join(dir, file), caseFile(d, r.verdict, r.findings.map((f) => `${f.severity}: ${f.summary}`), coins));
    index.push(`${r.verdict}\t${d.coin.market ?? "ascend"}\t${d.coin.symbol}\t${file}\t${r.findings.map((f) => f.detector).join(",")}`);
  }
  writeFileSync(join(dir, "index.tsv"), index.join("\n") + "\n");
  log(`${index.length} case files in ${dir}`);
} finally {
  store.close();
}
