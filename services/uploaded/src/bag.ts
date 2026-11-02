// A wallet's bag: what it holds, with DELPHI's verdict on each coin, worst first. Coins aren't cached
// here, so a verdict is always the latest even while the holdings are remembered. The counts are plain
// coin counts for the screen to use: "not read yet" and "too new to judge" are never counted as clean,
// and `complete` is false if any coin couldn't be read. Given the wallet's footprint, the bag is the whole
// wallet: tokens DELPHI hasn't read are added as UNKNOWN, and coins that only ever arrived in other people's
// transactions move to `sentIn`, apart from the bag and out of its counts, so a stranger can't change it.
import type { Footprint, FootprintReader, Moment, TokenRow } from "./footprint.ts";
import type { FreshChecks } from "./fresh.ts";
import type { Holding, Holdings, HoldingsReader } from "./holdings.ts";
import type { CoinVerdict, UnknownCoin, Venue, Verdicts } from "./verdicts.ts";

type Verdict = CoinVerdict["verdict"] | UnknownCoin["verdict"];

type Held = Omit<Holding, "venue"> & {
  /** Null for a token that isn't one of the coins DELPHI reads. */
  venue: Venue | null;
};

export type BagCoin = Held & {
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

/** A coin that came in other people's transactions. Never part of the bag. */
export type SentInCoin = { token: string; symbol: string | null; name: string | null; amount: string | null; verdict: Verdict; arrived: Moment };

export type Bag = {
  wallet: string;
  network: Holdings["network"];
  readAt: string;
  coins: BagCoin[];
  counts: Record<Verdict, number>;
  sentIn: SentInCoin[];
  /** False if only DELPHI's coins were checked, so tokens it hasn't read and coins sent in can't be told. */
  wholeWallet: boolean;
  /** Coins that couldn't be read: unknown, not zero. */
  unread: string[];
  /** True when every coin was read. */
  complete: boolean;
  /** True while a fresh read is running that may change a verdict here. */
  checking: boolean;
};

const WORST_FIRST: readonly Verdict[] = ["FLAG", "WATCH", "UNKNOWN", "NOT_ENOUGH_DATA", "CLEAN"];

/** What the footprint adds to the holdings: tokens DELPHI doesn't read, and which coins were sent in. */
function wholeWallet(h: Holdings, footprint: Footprint | undefined): { holdings: Held[]; unread: string[]; sentIn: TokenRow[] } {
  if (!footprint) return { holdings: h.holdings, unread: h.unread, sentIn: [] };
  const rows = new Map(footprint.tokens.map((r) => [r.token, r]));
  const seen = new Set([...h.holdings.map((c) => c.token), ...h.unread]);
  const unread = new Set([...h.unread, ...footprint.unread]);
  const added = footprint.tokens.flatMap((r) => {
    if (!r.holdsNow || r.sentIn === true || seen.has(r.token)) return [];
    if (r.decimals === null || !r.balance?.amount) {
      unread.add(r.token);
      return [];
    }
    return [{ token: r.token, symbol: r.symbol, name: r.name, venue: null, balance: r.balance.raw, decimals: r.decimals, amount: r.balance.amount }];
  });
  return { holdings: [...h.holdings.filter((c) => rows.get(c.token)?.sentIn !== true), ...added], unread: [...unread], sentIn: footprint.tokens.filter((r) => r.sentIn === true && r.holdsNow !== false) };
}

export function buildBag(h: Holdings, get: (token: string) => CoinVerdict | UnknownCoin, ask: (coin: CoinVerdict | UnknownCoin) => boolean = () => false, footprint?: Footprint): Bag {
  const counts = Object.fromEntries(WORST_FIRST.map((v) => [v, 0])) as Record<Verdict, number>;
  let checking = false;
  const whole = wholeWallet(h, footprint);
  const coins = whole.holdings.map((holding): BagCoin => {
    const v = get(holding.token);
    counts[v.verdict] += 1;
    // A token outside DELPHI's coins may never get a verdict: asking would start reads and leave this on for good.
    checking = (holding.venue !== null && ask(v)) || checking;
    if (!v.known) return { ...holding, verdict: v.verdict, reason: v.reason, findings: [], notes: [], reportUrl: null, disputeUrl: null, scannedAt: null, stale: false };
    return { ...holding, verdict: v.verdict, reason: v.reason, findings: v.findings, notes: v.notes, reportUrl: v.reportUrl, disputeUrl: v.disputeUrl, scannedAt: v.scannedAt, stale: v.stale };
  });
  coins.sort((a, b) => WORST_FIRST.indexOf(a.verdict) - WORST_FIRST.indexOf(b.verdict));
  const sentIn = whole.sentIn.map((r): SentInCoin => ({ token: r.token, symbol: r.symbol, name: r.name, amount: r.balance?.amount ?? null, verdict: get(r.token).verdict, arrived: r.firstSeen }));
  return { wallet: h.wallet, network: h.network, readAt: h.readAt, coins, counts, sentIn, wholeWallet: footprint !== undefined, unread: whole.unread, complete: whole.unread.length === 0 && (footprint?.complete ?? true), checking };
}

export class BagReader {
  readonly #holdings: Pick<HoldingsReader, "read">;
  readonly #verdicts: Pick<Verdicts, "get">;
  readonly #fresh: Pick<FreshChecks, "ask"> | undefined;
  readonly #footprint: Pick<FootprintReader, "read"> | undefined;
  readonly #log: (msg: string) => void;

  constructor(holdings: Pick<HoldingsReader, "read">, verdicts: Pick<Verdicts, "get">, fresh?: Pick<FreshChecks, "ask">, footprint?: Pick<FootprintReader, "read">, log: (msg: string) => void = () => {}) {
    this.#holdings = holdings;
    this.#verdicts = verdicts;
    this.#fresh = fresh;
    this.#footprint = footprint;
    this.#log = log;
  }

  async read(wallet: string): Promise<Bag> {
    // A footprint that can't be read doesn't cost the bag: it says so with `wholeWallet`.
    const [holdings, footprint] = await Promise.all([
      this.#holdings.read(wallet),
      this.#footprint?.read(wallet).catch((err: unknown) => {
        this.#log(`can't read the wallet's footprint: ${(err as Error).message.split("\n")[0]}`);
        return undefined;
      }),
    ]);
    return this.fromHoldings(holdings, footprint);
  }

  /** The bag for holdings already read, and for the whole wallet if its footprint is given. */
  fromHoldings(holdings: Holdings, footprint?: Footprint): Bag {
    const fresh = this.#fresh;
    return buildBag(holdings, (t) => this.#verdicts.get(t), fresh ? (c) => fresh.ask(c) : undefined, footprint);
  }
}
