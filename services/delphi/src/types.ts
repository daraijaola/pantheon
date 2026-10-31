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
  /**
   * Where the coin trades. "ascend": launched on Ascend's launchpad (the default). "kalos": a token in
   * Kalos's Uniswap-V3-style pools, where the "launch" is its first pool's first liquidity and the
   * creator is whoever deployed the token contract.
   */
  market?: Market;
  /** Total supply in the token's smallest unit. Unset: Ascend's fixed TOTAL_SUPPLY. */
  supply?: bigint;
  /** The token's decimals. Unset: 18, like every Ascend coin. */
  decimals?: number;
  /**
   * Set when only recent history was read (a token too busy to read in full): the first block read.
   * Wash trading and holders then describe that window, not the whole life of the coin.
   */
  windowFrom?: bigint;
};

export type Market = "ascend" | "kalos";

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
  /** Which rules profile applies (config.ts Network). Unset: mainnet, the strict one. */
  network?: "testnet" | "mainnet";
  /**
   * What DELPHI knows a wallet is, with the evidence in plain words (v0.5): a project's own wallet, a
   * fee or buyback sink, an outside whale holding many coins. Used to say who holds or trades, never to
   * hide anything: a role explains a pattern, it does not erase it.
   */
  roles?: ReadonlyMap<string, WalletRole>;
  /**
   * Contracts that are not pools (staking, lockers, faucets…). They are in `system` too, so they are
   * never holders and never link wallets; this list lets a report say how much they hold.
   */
  contracts?: ReadonlySet<string>;
  /**
   * Token balances read from the token itself (balanceOf, address lowercase → amount), for a coin whose
   * transfers were read only in windows (see Coin.windowFrom): balances can't be replayed from part of
   * the history. Covers the addresses seen in those windows plus the creator, deployer and LP owners.
   * Unset: balances are replayed from `transfers`.
   */
  holdings?: ReadonlyMap<string, bigint>;
};

export type Severity = "info" | "watch" | "flag";

export type WalletRole = { kind: "project" | "sink" | "whale"; says: string };

export type Finding = {
  detector: "bundle" | "wash" | "concentration";
  severity: Severity;
  /** One plain-English sentence a non-developer can check against the evidence. */
  summary: string;
  metrics: Record<string, number | string>;
  evidence: Array<{ what: string; tx: Hex }>;
};

export type Verdict = "CLEAN" | "WATCH" | "FLAG" | "NOT_ENOUGH_DATA";
