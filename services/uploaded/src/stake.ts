// A wallet's stake, and exactly what unstaking would cost before it signs. The sums copy PantheonStaking,
// in whole numbers the way it does them. Four things the contract does that a person wouldn't guess:
// - requestUnstake restarts the time bonus on the whole stake, however small the amount unstaked.
// - cancelUnstake doesn't bring it back: it restarts the clock again.
// - Asking to unstake while something is already unlocking restarts the 3 days on all of it.
// - What earns is the stored working balance, which only moves when the account is touched. A bonus that
//   has grown since then isn't earning yet: anyone can `poke` the account to apply it. The keeper only
//   pokes bonuses that would fall, so `needsRefresh` is common.
import { formatEther, parseAbi, type Address, type PublicClient } from "viem";
import { NotReady } from "./holdings.ts";
import { Remembered } from "./remembered.ts";

const ONE = 10n ** 18n;
const DAY = 86_400n;
const AGE_RAMP = 30n * DAY;
const MAX_AGE_BONUS = 5n * 10n ** 17n;
const MAX_PASSPORT = 125n * 10n ** 16n;
const COOLDOWN = 3n * DAY;
/** Short: an unstake preview has to be close to what the wallet is about to sign. */
const TTL_MS = 10_000;

const stakingAbi = parseAbi([
  "function accounts(address) view returns (uint256 staked, uint256 cooling, uint256 working, uint64 coolEnd, uint64 stakeStart)",
  "function workingOf(address) view returns (uint256)",
]);
const passportAbi = parseAbi(["function multiplierOf(address) view returns (uint256)"]);
const clockAbi = parseAbi(["function getCurrentBlockTimestamp() view returns (uint256)"]);
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";

/** What the contract holds for a wallet, all read at the same moment. */
export type StakeState = {
  staked: bigint;
  cooling: bigint;
  /** The stored working balance: what's earning. */
  working: bigint;
  /** What it would be if the account were poked now. */
  workingNow: bigint;
  coolEnd: bigint;
  stakeStart: bigint;
  /** The Passport multiplier, 1e18 = 1.0×, capped as the contract caps it. */
  passport: bigint;
  /** The block's time, in seconds. */
  now: bigint;
};

export type StakeCalls = { read(wallet: string): Promise<StakeState> };

export function chainStake(client: Pick<PublicClient, "multicall">, addresses: { staking: string; passport: string }): StakeCalls {
  const staking = addresses.staking as Address;
  return {
    read: async (wallet) => {
      const account = wallet as Address;
      // One bundle, so everything comes from the same block. A Passport that can't be read counts as no
      // boost, as the contract treats it. batchSize 0 keeps the bundle one request (see holdings.ts).
      const [acct, workingNow, passport, clock] = await client.multicall({
        allowFailure: true,
        batchSize: 0,
        multicallAddress: MULTICALL3,
        contracts: [
          { address: staking, abi: stakingAbi, functionName: "accounts", args: [account] },
          { address: staking, abi: stakingAbi, functionName: "workingOf", args: [account] },
          { address: addresses.passport as Address, abi: passportAbi, functionName: "multiplierOf", args: [account] },
          { address: MULTICALL3, abi: clockAbi, functionName: "getCurrentBlockTimestamp" },
        ],
      });
      if (acct.status !== "success" || workingNow.status !== "success" || clock.status !== "success") throw new Error("staking contract couldn't be read");
      const [staked, cooling, working, coolEnd, stakeStart] = acct.result;
      const m = passport.status === "success" ? passport.result : ONE;
      return { staked, cooling, working, workingNow: workingNow.result, coolEnd: BigInt(coolEnd), stakeStart: BigInt(stakeStart), passport: m < ONE ? ONE : m > MAX_PASSPORT ? MAX_PASSPORT : m, now: clock.result };
    },
  };
}

/** The contract's time bonus, 1e18 = 1.0×. */
export function timeBonusAt(ageSeconds: bigint): bigint {
  const age = ageSeconds > AGE_RAMP ? AGE_RAMP : ageSeconds < 0n ? 0n : ageSeconds;
  return ONE + (age * MAX_AGE_BONUS) / AGE_RAMP;
}

/** The contract's working balance, rounding where it rounds. */
export function workingFor(staked: bigint, ageSeconds: bigint, passport: bigint): bigint {
  return (((staked * timeBonusAt(ageSeconds)) / ONE) * passport) / ONE;
}

/** A multiplier or share as a person reads it: 1.2345. Exact figures are in the raw amounts beside it. */
const rate = (x: bigint, base = ONE) => (base === 0n ? 1 : Number((x * 10_000n) / base) / 10_000);
const iso = (seconds: bigint) => new Date(Number(seconds) * 1000).toISOString();
const days = (seconds: bigint) => Number((seconds * 100n) / DAY) / 100;
export type Amount = { raw: string; amount: string };
const amount = (raw: bigint): Amount => ({ raw: raw.toString(), amount: formatEther(raw) });

export type StakeInfo = {
  wallet: string;
  network: "testnet" | "mainnet";
  readAt: string;
  staked: Amount;
  /** Asked to unstake: no longer earning. */
  cooling: Amount;
  coolEnd: string | null;
  canWithdraw: boolean;
  stakeStart: string | null;
  timeBonus: {
    now: number;
    max: 1.5;
    /** 0 to 1: how far along the 30 days. */
    progress: number;
    /** When it reaches 1.5×. Null with nothing staked. */
    fullAt: string | null;
  };
  passportBoost: number;
  /** What the whole stake is earning at, and what it would earn at if refreshed. */
  multiplier: { earning: number; ifRefreshed: number };
  /** True when a refresh (`poke`) would raise what this wallet earns. Anyone can do it. */
  needsRefresh: boolean;
};

export function describeStake(wallet: string, network: StakeInfo["network"], s: StakeState): StakeInfo {
  const active = s.staked > 0n;
  const age = active ? s.now - s.stakeStart : 0n;
  return {
    wallet,
    network,
    readAt: iso(s.now),
    staked: amount(s.staked),
    cooling: amount(s.cooling),
    coolEnd: s.cooling > 0n ? iso(s.coolEnd) : null,
    canWithdraw: s.cooling > 0n && s.now >= s.coolEnd,
    stakeStart: active ? iso(s.stakeStart) : null,
    timeBonus: {
      now: rate(timeBonusAt(age)),
      max: 1.5,
      progress: rate(age > AGE_RAMP ? AGE_RAMP : age < 0n ? 0n : age, AGE_RAMP),
      fullAt: active ? iso(s.stakeStart + AGE_RAMP) : null,
    },
    passportBoost: rate(s.passport),
    multiplier: { earning: rate(s.working, s.staked), ifRefreshed: rate(s.workingNow, s.staked) },
    needsRefresh: s.workingNow > s.working,
  };
}

export type UnstakePreview = {
  wallet: string;
  network: StakeInfo["network"];
  readAt: string;
  amount: Amount;
  /** What stays staked, and keeps earning. */
  stakedAfter: Amount;
  coolingAfter: Amount;
  /** When everything unlocking can be withdrawn. */
  coolEndAfter: string;
  /** True if this restarts the 3 days on PNTH that was already unlocking. */
  restartsCooldown: boolean;
  timeBonus: { before: number; after: number };
  /** Days of time bonus thrown away, on everything left staked too. */
  daysLost: number;
  /** The working balance if the wallet doesn't unstake, and the one it's left with. */
  working: { before: Amount; after: Amount };
  /**
   * The part of the loss that's only the bonus: what stays staked would have earned on this much more
   * working balance. As a share, of what that PNTH would have been earning.
   */
  bonusLost: { working: Amount; share: number };
};

export class UnstakeError extends Error {
  override name = "UnstakeError";
  readonly code: "ZERO_AMOUNT" | "TOO_MUCH";
  constructor(code: UnstakeError["code"]) {
    super(code);
    this.code = code;
  }
}

/** What the contract would do with this request, sent now. */
export function previewUnstake(wallet: string, network: StakeInfo["network"], s: StakeState, unstake: bigint): UnstakePreview {
  if (unstake <= 0n) throw new UnstakeError("ZERO_AMOUNT");
  if (unstake > s.staked) throw new UnstakeError("TOO_MUCH");
  const age = s.now - s.stakeStart;
  const left = s.staked - unstake;
  const kept = workingFor(left, age, s.passport); // what's left, if the bonus weren't reset
  const after = workingFor(left, 0n, s.passport);
  return {
    wallet,
    network,
    readAt: iso(s.now),
    amount: amount(unstake),
    stakedAfter: amount(left),
    coolingAfter: amount(s.cooling + unstake),
    coolEndAfter: iso(s.now + COOLDOWN),
    restartsCooldown: s.cooling > 0n,
    timeBonus: { before: rate(timeBonusAt(age)), after: 1 },
    daysLost: days(age > AGE_RAMP ? AGE_RAMP : age < 0n ? 0n : age),
    working: { before: amount(s.workingNow), after: amount(after) },
    bonusLost: { working: amount(kept - after), share: rate(kept - after, kept) },
  };
}

export class StakeReader {
  readonly #network: () => StakeInfo["network"] | null;
  readonly #state: Remembered<StakeState>;

  constructor(network: () => StakeInfo["network"] | null, calls: StakeCalls, opts: { now?: () => number; ttlMs?: number } = {}) {
    this.#network = network;
    this.#state = new Remembered((w) => calls.read(w), { ttlMs: opts.ttlMs ?? TTL_MS, ...(opts.now ? { now: opts.now } : {}) });
  }

  #known() {
    const network = this.#network();
    if (!network) throw new NotReady("no coins loaded yet");
    return network;
  }

  async read(wallet: string): Promise<StakeInfo> {
    const w = wallet.toLowerCase();
    return describeStake(w, this.#known(), await this.#state.get(w));
  }

  async preview(wallet: string, unstake: bigint): Promise<UnstakePreview> {
    const w = wallet.toLowerCase();
    return previewUnstake(w, this.#known(), await this.#state.get(w), unstake);
  }
}
