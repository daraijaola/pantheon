// Shared test wiring: the real PassportService + API over the fake HL /info and fake HyperEVM,
// with fixture accounts re-homed to keys we control (anvil's public test mnemonic).
import { BaseError, type Address, type Hex } from "viem";
import { generatePrivateKey, mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { buildApp } from "../src/api.ts";
import { openDatabase, PassportStore, SqliteChallengeStore } from "../src/db.ts";
import { HyperEvmReader } from "../src/evm/hyperevm.ts";
import { HlClient } from "../src/hl/client.ts";
import { HitCounter, WeightLimiter } from "../src/ratelimit.ts";
import type { OnChainPassport, RegistryReader } from "../src/registry.ts";
import type { Attestation } from "../src/attest.ts";
import type { RelayItem, RelayResult, Relayer } from "../src/relayer.ts";
import { Scheduler } from "../src/scheduler.ts";
import { PassportService } from "../src/service.ts";
import { mockHyperEvm, rateFromFixture, walletFromFixture } from "./mockEvm.ts";
import { loadFixtures, startMockHl, type Fixture } from "./mockHl.ts";

export const MNEMONIC = "test test test test test test test test test test test junk";
export const key = (i: number) => mnemonicToAccount(MNEMONIC, { addressIndex: i });
export const HL_T2 = key(1); // plays the staker100 fixture: tier 2, stamps 189
export const ELY = key(2);
export const AGENT = key(3); // an API wallet of HL_T2
export const HL_EMPTY = key(4); // plays the `empty` fixture: tier 0
export const ELY2 = key(5);
export const HL_T1 = key(6); // plays the `small` fixture: tier 1
export const NOW_MS = 1_791_681_994_068; // staker100 capturedAtMs
export const ZERO_KEY = `0x${"00".repeat(32)}` as Hex;

/** A RegistryReader backed by maps; `apply` mimics a successful submit. */
export class FakeRegistry implements RegistryReader {
  readonly address = "0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f" as Address;
  passports = new Map<string, OnChainPassport>();
  holders = new Map<string, Address>();
  rebind = new Map<string, number>();
  last = new Map<string, number>();
  events: Array<{ account: Address; hlKey: Hex; blockNumber: bigint }> = [];
  head = 1n;
  down = false;
  nowSec: () => number;
  constructor(nowSec: () => number) {
    this.nowSec = nowSec;
  }

  async passportOf(account: Address) {
    if (this.down) throw new BaseError("rpc down");
    const p = this.passports.get(account.toLowerCase()) ?? { hlKey: ZERO_KEY, tier: 0, stamps: 0, issuedAt: 0, expiry: 0, linkedAt: 0 };
    const valid = p.hlKey !== ZERO_KEY && this.nowSec() < p.expiry;
    const multiplier = valid ? [10n ** 18n, 11n * 10n ** 17n, 12n * 10n ** 17n, 125n * 10n ** 16n][p.tier]! : 10n ** 18n;
    return { ...p, valid, multiplier };
  }
  async accountOfHlKey(hlKey: Hex) {
    return this.holders.get(hlKey.toLowerCase()) ?? ("0x0000000000000000000000000000000000000000" as Address);
  }
  async rebindableAt(hlKey: Hex) {
    return this.rebind.get(hlKey.toLowerCase()) ?? 0;
  }
  async lastIssuedAt(account: Address) {
    return this.last.get(account.toLowerCase()) ?? 0;
  }
  async blockNumber() {
    if (this.down) throw new BaseError("rpc down");
    return this.head;
  }
  async unlinkedEvents(from: bigint, to: bigint) {
    return this.events.filter((e) => e.blockNumber >= from && e.blockNumber <= to);
  }
  /** What `unlink()` does on chain: clear the passport, start the cooldown, log Unlinked. */
  unlink(account: Address) {
    const p = this.passports.get(account.toLowerCase())!;
    this.passports.delete(account.toLowerCase());
    this.holders.delete(p.hlKey.toLowerCase());
    this.rebind.set(p.hlKey.toLowerCase(), this.nowSec() + 7 * 86_400);
    this.events.push({ account, hlKey: p.hlKey, blockNumber: ++this.head });
  }
  apply(a: { account: Address; hlKey: Hex; tier: number; stamps: number; issuedAt: number; expiry: number }) {
    const prev = this.passports.get(a.account.toLowerCase());
    const linkedAt = prev && prev.hlKey === a.hlKey ? prev.linkedAt : this.nowSec();
    this.passports.set(a.account.toLowerCase(), { hlKey: a.hlKey, tier: a.tier, stamps: a.stamps, issuedAt: a.issuedAt, expiry: a.expiry, linkedAt });
    this.holders.set(a.hlKey.toLowerCase(), a.account);
    this.last.set(a.account.toLowerCase(), a.issuedAt);
  }
}

/** A relayer that "mines" straight into a FakeRegistry; `failNext` makes the next N submits fail. */
export function fakeRelayer(registry: FakeRegistry) {
  const r = {
    failNext: 0,
    submitted: [] as Attestation[],
    async submit(a: Attestation): Promise<Hex> {
      const [res] = await r.submitMany([{ attestation: a, signature: "0x" }]);
      if (!res!.ok) throw new Error(res!.reason);
      return res!.txHash;
    },
    async submitMany(items: RelayItem[]): Promise<RelayResult[]> {
      return items.map(({ attestation }) => {
        if (r.failNext > 0) {
          r.failNext--;
          return { ok: false, reason: "simulated revert" };
        }
        registry.apply(attestation);
        r.submitted.push(attestation);
        return { ok: true, txHash: `0x${"cd".repeat(32)}` as Hex };
      });
    },
    balance: async () => 10n ** 18n,
  };
  return r satisfies Relayer;
}

/** Fixture accounts re-homed: same HL data, but at addresses whose keys the tests hold. */
export function rehomedFixtures(): Record<string, Fixture> {
  const fx = loadFixtures();
  const at = (name: string, address: Address, patch: Partial<Fixture> = {}) => ({ ...fx[name]!, address: address.toLowerCase(), ...patch });
  return {
    empty: fx.empty!,
    t2: at("staker100", HL_T2.address),
    t1: at("small", HL_T1.address),
    zero: at("empty", HL_EMPTY.address),
    agent: at("agent", AGENT.address, { userRole: { role: "agent", data: { user: HL_T2.address.toLowerCase() } } }),
  };
}

export async function harness(
  opts: { relayer?: Relayer | ((r: FakeRegistry) => Relayer); registry?: RegistryReader; attestorKey?: Hex; nowMs?: number } = {},
) {
  const fixtures = rehomedFixtures();
  const hlServer = await startMockHl(fixtures);
  const wallets = Object.fromEntries(Object.values(fixtures).map((f) => [f.address, walletFromFixture(f)]));
  const chain = mockHyperEvm(wallets);
  chain.state.rate = rateFromFixture(fixtures.t2!);
  const clock = { ms: opts.nowMs ?? NOW_MS };
  const now = () => clock.ms;
  const fake = new FakeRegistry(() => Math.floor(clock.ms / 1000));
  const registry = opts.registry ?? fake;
  const db = openDatabase(":memory:");
  const attestorKey = opts.attestorKey ?? generatePrivateKey();
  const relayer = typeof opts.relayer === "function" ? opts.relayer(fake) : opts.relayer;
  const service = new PassportService({
    chainId: 99801,
    challenges: new SqliteChallengeStore(db),
    store: new PassportStore(db),
    hl: new HlClient({ url: hlServer.url, limiter: new WeightLimiter(100_000), sleep: async () => {}, retryDelaysMs: [1, 1, 1] }),
    evm: new HyperEvmReader({ client: chain.client, limiter: new WeightLimiter(1_000), sleep: async () => {} }),
    registry,
    attestor: privateKeyToAccount(attestorKey),
    pepper: `0x${"42".repeat(32)}`,
    relayer,
    hits: new HitCounter(now),
    now,
    random: () => 0.5,
  });
  const app = buildApp(service, { hits: new HitCounter(now) });
  await app.ready();
  return {
    app,
    service,
    registry: fake,
    clock,
    hlServer,
    chain,
    db,
    attestor: privateKeyToAccount(attestorKey),
    fixtures,
    relayer,
    /** A scheduler over the same state as the API. */
    scheduler: (maxChecksPerRun = 6, maxWeightPerRun = 240) =>
      new Scheduler({ ...service.deps, now, random: () => 0.5, maxChecksPerRun, maxWeightPerRun }),
    async close() {
      await app.close();
      await hlServer.close();
    },
  };
}
