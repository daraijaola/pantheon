// Test doubles: the live deployment's addresses, a config, and a fake chain whose answers each test sets.
import type { Address, Hex } from "viem";
import type { Effects } from "../src/chain.ts";
import type { Config, Deployment } from "../src/config.ts";
import type { KeeperChain, PlannedCall } from "../src/keeper.ts";
import type { Simulated, Staker } from "../src/plan.ts";

export const DEP: Deployment = {
  chainId: 99_801,
  pnth: "0x048aCeb334cb1835dc897a749C5985e169EAb1C5",
  pnthRouter: "0xE0Fb49DBDC3406cF1f175EeCABDFb282a7a98b66",
  indexVault: "0xE636003Feb05D0FB8f6016733C3d723446C9f221",
  constituentRegistry: "0xD8cEA0015E2C876ab5fa6D9178b46B57d65c6087",
  staking: "0x30c88fce1fAD545Df0fC603287f93F0f94076224",
  passportRegistry: "0x0Eb4A8eB47364Be9d18410AF2f850db92b807290",
  usdc: "0x4b4fb5C5794F0c821464956374cC5872D5F0f140",
  burnSink: "0xC889ac2f59A88afb3B2FB3f2C452DBa336fE5f0F",
};

export const cfg = (over: Partial<Config> = {}): Config => ({
  rpc: "http://127.0.0.1:1",
  passportApi: "http://127.0.0.1:2",
  mode: "dry",
  keyFile: "/nonexistent",
  intervalSec: 300,
  basketK: 5,
  pokeRiseBps: 200,
  pokeBatch: 2,
  fromBlock: 100n,
  stateFile: "/nonexistent/state.json",
  deployment: DEP,
  ...over,
});

export const addr = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}`;
export const none = (): Effects => ({ legs: [], deferred: [], buys: [], skips: [], streamed: [], poked: [] });

/** A fake chain: `effects` says what each kind of call does in simulation; everything is recorded. */
export function fakeChain(o: {
  head?: bigint;
  staked?: Address[];
  stakers?: Staker[];
  effects?: Partial<Record<PlannedCall["kind"], Effects>>;
  failing?: PlannedCall["kind"][];
  balance?: bigint;
}) {
  const log = { simulated: [] as PlannedCall[], sent: [] as PlannedCall[], stakedFrom: [] as bigint[], read: [] as Address[][] };
  const chain: KeeperChain = {
    head: async () => o.head ?? 1_000n,
    stakedSince: async (from) => (log.stakedFrom.push(from), o.staked ?? []),
    readStakers: async (accounts) => (log.read.push([...accounts]), (o.stakers ?? []).filter((s) => accounts.some((a) => a.toLowerCase() === s.account.toLowerCase()))),
    basketSymbols: async () => new Map(),
    simulate: async (calls) => {
      log.simulated.push(...calls);
      return calls.map((c): Simulated => {
        if (o.failing?.includes(c.kind)) return { kind: c.kind, ok: false, gasUsed: 30_000n, effects: none(), error: "reverted" };
        const e = o.effects?.[c.kind] ?? none();
        const poked = c.kind === "poke" ? (c.args[0] as Address[]).map((account) => ({ account, working: 1n })) : e.poked;
        return { kind: c.kind, ok: true, gasUsed: 100_000n, effects: { ...e, poked } };
      });
    },
    gasPrice: async () => 100_000_000n, // 0.1 gwei, Elysium's base fee
    balance: async () => o.balance ?? 10n ** 18n,
    send: async (call) => (log.sent.push(call), { hash: `0x${"ab".repeat(32)}` as Hex, ok: true, gasUsed: 100_000n, effects: none() }),
  };
  return { chain, log };
}
