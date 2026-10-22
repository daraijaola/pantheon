// One keeper round: find stakers whose boost changed, build the bundle Micheal's `keep` sends
// (route PNTH's fees, buy the basket) plus boost refreshes, simulate it on the live chain in order,
// and keep only the calls that would actually do something. Practice mode stops there and reports;
// live mode sends them one by one.
import { getAddress, isAddress, type Abi, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { z } from "zod";
import { effectsOf, registryAbi, routerAbi, stakingAbi, vaultAbi, type Effects } from "./chain.ts";
import type { Config } from "./config.ts";
import { batches, choosePokes, describe, useful, type Kind, type Names, type Simulated, type Staker } from "./plan.ts";
import type { State } from "./state.ts";

export type PlannedCall = { kind: Kind; address: Address; abi: Abi; functionName: string; args: readonly unknown[] };

/** Everything the keeper needs from Elysium. The real one is `createChain`; tests pass a fake. */
export interface KeeperChain {
  head(): Promise<bigint>;
  stakedSince(from: bigint, to: bigint): Promise<Address[]>;
  readStakers(accounts: readonly Address[]): Promise<Staker[]>;
  basketSymbols(): Promise<Map<string, string>>;
  /** One eth_simulateV1 request: the calls run in order and share the node's gas allowance (50M on Elysium). */
  simulate(calls: readonly PlannedCall[], sender: Address): Promise<Simulated[]>;
  gasPrice(): Promise<bigint>;
  balance(a: Address): Promise<bigint>;
  send(call: PlannedCall): Promise<{ hash: Hex; ok: boolean; effects: Effects; gasUsed: bigint }>;
}

/** Accounts the Passport service says changed (new tier, unlink, expiry) since a time. */
export type PokesFeed = (since: number) => Promise<{ accounts: Address[]; until: number }>;

/** msg.sender for practice-mode simulations: the calls are permissionless, so any address works. */
export const DRY_SENDER: Address = "0x000000000000000000000000000000000000bEEF";
/** Stakers checked per round, besides those the Passport feed names; the rest rotate in next rounds. */
export const SWEEP = 200;
/** Live mode stops sending below this balance (about 2,000 keeper rounds at Elysium's prices). */
export const MIN_GAS_BALANCE = 10n ** 15n;
/**
 * Elysium's gas limits (Arbitrum Nitro; read from ArbGasInfo and probed on Oct 22): one transaction may
 * use at most 32M gas, and one eth_simulateV1 request gets 50M in total, shared by its calls in order.
 * Once earlier calls have used that up, the node rejects the WHOLE request ("intrinsic gas too low").
 * That is what stopped every round from Oct 17: the round simulated run, rebalance and all its boost
 * refreshes in one request, and 187 refreshes at ~450k gas each needed ~66M.
 */
export const TX_GAS_LIMIT = 32_000_000n;
/**
 * The most gas the keeper plans for one call (as simulated). With the 50% send margin it stays well
 * inside the 32M limit. A batch of boost refreshes that needs more is split in two and tried again.
 * A refresh costs ~450k gas per staker on Oct 22 (it updates each of the 10 live reward streams), up
 * to ~1M once all 24 streams are live, so 10M is about 20 stakers today and 10 at worst.
 */
export const MAX_CALL_GAS = 10_000_000n;

export type Report = {
  at: string;
  mode: Config["mode"];
  head: string;
  stakers: number;
  checked: number;
  calls: Array<{ kind: Kind; worthSending: boolean; gas: string; lines: string[] }>;
  sent: Array<{ kind: Kind; tx: Hex; ok: boolean }>;
  cost: string;
  notes: string[];
};

export async function tick(d: {
  cfg: Config;
  chain: KeeperChain;
  pokes: PokesFeed;
  state: State;
  sender?: Address;
  now?: () => Date;
}): Promise<Report> {
  const { cfg, chain, state } = d;
  const dep = cfg.deployment;
  const notes: string[] = [];
  const head = await chain.head();

  // New stakers since the last round.
  const from = BigInt(state.stakedCursor);
  if (from <= head) {
    const known = new Set(state.stakers.map((a) => a.toLowerCase()));
    for (const a of await chain.stakedSince(from, head)) {
      if (known.has(a.toLowerCase())) continue;
      known.add(a.toLowerCase());
      state.stakers.push(a);
    }
    state.stakedCursor = (head + 1n).toString();
  }

  // Whose boost to check: everyone the Passport service flagged, plus the next slice of all stakers.
  let flagged: Address[] = [];
  try {
    const feed = await d.pokes(state.pokesSince);
    flagged = feed.accounts;
    state.pokesSince = feed.until;
  } catch (e) {
    notes.push(`Passport feed unavailable (${(e as Error).message}); checking stakers by rotation only`);
  }
  const slice = rotate(state.stakers, state.sweep, SWEEP);
  state.sweep = state.stakers.length ? (state.sweep + slice.length) % state.stakers.length : 0;
  const candidates = unique([...flagged, ...slice]);
  const stakers = candidates.length ? await chain.readStakers(candidates) : [];
  const toPoke = choosePokes(stakers, cfg.pokeRiseBps);

  // Simulate on the live chain in order, in requests small enough for the node (see TX_GAS_LIMIT):
  // the fee run and the basket buy together (the buy spends what the run delivers), then each batch
  // of boost refreshes on its own.
  const sender = d.sender ?? DRY_SENDER;
  const planned = await simulateGroup(
    chain,
    [
      { kind: "run", address: dep.pnthRouter, abi: routerAbi, functionName: "run", args: [] },
      { kind: "rebalance", address: dep.indexVault, abi: vaultAbi, functionName: "rebalance", args: [BigInt(cfg.basketK)] },
    ],
    sender,
    notes,
  );
  for (const list of batches(toPoke, cfg.pokeBatch)) planned.push(...(await planPokes(chain, dep.staking, list, sender, notes)));
  const [symbols, gasPrice] = await Promise.all([chain.basketSymbols(), chain.gasPrice()]);
  const names: Names = { usdc: dep.usdc, pnth: dep.pnth, symbols };
  const chosen = planned.filter(({ sim }) => useful(sim));
  const gas = chosen.reduce((s, { sim }) => s + sim.gasUsed, 0n);

  const report: Report = {
    at: (d.now ?? (() => new Date()))().toISOString(),
    mode: cfg.mode,
    head: head.toString(),
    stakers: state.stakers.length,
    checked: stakers.length,
    calls: planned.map(({ sim: s }) => ({ kind: s.kind, worthSending: useful(s), gas: s.gasUsed.toString(), lines: describe(s, names) })),
    sent: [],
    cost: `${formatHype(gas * gasPrice)} HYPE`,
    notes,
  };

  if (cfg.mode === "live" && chosen.length > 0) {
    const bal = await chain.balance(sender);
    if (bal < MIN_GAS_BALANCE) {
      notes.push(`keeper wallet has ${formatHype(bal)} HYPE, below ${formatHype(MIN_GAS_BALANCE)}: nothing sent (ask Micheal to top it up)`);
      return report;
    }
    for (const { call } of chosen) {
      try {
        const r = await chain.send(call);
        report.sent.push({ kind: call.kind, tx: r.hash, ok: r.ok });
      } catch (e) {
        notes.push(`${call.kind} not sent: ${(e as Error).message.split("\n")[0]}`);
      }
    }
  }
  return report;
}

type Planned = { call: PlannedCall; sim: Simulated };
const firstLine = (e: unknown) => (e as Error).message.split("\n")[0] ?? "unknown error";
const noEffects = (): Effects => ({ legs: [], deferred: [], buys: [], skips: [], streamed: [], poked: [] });

/**
 * One simulation request. If the node rejects it, its calls count as failed (so they are never sent)
 * and the round carries on: one bad request must not stop the whole round, as it did from Oct 17.
 */
async function simulateGroup(chain: KeeperChain, calls: PlannedCall[], sender: Address, notes: string[]): Promise<Planned[]> {
  try {
    const sims = await chain.simulate(calls, sender);
    return calls.map((call, i) => ({ call, sim: sims[i]! }));
  } catch (e) {
    const error = firstLine(e);
    notes.push(`the node would not simulate ${calls.map((c) => c.kind).join(" + ")} (${error}): not sent this round`);
    return calls.map((call) => ({ call, sim: { kind: call.kind, ok: false, gasUsed: 0n, effects: noEffects(), error } }));
  }
}

/**
 * Boost refreshes for `list`, each call simulated on its own and kept under MAX_CALL_GAS: a batch
 * that needs more (or runs out of gas) is split in half and tried again, down to one staker.
 */
async function planPokes(chain: KeeperChain, staking: Address, list: Address[], sender: Address, notes: string[]): Promise<Planned[]> {
  const call: PlannedCall = { kind: "poke", address: staking, abi: stakingAbi, functionName: "poke", args: [list] };
  const [one] = await simulateGroup(chain, [call], sender, notes);
  if (list.length > 1 && one!.sim.gasUsed > MAX_CALL_GAS) {
    const half = Math.ceil(list.length / 2);
    return [...(await planPokes(chain, staking, list.slice(0, half), sender, notes)), ...(await planPokes(chain, staking, list.slice(half), sender, notes))];
  }
  return [one!];
}

const unique = (l: readonly Address[]) => [...new Map(l.map((a) => [a.toLowerCase(), a])).values()];
function rotate<T>(l: readonly T[], start: number, n: number): T[] {
  if (l.length <= n) return [...l];
  return Array.from({ length: n }, (_, i) => l[(start + i) % l.length]!);
}
const formatHype = (wei: bigint) => (Number(wei) / 1e18).toFixed(6);

/** The Passport service's feed (GET /passport/pokes?since=), checked before use. */
export function passportFeed(api: string, fetchFn: typeof fetch = fetch): PokesFeed {
  const Feed = z.object({
    accounts: z.array(z.string().refine((a) => isAddress(a, { strict: false }))).transform((l) => l.map((a) => getAddress(a))),
    until: z.number().int().min(0),
  });
  return async (since) => {
    const res = await fetchFn(`${api}/passport/pokes?since=${since}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Feed.parse(await res.json());
  };
}

/**
 * Gas for a send: the estimate plus 50% (MetaMask's default buffer too). Staking and fee routing cost more when time has passed since
 * their last update (more to write), and the estimate runs on an earlier block than the transaction:
 * seen on a fork, an unstake estimated at 104,476 gas needed 136,040. Only gas used is paid for.
 * Never above Elysium's 32M per transaction: the node refuses a transaction that asks for more.
 */
export const withMargin = (estimate: bigint) => {
  const gas = (estimate * 3n) / 2n;
  return gas > TX_GAS_LIMIT ? TX_GAS_LIMIT : gas;
};

/** The real chain access, over viem. `wallet` is only given in live mode. */
export function createChain(client: PublicClient, cfg: Config, wallet?: WalletClient): KeeperChain {
  const dep = cfg.deployment;
  const STEP = 500_000n;
  return {
    head: () => client.getBlockNumber(),
    async stakedSince(from, to) {
      const out: Address[] = [];
      for (let a = from; a <= to; a += STEP) {
        const b = a + STEP - 1n < to ? a + STEP - 1n : to;
        const logs = await client.getContractEvents({ address: dep.staking, abi: stakingAbi, eventName: "Staked", fromBlock: a, toBlock: b, strict: true });
        for (const l of logs) out.push(l.args.account);
      }
      return out;
    },
    async readStakers(accounts) {
      const results = await client.multicall({
        allowFailure: false,
        contracts: accounts.flatMap((a) => [
          { address: dep.staking, abi: stakingAbi, functionName: "accounts", args: [a] } as const,
          { address: dep.staking, abi: stakingAbi, functionName: "workingOf", args: [a] } as const,
        ]),
      });
      return accounts.map((account, i) => {
        const acc = results[2 * i] as readonly [bigint, bigint, bigint, bigint, bigint];
        return { account, staked: acc[0], working: acc[2], next: results[2 * i + 1] as bigint };
      });
    },
    async basketSymbols() {
      const list = await client.readContract({ address: dep.constituentRegistry, abi: registryAbi, functionName: "active" });
      const out = new Map<string, string>();
      for (const c of list) {
        const sym = await client
          .readContract({ address: c.token, abi: [{ type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] }], functionName: "symbol" })
          .catch(() => "?");
        // Coin symbols are chosen by their creators: keep them short and printable in our logs.
        out.set(c.token.toLowerCase(), sym.replace(/[^\x20-\x7e]/g, "").slice(0, 16) || "?");
      }
      return out;
    },
    async simulate(calls, sender) {
      const { results } = await client.simulateCalls({
        account: sender,
        validation: false,
        calls: calls.map((c) => ({ to: c.address, abi: c.abi, functionName: c.functionName, args: c.args }) as never),
      });
      return calls.map((c, i) => {
        const r = results[i]!;
        const logs = (r.logs ?? []) as Array<{ address: Address; topics: Hex[]; data: Hex }>;
        const error = r.status === "failure" ? ((r.error as { shortMessage?: string })?.shortMessage ?? r.error?.message?.split("\n")[0]) : undefined;
        return {
          kind: c.kind,
          ok: r.status === "success",
          gasUsed: r.gasUsed,
          effects: effectsOf(logs, { router: dep.pnthRouter, vault: dep.indexVault, staking: dep.staking }),
          ...(error ? { error } : {}),
        };
      });
    },
    gasPrice: () => client.getGasPrice(),
    balance: (a) => client.getBalance({ address: a }),
    async send(call) {
      if (!wallet?.account) throw new Error("no keeper key loaded (practice mode)");
      const req = { address: call.address, abi: call.abi, functionName: call.functionName, args: call.args, account: wallet.account } as never;
      const gas = withMargin(await client.estimateContractGas(req));
      const hash = await wallet.writeContract({ ...(req as object), chain: client.chain, gas } as never);
      const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
      return {
        hash,
        ok: receipt.status === "success",
        gasUsed: receipt.gasUsed,
        effects: effectsOf(receipt.logs, { router: dep.pnthRouter, vault: dep.indexVault, staking: dep.staking }),
      };
    },
  };
}
