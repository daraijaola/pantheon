// The data DELPHI works on. Everything is derived from public chain and explorer data.
import type { Address, Hex } from "viem";

export type Coin = {
  token: Address;
  poolId: Hex;
  tokenIs0: boolean;
  /** The creator role named at launch (Launched.creator). */
  creator: Address;
  /** Who sent the launch transaction (may differ from the creator role). */
  launcher: Address;
  launchTx: Hex;
  launchBlock: bigint;
  launchTime: number;
  devBuyTokens: bigint;
  name: string | null;
  symbol: string | null;
};

export type Trade = {
  tx: Hex;
  block: bigint;
  logIndex: number;
  time: number;
  side: "buy" | "sell";
  /** The wallet that sent the transaction (it paid for a buy, or sold). */
  trader: Address;
  /**
   * The wallet whose token balance the trade changed: where a buy's tokens went, or where a sell's
   * came from. Usually the trader; sometimes another wallet ("bought for" / "sold for").
   */
  holder: Address;
  /** Token amount (18 decimals) and quote amount (in the pool's other currency), both positive. */
  tokens: bigint;
  quote: bigint;
  /** The pool it traded in. */
  pool: Hex;
  /** Traded in a pool outside Ascend (same pool manager, no Ascend hook, no Ascend fee split). */
  outside: boolean;
};

export type TokenTransfer = {
  tx: Hex;
  block: bigint;
  logIndex: number;
  from: Address;
  to: Address;
  value: bigint;
};

/**
 * Native HYPE received by a wallet from another address (its gas came from somewhere). `kind` (v0.3):
 * - "transfer" (the default): sent straight from the funder's wallet;
 * - "multisend": paid by a contract whose job is sending HYPE to many addresses (like Disperse), in a
 *   call the funder made, so it is the funder's own money and counts like a transfer;
 * - "payout": any other contract paid it inside a call the funder made: a sale, a game win, a refund.
 *   It links no one, unless the funder is the coin's own creator or launcher.
 */
export type FundingKind = "transfer" | "multisend" | "payout";
export type Funding = { wallet: Address; funder: Address; value: bigint; tx: Hex; time: number; kind?: FundingKind };

export type LinkReason = "shared-funder" | "funded-by" | "token-pass" | "bought-for" | "sold-for" | "is-creator";

/** Why two wallets are treated as one actor; `evidence` is the transaction(s) that show it. */
export type Link = { a: Address; b: Address; reason: LinkReason; via?: Address; evidence: Hex[] };

/** Everything the detectors need about one coin. */
export type CoinData = {
  coin: Coin;
  trades: Trade[];
  transfers: TokenTransfer[];
  links: Link[];
  /** Infrastructure addresses for this coin (vault, routers, treasuries, burn sink…). */
  system: ReadonlySet<string>;
  /** Wallets whose funding history could not be read: funding links may be incomplete. */
  fundingMissing: number;
  /**
   * Contracts that are not pools (staking, lockers, faucets…). They are in `system` too, so they are
   * never holders and never link wallets; this list lets a report say how much they hold.
   */
  contracts?: ReadonlySet<string>;
};

export type Severity = "info" | "watch" | "flag";

export type Finding = {
  detector: "bundle" | "wash" | "concentration";
  severity: Severity;
  /** One plain-English sentence a non-developer can check against the evidence. */
  summary: string;
  metrics: Record<string, number | string>;
  evidence: Array<{ what: string; tx: Hex }>;
};

export type Verdict = "CLEAN" | "WATCH" | "FLAG" | "NOT_ENOUGH_DATA";
