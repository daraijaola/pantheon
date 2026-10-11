// Scheduler (spec §7.2): random daily re-checks, downgrade now / upgrade after confirmation,
// renewals before expiry, relaying in batches, watching Unlinked, and pokes for the staking keeper.
import type { Address, Hex, LocalAccount } from "viem";
import { TIMING } from "./config.ts";
import type { ChallengeStore, PassportStore } from "./db.ts";
import type { HyperEvmReader } from "./evm/hyperevm.ts";
import type { HlClient } from "./hl/client.ts";
import { signAndStore, type Signed } from "./issue.ts";
import { confirmedLevel, type Level } from "./policy.ts";
import type { Relayer } from "./relayer.ts";
import type { RegistryReader } from "./registry.ts";
import { computePassport } from "./score.ts";
import { collectRecheck, recheckCost } from "./snapshot.ts";

export type SchedulerDeps = {
  chainId: number;
  challenges: ChallengeStore;
  store: PassportStore;
  hl: HlClient;
  evm: HyperEvmReader;
  registry: RegistryReader;
  attestor: LocalAccount;
  relayer?: Relayer | undefined;
  now?: () => number;
  random?: () => number;
  /** Re-checks per run, at most. */
  maxChecksPerRun?: number;
  /**
   * HL weight one run may spend (default 240 of the 800/min budget). A count cap alone is not enough:
   * six weekly full checks (162 each) would want 972, more than the whole budget, and stall the API.
   */
  maxWeightPerRun?: number;
  /** How far back the first Unlinked scan starts, when no cursor is stored yet. */
  initialLookbackBlocks?: bigint;
};

export type RunReport = {
  /** HL weight budgeted for this run's re-checks. */
  weight?: number;
  unlinked: number;
  forgotten: number;
  checked: number;
  signed: number;
  relayed: number;
  failed: number;
  errors: string[];
};

/** A failed relay is re-signed this soon (fresh issuedAt), never resubmitted (§7.2). */
export const RETRY_FAILED_RELAY_SEC = 5 * 60;
const LOG_CHUNK = 100_000n;
const CURSOR = "unlinked_cursor";
const LAST_RUN = "scheduler_last_run";

type Pending = Signed & { hlKey: Hex; account: Address; tierBefore: number };

export class Scheduler {
  #d: SchedulerDeps;
  #now: () => number;
  #timer: NodeJS.Timeout | undefined;
  #running = false;

  constructor(deps: SchedulerDeps) {
    this.#d = deps;
    this.#now = deps.now ?? Date.now;
  }

  /** Run every `intervalMs` (60 s polls Unlinked as §7.2 asks). Overlapping runs are skipped. */
  start(intervalMs = 60_000, onReport?: (r: RunReport) => void): void {
    const tick = async () => {
      if (this.#running) return;
      this.#running = true;
      try {
        onReport?.(await this.runOnce());
      } finally {
        this.#running = false;
      }
    };
    this.#timer = setInterval(() => void tick(), intervalMs);
    void tick();
  }

  stop(): void {
    clearInterval(this.#timer);
  }

  async runOnce(): Promise<RunReport> {
    const d = this.#d;
    const nowSec = Math.floor(this.#now() / 1000);
    const report: RunReport = { unlinked: 0, forgotten: 0, checked: 0, signed: 0, relayed: 0, failed: 0, errors: [] };

    d.challenges.purgeExpired(nowSec);
    try {
      report.unlinked = await this.#watchUnlinked(nowSec);
    } catch (e) {
      report.errors.push(`unlinked watch: ${message(e)}`);
    }
    report.forgotten = d.store.forgetUnlinked(nowSec - TIMING.forgetUnlinkedAfter);

    const pending: Pending[] = [];
    let weight = 0;
    let taken = 0;
    for (const b of d.store.dueBindings(nowSec, d.maxChecksPerRun ?? 6)) {
      const cost = recheckCost(b, nowSec);
      if (taken > 0 && weight + cost > (d.maxWeightPerRun ?? 240)) break; // the rest wait a minute
      weight += cost;
      taken++;
      try {
        const p = await this.#recheck(b, nowSec);
        report.checked++;
        if (p) pending.push(p);
      } catch (e) {
        // HL/HyperEVM/Elysium down: try this binding again in 5 minutes, change nothing.
        d.store.setNextCheck(b.hlKey, nowSec + RETRY_FAILED_RELAY_SEC);
        report.errors.push(`recheck: ${message(e)}`);
      }
    }
    report.weight = weight;
    report.signed = pending.length;
    if (pending.length > 0) await this.#relay(pending, nowSec, report);
    this.#expiryPokes(nowSec);
    d.store.setMeta(LAST_RUN, String(nowSec));
    return report;
  }

  async #recheck(b: ReturnType<PassportStore["dueBindings"]>[number], nowSec: number): Promise<Pending | null> {
    const d = this.#d;
    const { snapshot, full } = await collectRecheck(d.hl, d.evm, b, nowSec);
    const p = computePassport(snapshot, nowSec * 1000);
    // An account that can no longer link (e.g. it became a multi-sig) keeps its binding at tier 0.
    const current: Level = p.ok ? p : { tier: 0, stamps: 0 };
    if (full) d.store.updateCachedFacts(b.hlKey, { firstSeenMs: snapshot.firstSeenMs, genesis: b.genesis, vlm: snapshot.allTimeVolumeUsd, roleCheckedAt: nowSec });

    const onChain = await d.registry.passportOf(b.elysium);
    const existing = onChain.hlKey.toLowerCase() === b.hlKey.toLowerCase() ? onChain : null;
    const level = confirmedLevel(existing, current, d.store.checks(b.hlKey), nowSec);
    d.store.insertCheck(b.hlKey, { at: nowSec, scoreE8: p.ok ? p.scoreE8 : 0n, tier: current.tier, stamps: current.stamps });
    d.store.setNextCheck(b.hlKey, nowSec + TIMING.recheckBase + Math.floor((d.random ?? Math.random)() * TIMING.recheckJitter));

    const changed = existing !== null && (level.tier !== existing.tier || level.stamps !== existing.stamps);
    const renew = existing !== null && existing.expiry - nowSec < TIMING.renewBefore;
    // Not on chain yet (an earlier relay failed, or the user never submitted): submit it, but never
    // create a new binding at tier 0 (§6.2).
    const missing = existing === null && level.tier > 0;
    if (!changed && !renew && !missing) return null;

    const signed = await signAndStore(d, b.elysium, b.hlKey, level, nowSec);
    return { ...signed, hlKey: b.hlKey, account: b.elysium, tierBefore: existing && onChain.valid ? existing.tier : 0 };
  }

  async #relay(pending: Pending[], nowSec: number, report: RunReport): Promise<void> {
    const d = this.#d;
    if (!d.relayer) {
      report.errors.push(`no relayer configured: ${pending.length} attestation(s) left signed`);
      return;
    }
    let results;
    try {
      results = await d.relayer.submitMany(pending.map((p) => ({ attestation: p.attestation, signature: p.signature })));
    } catch (e) {
      results = pending.map(() => ({ ok: false as const, reason: message(e) }));
    }
    results.forEach((r, i) => {
      const p = pending[i]!;
      if (r.ok) {
        d.store.setAttestationStatus(p.id, "confirmed", r.txHash);
        if (p.attestation.tier !== p.tierBefore) d.store.pushPoke(p.account, "issued", nowSec);
        report.relayed++;
      } else {
        d.store.setAttestationStatus(p.id, "failed");
        d.store.setNextCheck(p.hlKey, nowSec + RETRY_FAILED_RELAY_SEC);
        report.failed++;
        report.errors.push(`relay: ${r.reason}`);
      }
    });
  }

  /** Follow Unlinked events from a stored cursor, in chunks; stop re-checking those bindings. */
  async #watchUnlinked(nowSec: number): Promise<number> {
    const d = this.#d;
    const head = await d.registry.blockNumber();
    const stored = d.store.getMeta(CURSOR);
    let from = stored !== undefined ? BigInt(stored) : head > (d.initialLookbackBlocks ?? 200_000n) ? head - (d.initialLookbackBlocks ?? 200_000n) : 0n;
    let count = 0;
    while (from <= head) {
      const to = from + LOG_CHUNK - 1n < head ? from + LOG_CHUNK - 1n : head;
      for (const ev of await d.registry.unlinkedEvents(from, to)) {
        if (d.store.markUnlinked(ev.account, ev.hlKey, nowSec)) {
          d.store.pushPoke(ev.account, "unlinked", nowSec);
          count++;
        }
      }
      from = to + 1n;
      d.store.setMeta(CURSOR, String(from));
    }
    return count;
  }

  /** Passports that ran out since the last run without a renewal: their boost just dropped (§6.3). */
  #expiryPokes(nowSec: number): void {
    const d = this.#d;
    const last = Number(d.store.getMeta(LAST_RUN) ?? nowSec);
    for (const r of d.store.latestPerActiveBinding()) {
      if (r.expiry > last && r.expiry <= nowSec) d.store.pushPoke(r.elysium, "expired", nowSec);
    }
  }
}

const message = (e: unknown) => (e instanceof Error ? e.message.split("\n")[0]! : String(e));
