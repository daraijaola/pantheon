// Follows PANTHEON's contracts: on each poll it reads new events since its cursor, the times of their
// blocks, and the current values the site shows (burn sink, basket, staking, basket proposals). What it
// has read is saved, so a restart picks up where it stopped instead of re-reading the chain.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Address, PublicClient } from "viem";
import { registryAbi, stakingAbi, toRec, tokenAbi, type Contracts, type Rec } from "./chain.ts";
import type { Config } from "./config.ts";
import type { Live } from "./views.ts";

export type Saved = { version: 1; cursor: string; records: Rec[]; blockTimes: Record<string, number> };

export function loadSaved(path: string, fromBlock: bigint): Saved {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { version: 1, cursor: fromBlock.toString(), records: [], blockTimes: {} };
  }
  const s = JSON.parse(text) as Saved;
  if (s.version !== 1 || !/^\d+$/.test(s.cursor) || !Array.isArray(s.records)) throw new Error(`indexer state ${path} is damaged`);
  return s;
}

/** Temporary file, then rename: a crash never leaves a half-written state. */
export function save(path: string, s: Saved): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(s));
  renameSync(`${path}.tmp`, path);
}

/** Coin symbols are chosen by their creators: keep them short and printable. */
export const cleanSymbol = (s: string) => s.replace(/[^\x20-\x7e]/g, "").trim().slice(0, 16) || "?";

const STEP = 500_000n;

export class Indexer {
  readonly client: PublicClient;
  readonly cfg: Config;
  readonly contracts: Contracts;
  saved: Saved;
  live: Live | null = null;
  #tokens: Live["tokens"] = {};

  constructor(client: PublicClient, cfg: Config, saved: Saved) {
    this.client = client;
    this.cfg = cfg;
    this.saved = saved;
    const d = cfg.deployment;
    this.contracts = { router: d.pnthRouter, vault: d.indexVault, registry: d.constituentRegistry, staking: d.staking };
  }

  /** One poll: new events, their block times, then the current values. Returns how many events were added. */
  async poll(): Promise<number> {
    const head = await this.client.getBlockNumber();
    const added: Rec[] = [];
    for (let from = BigInt(this.saved.cursor); from <= head; from += STEP) {
      const to = from + STEP - 1n < head ? from + STEP - 1n : head;
      const logs = await this.client.getLogs({ address: Object.values(this.contracts), fromBlock: from, toBlock: to });
      for (const l of logs) {
        const r = toRec(l, this.contracts);
        if (r) added.push(r);
      }
    }
    for (const r of added) {
      const key = String(r.block);
      if (this.saved.blockTimes[key] === undefined) {
        this.saved.blockTimes[key] = Number((await this.client.getBlock({ blockNumber: BigInt(r.block) })).timestamp);
      }
      r.at = this.saved.blockTimes[key];
    }
    const seen = new Set(this.saved.records.map((r) => `${r.tx}:${r.logIndex}`));
    for (const r of added) if (!seen.has(`${r.tx}:${r.logIndex}`)) this.saved.records.push(r);
    this.saved.records.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
    this.saved.cursor = (head + 1n).toString();
    this.live = await this.#readLive(head);
    return added.length;
  }

  async #readLive(head: bigint): Promise<Live> {
    const d = this.cfg.deployment;
    const c = this.client;
    const [pnthSupply, burnSink, vaultUsdc, totalStaked, totalWorking, rewardTokens, activeId, count] = await c.multicall({
      allowFailure: false,
      contracts: [
        { address: d.pnth, abi: tokenAbi, functionName: "totalSupply" },
        { address: d.pnth, abi: tokenAbi, functionName: "balanceOf", args: [d.burnSink] },
        { address: d.usdc, abi: tokenAbi, functionName: "balanceOf", args: [d.indexVault] },
        { address: d.staking, abi: stakingAbi, functionName: "totalStaked" },
        { address: d.staking, abi: stakingAbi, functionName: "totalWorking" },
        { address: d.staking, abi: stakingAbi, functionName: "rewardTokens" },
        { address: d.constituentRegistry, abi: registryAbi, functionName: "activeId" },
        { address: d.constituentRegistry, abi: registryAbi, functionName: "proposalCount" },
      ],
    });
    const raw = Number(count)
      ? await c.multicall({
          allowFailure: false,
          contracts: Array.from({ length: Number(count) }, (_, i) => ({ address: d.constituentRegistry, abi: registryAbi, functionName: "proposal", args: [BigInt(i)] }) as const),
        })
      : [];
    const proposals = raw.map(([p, list], id) => ({
      id,
      eta: Number(p.eta),
      vetoed: p.vetoed,
      executed: p.executed,
      scoreRoot: p.scoreRoot,
      methodologyURI: p.methodologyURI,
      list: list.map((x) => ({ poolId: x.poolId, token: x.token, weightBps: x.weightBps, perRunCap: x.perRunCap.toString() })),
    }));

    // Names for every token the site may show: PNTH, USDC, basket coins, reward tokens.
    const tokens = new Set<string>([d.pnth, d.usdc, ...rewardTokens, ...proposals.flatMap((p) => p.list.map((x) => x.token))].map((a) => a.toLowerCase()));
    for (const r of this.saved.records) if ("token" in r) tokens.add(r.token.toLowerCase());
    const unknown = [...tokens].filter((t) => !this.#tokens[t]) as Address[];
    if (unknown.length) {
      const res = await c.multicall({
        allowFailure: true,
        contracts: unknown.flatMap((t) => [
          { address: t, abi: tokenAbi, functionName: "symbol" } as const,
          { address: t, abi: tokenAbi, functionName: "decimals" } as const,
        ]),
      });
      unknown.forEach((t, i) => {
        const sym = res[2 * i]!;
        const dec = res[2 * i + 1]!;
        // A token whose symbol or decimals can't be read is retried next poll, never guessed for good.
        if (sym.status === "success" && dec.status === "success") this.#tokens[t] = { symbol: cleanSymbol(String(sym.result)), decimals: Number(dec.result) };
      });
    }
    return {
      block: head.toString(),
      readAt: Math.floor(Date.now() / 1000),
      pnthSupply: pnthSupply.toString(),
      burnSink: burnSink.toString(),
      vaultUsdc: vaultUsdc.toString(),
      totalStaked: totalStaked.toString(),
      totalWorking: totalWorking.toString(),
      rewardTokens: [...rewardTokens],
      activeId: Number(activeId),
      proposals,
      tokens: { ...this.#tokens },
    };
  }
}


