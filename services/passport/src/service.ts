// The Passport service's use cases (spec §5.3, §7, §8), independent of HTTP (api.ts maps them).
import { BaseError, getAddress, isAddress, type Address, type Hex, type LocalAccount } from "viem";
import { STAMP, TIER_MULTIPLIER, TIMING } from "./config.ts";
import { buildAttestation, signAttestation, type Attestation } from "./attest.ts";
import type { ChallengeStore, PassportStore } from "./db.ts";
import { EvmError, type HyperEvmReader } from "./evm/hyperevm.ts";
import { HlError, type HlClient } from "./hl/client.ts";
import { createChallenge, hlKeyOf, verifyLink, type ChallengeInput, type VerifyError, type VerifyInput } from "./link.ts";
import { confirmedLevel, type Level } from "./policy.ts";
import { HitCounter } from "./ratelimit.ts";
import { bindingConflict, type BindingConflict, type RegistryReader } from "./registry.ts";
import { computePassport, stampNames, type Reason } from "./score.ts";
import { collectSnapshot } from "./snapshot.ts";

/** Submits attestations on Elysium (P8). Without one, callers get the signed attestation to submit. */
export interface Relayer {
  submit(a: Attestation, sig: Hex): Promise<Hex>;
  balance(): Promise<bigint>;
}

export type ErrorCode =
  | "BAD_REQUEST"
  | "INVALID_ADDRESS"
  | "RATE_LIMITED"
  | "AGENT_WALLET"
  | "NOT_A_SIGNING_ACCOUNT"
  | "MULTISIG_UNSUPPORTED"
  | BindingConflict
  | VerifyError
  | "NOT_LINKED"
  | "UPSTREAM_UNAVAILABLE";

export type Fail = { ok: false; error: ErrorCode; detail?: string; retryAfterSec?: number };

export type Issued = {
  ok: true;
  tier: number;
  stamps: number;
  stampNames: string[];
  multiplier: string;
  expiry: number;
  attestation: Attestation;
  signature: Hex;
  txHash?: Hex;
};
export type NotIssued = { ok: true; tier: 0; reasons: Reason[] };

export type PassportView = {
  address: Address;
  valid: boolean;
  tier: number;
  stamps: number;
  stampNames: string[];
  multiplier: string;
  issuedAt: number;
  expiry: number;
  linkedAt: number;
  source: "chain";
};

export type StatsView = {
  linked: number;
  valid: number;
  byTier: Record<"1" | "2" | "3", number>;
  byStamp: Record<keyof typeof STAMP, number>;
  updatedAt: number;
};

export type ServiceDeps = {
  chainId: number;
  challenges: ChallengeStore;
  store: PassportStore;
  hl: HlClient;
  evm: HyperEvmReader;
  registry: RegistryReader;
  attestor: LocalAccount;
  pepper: Hex;
  relayer?: Relayer | undefined;
  /** Per-account limits of §8 (/verify 5/h per account, /refresh 1/10 min). */
  hits?: HitCounter;
  now?: () => number;
  random?: () => number;
};

const HOUR_MS = 3_600_000;
const PASSPORT_CACHE_MS = 30_000;
const STATS_CACHE_MS = 60_000;

/**
 * An uncached challenge costs 80 HL weight (userRole 60 + multi-sig 20). At §8's 10 challenges/min
 * one IP would spend the whole 800/min budget and stall everyone's /verify, so uncached lookups get
 * their own caps: per IP, and globally at 50% of the budget. Results are cached (§9).
 */
export const CHALLENGE_LOOKUPS = { perIpPerMin: 2, globalPerMin: 5, cacheMs: 10 * 60_000, cacheMax: 10_000 } as const;

const fail = (error: ErrorCode, detail?: string, retryAfterSec?: number): Fail => ({
  ok: false,
  error,
  ...(detail === undefined ? {} : { detail }),
  ...(retryAfterSec === undefined ? {} : { retryAfterSec }),
});

export class PassportService {
  readonly deps: ServiceDeps;
  #hits: HitCounter;
  #now: () => number;
  #passportCache = new Map<string, { at: number; view: PassportView }>();
  #roleCache = new Map<string, { at: number; role: Awaited<ReturnType<HlClient["userRole"]>>; multiSig: Awaited<ReturnType<HlClient["userToMultiSigSigners"]>> }>();
  #statsCache: { at: number; view: StatsView } | undefined;

  constructor(deps: ServiceDeps) {
    this.deps = deps;
    this.#now = deps.now ?? Date.now;
    this.#hits = deps.hits ?? new HitCounter(this.#now);
  }

  #nowSec(): number {
    return Math.floor(this.#now() / 1000);
  }

  /** POST /passport/challenge (§5.3 step 2). `ip` is the caller's address, for the lookup caps. */
  async challenge(input: ChallengeInput, ip = "local") {
    const d = this.deps;
    for (const field of ["elysiumAccount", "hyperliquidAccount"] as const) {
      if (!isAddress(input[field], { strict: false })) return fail("INVALID_ADDRESS", field);
    }
    const nowSec = this.#nowSec();
    const hl = getAddress(input.hyperliquidAccount);
    try {
      const conflict = await this.#conflict(getAddress(input.elysiumAccount), hlKeyOf(d.pepper, hl), nowSec);
      if (conflict) return conflict;

      const cached = this.#roleCache.get(hl);
      if (!cached || this.#now() - cached.at >= CHALLENGE_LOOKUPS.cacheMs) {
        for (const [key, limit] of [[`lookup:${ip}`, CHALLENGE_LOOKUPS.perIpPerMin], ["lookup:all", CHALLENGE_LOOKUPS.globalPerMin]] as const) {
          const wait = this.#hits.hit(key, limit, 60_000);
          if (wait > 0) return fail("RATE_LIMITED", "busy checking accounts, retry shortly", Math.ceil(wait / 1000));
        }
        const [role, multiSig] = await Promise.all([d.hl.userRole(hl), d.hl.userToMultiSigSigners(hl)]);
        if (this.#roleCache.size >= CHALLENGE_LOOKUPS.cacheMax) this.#roleCache.delete(this.#roleCache.keys().next().value!);
        this.#roleCache.set(hl, { at: this.#now(), role, multiSig });
      }
      const gate = this.#roleCache.get(hl)!;
      const c = await createChallenge(
        {
          store: d.challenges,
          registry: d.registry.address,
          chainId: d.chainId,
          hl: { userRole: async () => gate.role, userToMultiSigSigners: async () => gate.multiSig },
        },
        input,
        nowSec,
      );
      if (c.ok) return c;
      if (c.error === "INVALID_ADDRESS") return fail("INVALID_ADDRESS", c.field);
      if (c.error === "AGENT_WALLET") return fail("AGENT_WALLET", c.master ? `sign with your main account ${c.master}` : undefined);
      return fail(c.error);
    } catch (e) {
      return upstream(e);
    }
  }

  /** POST /passport/verify (§5.3 step 5). */
  async verify(input: VerifyInput & { relay?: boolean | undefined }): Promise<Issued | NotIssued | Fail> {
    const d = this.deps;
    const nowMs = this.#now();
    const nowSec = Math.floor(nowMs / 1000);

    const pending = /^0x[0-9a-fA-F]{64}$/.test(input.nonce) ? d.challenges.get(input.nonce as Hex) : undefined;
    if (pending) {
      for (const who of [pending.elysium, pending.hl]) {
        const wait = this.#hits.hit(`verify:${who.toLowerCase()}`, 5, HOUR_MS);
        if (wait > 0) return fail("RATE_LIMITED", "5 verifications per hour per account", Math.ceil(wait / 1000));
      }
    }

    const v = await verifyLink({ store: d.challenges, registry: d.registry.address, chainId: d.chainId }, input, nowSec);
    if (!v.ok) return fail(v.error);
    const hlKey = hlKeyOf(d.pepper, v.hyperliquidAccount);

    try {
      const conflict = await this.#conflict(v.elysiumAccount, hlKey, nowSec);
      if (conflict) return conflict;
      const snap = await collectSnapshot(d.hl, d.evm, v.hyperliquidAccount);
      const p = computePassport(snap, nowMs);
      if (!p.ok) return fail(p.error);

      const onChain = await d.registry.passportOf(v.elysiumAccount);
      const existing = onChain.hlKey.toLowerCase() === hlKey.toLowerCase() ? onChain : null;
      const level = confirmedLevel(existing, p, d.store.checks(hlKey), nowSec);
      d.store.insertCheck(hlKey, { at: nowSec, scoreE8: p.scoreE8, tier: p.tier, stamps: p.stamps });

      // Never create a NEW binding at tier 0 (§6.2); an existing one may be downgraded to 0.
      if (level.tier === 0 && !existing) return { ok: true, tier: 0, reasons: p.reasons };

      d.store.upsertBinding({
        hlKey,
        hl: v.hyperliquidAccount,
        elysium: v.elysiumAccount,
        linkedAt: nowSec,
        hlSig: v.hlSignature,
        elySig: v.elysiumSignature,
        firstSeenMs: snap.firstSeenMs,
        genesis: snap.hypeGenesis,
        roleCheckedAt: nowSec,
        nextCheckAt: this.#nextCheckAt(nowSec),
      });
      return await this.#issue(v.elysiumAccount, hlKey, level, input.relay === true, nowSec);
    } catch (e) {
      return upstream(e);
    }
  }

  /** POST /passport/refresh: re-check a linked account now (max 1 per 10 min), same 200 shape as verify. */
  async refresh(elysiumAccount: string): Promise<Issued | Fail> {
    const d = this.deps;
    if (!isAddress(elysiumAccount, { strict: false })) return fail("INVALID_ADDRESS", "elysiumAccount");
    const account = getAddress(elysiumAccount);
    const wait = this.#hits.hit(`refresh:${account.toLowerCase()}`, 1, 10 * 60_000);
    if (wait > 0) return fail("RATE_LIMITED", "1 refresh per 10 minutes", Math.ceil(wait / 1000));
    const binding = d.store.bindingByElysium(account);
    if (!binding) return fail("NOT_LINKED");

    const nowMs = this.#now();
    const nowSec = Math.floor(nowMs / 1000);
    try {
      const conflict = await this.#conflict(account, binding.hlKey, nowSec);
      if (conflict) return conflict;
      const snap = await collectSnapshot(d.hl, d.evm, binding.hl);
      const p = computePassport(snap, nowMs);
      // An account that can no longer link (e.g. it became a multi-sig) keeps its binding at tier 0.
      const current: Level = p.ok ? p : { tier: 0, stamps: 0 };
      const onChain = await d.registry.passportOf(account);
      const existing = onChain.hlKey.toLowerCase() === binding.hlKey.toLowerCase() ? onChain : null;
      const level = confirmedLevel(existing, current, d.store.checks(binding.hlKey), nowSec);
      d.store.insertCheck(binding.hlKey, { at: nowSec, scoreE8: p.ok ? p.scoreE8 : 0n, tier: current.tier, stamps: current.stamps });
      return await this.#issue(account, binding.hlKey, level, true, nowSec);
    } catch (e) {
      return upstream(e);
    }
  }

  /** GET /passport/:address: what the registry says, cached 30 s. */
  async passport(address: string): Promise<PassportView | Fail> {
    if (!isAddress(address, { strict: false })) return fail("INVALID_ADDRESS", "address");
    const account = getAddress(address);
    const hit = this.#passportCache.get(account);
    if (hit && this.#now() - hit.at < PASSPORT_CACHE_MS) return hit.view;
    try {
      const p = await this.deps.registry.passportOf(account);
      const tier = p.valid ? p.tier : 0;
      const stamps = p.valid ? p.stamps : 0;
      const view: PassportView = {
        address: account,
        valid: p.valid,
        tier,
        stamps,
        stampNames: stampNames(stamps),
        multiplier: (Number(p.multiplier / 10n ** 14n) / 10_000).toFixed(2),
        issuedAt: p.issuedAt,
        expiry: p.expiry,
        linkedAt: p.linkedAt,
        source: "chain",
      };
      this.#passportCache.set(account, { at: this.#now(), view });
      return view;
    } catch (e) {
      return upstream(e);
    }
  }

  /** GET /passport/stats, from the service's own records (signed attestations), cached 60 s. */
  stats(): StatsView {
    if (this.#statsCache && this.#now() - this.#statsCache.at < STATS_CACHE_MS) return this.#statsCache.view;
    const nowSec = this.#nowSec();
    const valid = this.deps.store.latestPerActiveBinding().filter((r) => r.expiry > nowSec);
    const byTier = { "1": 0, "2": 0, "3": 0 };
    const byStamp = Object.fromEntries(Object.keys(STAMP).map((k) => [k, 0])) as StatsView["byStamp"];
    for (const r of valid) {
      if (r.tier >= 1 && r.tier <= 3) byTier[String(r.tier) as "1" | "2" | "3"]++;
      for (const name of stampNames(r.stamps)) byStamp[name]++;
    }
    const view = { linked: this.deps.store.activeBindingCount(), valid: valid.length, byTier, byStamp, updatedAt: nowSec };
    this.#statsCache = { at: this.#now(), view };
    return view;
  }

  /** GET /health (§8, §10). */
  async health() {
    const d = this.deps;
    let lastBlock: string | null = null;
    let relayerBalance: string | null = null;
    let ok = true;
    try {
      lastBlock = (await d.registry.blockNumber()).toString();
    } catch {
      ok = false;
    }
    if (d.relayer) {
      try {
        const wei = await d.relayer.balance();
        relayerBalance = wei.toString();
        if (wei < 10n ** 16n) ok = false; // < 0.01 HYPE (§10 alert)
      } catch {
        ok = false;
      }
    }
    return { ok, hlBudgetLeft: d.hl.limiter.available(), evmBudgetLeft: d.evm.limiter.available(), relayerBalance, registry: d.registry.address, lastBlock };
  }

  async #conflict(account: Address, hlKey: Hex, nowSec: number): Promise<Fail | null> {
    const c = await bindingConflict(this.deps.registry, account, hlKey, nowSec);
    if (!c) return null;
    return c.until === undefined ? fail(c.conflict) : fail(c.conflict, `rebindable at ${c.until}`, Math.max(0, c.until - nowSec));
  }

  /** Re-checks land at a random moment 12–36 h out (§7.2), so balances cannot be parked for them. */
  #nextCheckAt(nowSec: number): number {
    return nowSec + TIMING.recheckBase + Math.floor((this.deps.random ?? Math.random)() * TIMING.recheckJitter);
  }

  async #issue(account: Address, hlKey: Hex, level: Level, relay: boolean, nowSec: number): Promise<Issued> {
    const d = this.deps;
    const lastIssuedAt = Math.max(d.store.lastIssuedAt(account), await d.registry.lastIssuedAt(account));
    const a = buildAttestation({ account, hlKey, tier: level.tier, stamps: level.stamps, lastIssuedAt }, nowSec, d.chainId);
    const signature = await signAttestation(d.attestor, d.registry.address, a);
    const id = d.store.insertAttestation({
      elysium: account,
      hlKey,
      tier: a.tier,
      stamps: a.stamps,
      issuedAt: a.issuedAt,
      expiry: a.expiry,
      deadline: a.deadline,
      sig: signature,
      txHash: null,
      status: "signed",
    });
    this.#passportCache.delete(account);
    this.#statsCache = undefined;

    let txHash: Hex | undefined;
    if (relay && d.relayer) {
      try {
        txHash = await d.relayer.submit(a, signature);
        d.store.setAttestationStatus(id, "submitted", txHash);
      } catch {
        // The caller still gets the signed attestation and can submit it; P8 retries with a fresh one.
        d.store.setAttestationStatus(id, "failed");
      }
    }
    return {
      ok: true,
      tier: a.tier,
      stamps: a.stamps,
      stampNames: stampNames(a.stamps),
      multiplier: TIER_MULTIPLIER[a.tier as 0 | 1 | 2 | 3],
      expiry: a.expiry,
      attestation: a,
      signature,
      ...(txHash === undefined ? {} : { txHash }),
    };
  }
}

/** HL, HyperEVM or Elysium (registry reads go through viem) unreachable: 503, never a wrong answer. */
function upstream(e: unknown): Fail {
  if (e instanceof HlError || e instanceof EvmError) return fail("UPSTREAM_UNAVAILABLE", e.message);
  if (e instanceof BaseError) return fail("UPSTREAM_UNAVAILABLE", `Elysium: ${e.shortMessage}`);
  throw e;
}

