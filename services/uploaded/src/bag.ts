// A wallet's bag: what it holds, with DELPHI's verdict on each coin, worst first. Coins aren't cached
// here, so a verdict is always the latest even while the holdings are remembered. The counts are plain
// coin counts for the screen to use: "not read yet" and "too new to judge" are never counted as clean,
// and `complete` is false if any coin couldn't be read.
import type { FreshChecks } from "./fresh.ts";
import type { Holding, Holdings, HoldingsReader } from "./holdings.ts";
import type { CoinVerdict, UnknownCoin, Verdicts } from "./verdicts.ts";

type Verdict = CoinVerdict["verdict"] | UnknownCoin["verdict"];

export type BagCoin = Holding & {
  verdict: Verdict;
  reason: string;
  /** Every claim, each with the transactions behind it. Empty for a coin DELPHI hasn't read. */
  findings: CoinVerdict["findings"];
  notes: string[];
  reportUrl: string | null;
  disputeUrl: string | null;
  scannedAt: string | null;
  stale: boolean;
};

export type Bag = {
  wallet: string;
  network: Holdings["network"];
  readAt: string;
  coins: BagCoin[];
  counts: Record<Verdict, number>;
  /** Coins that couldn't be read: unknown, not zero. */
  unread: string[];
  /** True when every coin was read. */
  complete: boolean;
  /** True while a fresh read is running that may change a verdict here. */
  checking: boolean;
};

const WORST_FIRST: readonly Verdict[] = ["FLAG", "WATCH", "UNKNOWN", "NOT_ENOUGH_DATA", "CLEAN"];

export function buildBag(h: Holdings, get: (token: string) => CoinVerdict | UnknownCoin, ask: (coin: CoinVerdict | UnknownCoin) => boolean = () => false): Bag {
  const counts = Object.fromEntries(WORST_FIRST.map((v) => [v, 0])) as Record<Verdict, number>;
  let checking = false;
  const coins = h.holdings.map((holding): BagCoin => {
    const v = get(holding.token);
    counts[v.verdict] += 1;
    checking = ask(v) || checking;
    if (!v.known) return { ...holding, verdict: v.verdict, reason: v.reason, findings: [], notes: [], reportUrl: null, disputeUrl: null, scannedAt: null, stale: false };
    return { ...holding, verdict: v.verdict, reason: v.reason, findings: v.findings, notes: v.notes, reportUrl: v.reportUrl, disputeUrl: v.disputeUrl, scannedAt: v.scannedAt, stale: v.stale };
  });
  coins.sort((a, b) => WORST_FIRST.indexOf(a.verdict) - WORST_FIRST.indexOf(b.verdict));
  return { wallet: h.wallet, network: h.network, readAt: h.readAt, coins, counts, unread: h.unread, complete: h.unread.length === 0, checking };
}

export class BagReader {
  readonly #holdings: Pick<HoldingsReader, "read">;
  readonly #verdicts: Pick<Verdicts, "get">;
  readonly #fresh: Pick<FreshChecks, "ask"> | undefined;

  constructor(holdings: Pick<HoldingsReader, "read">, verdicts: Pick<Verdicts, "get">, fresh?: Pick<FreshChecks, "ask">) {
    this.#holdings = holdings;
    this.#verdicts = verdicts;
    this.#fresh = fresh;
  }

  async read(wallet: string): Promise<Bag> {
    return this.fromHoldings(await this.#holdings.read(wallet));
  }

  /** The bag for holdings already read. */
  fromHoldings(holdings: Holdings): Bag {
    const fresh = this.#fresh;
    return buildBag(holdings, (t) => this.#verdicts.get(t), fresh ? (c) => fresh.ask(c) : undefined);
  }
}
