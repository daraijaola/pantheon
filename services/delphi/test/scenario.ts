// Builds synthetic coins for the detector tests: a launch, then buys, sells, transfers and fundings
// at chosen seconds after it. Prices are flat (1 USDC per million tokens) so volumes are easy to read.
import type { Address, Hex } from "viem";
import { TOTAL_SUPPLY, type Network } from "../src/config.ts";
import { actorsOf, buildLinks, findHubs, payeesOf, type Payees } from "../src/graph.ts";
import type { Coin, CoinData, Funding, TokenTransfer, Trade } from "../src/types.ts";

export const addr = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}`;
export const hash = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
/** Millions of tokens, in 18-decimal units. */
export const M = (millions: number) => BigInt(Math.round(millions * 1_000)) * 10n ** 21n;

export const ZERO = addr(0);
export const VAULT = addr(0xa0);
export const LAUNCHPAD = addr(0xa1);
export const ROUTER = addr(0xa2);
export const TOKEN = addr(0xa3);
export const FAUCET: Address = "0xf272Cc84C3BA9f1B498adE29aaeED1e7D2D9f3fD";
export const T0 = 1_760_000_000;
export const POOL = hash(0xb0);
export const OUTSIDE_POOL = hash(0xb1);

export function scenario(opts: { creator?: Address; launcher?: Address } = {}) {
  let seq = 1;
  const creator = opts.creator ?? addr(0xc0);
  const coin: Coin = {
    token: TOKEN,
    poolId: POOL,
    tokenIs0: false,
    creator,
    launcher: opts.launcher ?? creator,
    launchTx: hash(seq),
    launchBlock: 1_000n,
    launchTime: T0,
    devBuyTokens: 0n,
    name: "Test Coin",
    symbol: "TEST",
  };
  const trades: Trade[] = [];
  const transfers: TokenTransfer[] = [{ tx: coin.launchTx, block: 1_000n, logIndex: 0, from: ZERO, to: VAULT, value: TOTAL_SUPPLY }];
  const fundings: Funding[] = [];
  const at = (sec: number) => ({ tx: hash(++seq), block: 1_000n + BigInt(sec), logIndex: 1, time: T0 + sec });

  const s = {
    coin,
    trades,
    transfers,
    fundings,
    buy(who: Address, millions: number, sec: number, payer: Address = who) {
      const b = at(sec);
      trades.push({ ...b, side: "buy", trader: payer, holder: who, tokens: M(millions), quote: BigInt(millions * 1e6), pool: POOL, outside: false });
      transfers.push({ ...b, from: VAULT, to: who, value: M(millions) });
      return s;
    },
    sell(who: Address, millions: number, sec: number) {
      const b = at(sec);
      trades.push({ ...b, side: "sell", trader: who, holder: who, tokens: M(millions), quote: BigInt(millions * 1e6), pool: POOL, outside: false });
      transfers.push({ ...b, from: who, to: VAULT, value: M(millions) });
      return s;
    },
    /** Buy in the Ascend pool and sell the same tokens in an outside pool, in one transaction. */
    arb(who: Address, millions: number, sec: number, samePool = false) {
      const b = at(sec);
      const leg = { ...b, trader: who, holder: who, tokens: M(millions), quote: BigInt(millions * 1e6) };
      trades.push({ ...leg, side: "buy", pool: POOL, outside: false });
      trades.push({ ...leg, logIndex: 2, side: "sell", pool: samePool ? POOL : OUTSIDE_POOL, outside: !samePool });
      return s;
    },
    pass(from: Address, to: Address, millions: number, sec: number) {
      transfers.push({ ...at(sec), from, to, value: M(millions) });
      return s;
    },
    /** `contract`: a contract paid it inside a transaction `funder` sent (a sale, a game win), not a plain transfer. */
    fund(wallet: Address, funder: Address, sec = -3_600, how: "transfer" | "contract" = "transfer") {
      const b = at(sec);
      fundings.push({ wallet, funder, value: 10n ** 17n, tx: b.tx, time: b.time, ...(how === "contract" ? { internal: true } : {}) });
      return s;
    },
    /** One transaction from `sender` in which a contract pays HYPE to every wallet (a batch payment). */
    payout(wallets: Address[], sender: Address, sec = -3_600) {
      const b = at(sec);
      for (const wallet of wallets) fundings.push({ wallet, funder: sender, value: 10n ** 17n, tx: b.tx, time: b.time, internal: true });
      return s;
    },
    /**
     * `contracts`: non-pool contracts (staking, lockers…), which ingest puts in `system` too. `network`
     * picks the rule profile (default: mainnet, the strict one); `payees` stands in for what funders did on
     * other coins (default: this coin only).
     */
    build(
      txCounts: ReadonlyMap<string, number> = new Map(),
      contracts: Address[] = [],
      opts: { network?: Network; payees?: ReadonlyMap<string, Payees> } = {},
    ): CoinData {
      const system = new Set([ZERO, VAULT, LAUNCHPAD, ROUTER, ...contracts].map((a) => a.toLowerCase()));
      const traded = new Map<string, Set<string>>();
      for (const t of trades) for (const w of [t.trader, t.holder]) traded.set(w.toLowerCase(), new Set([TOKEN.toLowerCase()]));
      const links = buildLinks({
        actors: actorsOf(trades, transfers, system),
        creator: coin.creator,
        launcher: coin.launcher,
        launchTx: coin.launchTx,
        trades,
        transfers,
        fundings,
        hubs: findHubs(txCounts, { network: opts.network, payees: opts.payees ?? payeesOf(fundings, traded) }),
        system,
      });
      return { coin, trades, transfers, links, system, fundingMissing: 0, contracts: new Set(contracts.map((a) => a.toLowerCase())) };
    },
  };
  return s;
}
