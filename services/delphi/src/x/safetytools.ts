// Feature "safety": the questions memecoin traders ask before they buy. contract_check reads the
// token's contract (verified or not, who controls it, what that owner can still do to holders, and a
// dry-run transfer and sale for tax or a blocked sell); liquidity shows a Kalos coin's pools and who
// could pull them. Both are read-only: dry runs are simulations, never transactions.
import { getAddress, isAddress, type Address } from "viem";
import { z } from "zod";
import type { LiquidityReport } from "../kalos.ts";
import type { SafetySummary } from "../safety-run.ts";
import { jsonTool, type ExtraTool } from "./tooling.ts";
import type { Snapshot } from "./xtools.ts";

const lc = (a: string) => a.toLowerCase();
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const hype = (wei: bigint | null) => (wei === null ? null : Number(wei / 10n ** 14n) / 1e4);
const when = (t: number | null) => (t ? new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC" : null);

/** A coin DELPHI reads, by address or $TICKER (one coin only: a shared ticker asks for the address). */
function tokenOf(snap: Snapshot, s: string): { token: Address } | { error: string } {
  const t = s.trim();
  if (isAddress(t, { strict: false })) return { token: getAddress(t) };
  const sym = t.replace(/^\$/, "").toLowerCase();
  const hits = [...snap.ws.coins.values()].filter((d) => d.coin.symbol?.toLowerCase() === sym);
  if (hits.length === 1) return { token: getAddress(hits[0]!.coin.token) };
  return { error: hits.length ? `${hits.length} coins use $${sym.toUpperCase()}: ask for the address` : `no coin DELPHI reads uses $${sym.toUpperCase()}` };
}

/** What she sees of a coin's pools: value, who holds the liquidity, and big removals. */
export function liquidityView(r: LiquidityReport) {
  return {
    token: r.token,
    pools: r.pools.map((p) => ({
      pool: p.pool,
      pricedIn: p.quoteSymbol ?? short(p.quote),
      feePct: p.fee / 10_000,
      ...(p.tvlHype !== null ? { valueHype: hype(p.tvlHype) } : {}),
      openPositions: p.openPositions,
      sharesMeasuredBy: p.shareBy === "value" ? "value at today's price" : "liquidity units (no price)",
      biggestOwners: p.topOwners.slice(0, 5).map((o) => ({
        owner: o.owner,
        sharePct: o.sharePct,
        ...(o.roles.length ? { is: o.roles.join(" and ") } : {}),
        kind: o.ownerKind === "burn" ? "burn address (locked for good)" : o.ownerKind,
      })),
      firstAdded: when(p.firstAdd?.time ?? null),
      bigRemovals: p.bigRemovals.length,
      ...(p.bigRemovals.length
        ? { latestBigRemoval: { tx: p.bigRemovals.at(-1)!.tx, by: p.bigRemovals.at(-1)!.owner, sharePct: p.bigRemovals.at(-1)!.sharePct, time: when(p.bigRemovals.at(-1)!.time) } }
        : {}),
    })),
    lpOwners: r.lpOwners,
    notes: r.notes,
  };
}

export const contractTool: ExtraTool = {
  feature: "safety",
  name: "contract_check",
  guidance:
    'contract_check reads a coin\'s contract: verified source or not, who controls it, powers its owner can still use on holders (mint, blacklist, pause, fees), and a dry-run transfer and sale for tax or a blocked sell. Use it for "can I sell?", "honeypot?", "can the dev mint?", "is it renounced?", "fake ticker?". Say what a power lets the owner do, never that they will. Unverified code is common: say it plainly, not as a warning.',
  build: (env) => {
    const safety = env.deps.safety;
    if (!safety) return null;
    return jsonTool(env, {
      name: "contract_check",
      description:
        "A coin's contract and market checks (rules safety-v0.1): code and proxy, verified source, owner, powers someone can still use, a dry-run transfer (tax, blocked) and a dry-run sale on Kalos, and whether its name or ticker copies a known token. Each check is ok, risk or unknown with one plain sentence. Kept up to a day.",
      inputSchema: z.object({ token: z.string().min(1).max(64).describe("The coin: token address (0x…) or $TICKER") }),
      run: async (i) => {
        const t = tokenOf(env.snap, i.token);
        if ("error" in t) return t;
        const s: SafetySummary = await safety(t.token);
        return { token: t.token, ...s };
      },
    });
  },
};

export const liquidityTool: ExtraTool = {
  feature: "safety",
  name: "liquidity",
  guidance:
    'liquidity shows a Kalos coin\'s pools: their value, who holds the liquidity (the creator, a burn address, others) and big removals. Use it for "is liquidity locked?" or "can the dev pull it?". Liquidity a wallet holds can be removed by that wallet; only liquidity at a burn address is locked for good.',
  build: (env) => {
    const liquidity = env.deps.liquidity;
    if (!liquidity) return null;
    return jsonTool(env, {
      name: "liquidity",
      description:
        "A Kalos coin's pools: value in HYPE, the biggest liquidity owners with their share (and whether that is the creator or a burn address), and removals of 20% or more. Ascend coins' pools are not covered by this tool.",
      inputSchema: z.object({ token: z.string().min(1).max(64).describe("The coin: token address (0x…) or $TICKER") }),
      run: (i) => {
        const t = tokenOf(env.snap, i.token);
        if ("error" in t) return t;
        const r = liquidity(t.token);
        if (!r) return { token: t.token, note: env.snap.ws.coins.get(lc(t.token))?.coin.market === "kalos" ? "no pool data yet" : "not a Kalos coin: this tool covers Kalos pools only" };
        return liquidityView(r);
      },
    });
  },
};
