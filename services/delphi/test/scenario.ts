// Builds synthetic coins for the detector tests: a launch, then buys, sells, transfers and fundings
// at chosen seconds after it. Prices are flat (1 USDC per million tokens) so volumes are easy to read.
import type { Address, Hex } from "viem";
import { TOTAL_SUPPLY } from "../src/config.ts";
import { actorsOf, buildLinks, findHubs } from "../src/graph.ts";
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

export function scenario(opts: { creator?: Address; launcher?: Address } = {}) {
  let seq = 1;
  const creator = opts.creator ?? addr(0xc0);
  const coin: Coin = {
    token: TOKEN,
    poolId: hash(0xb0),
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
      trades.push({ ...b, side: "buy", trader: payer, holder: who, tokens: M(millions), quote: BigInt(millions * 1e6), outside: false });
      transfers.push({ ...b, from: VAULT, to: who, value: M(millions) });
      return s;
    },
    sell(who: Address, millions: number, sec: number) {
      const b = at(sec);
      trades.push({ ...b, side: "sell", trader: who, holder: who, tokens: M(millions), quote: BigInt(millions * 1e6), outside: false });
      transfers.push({ ...b, from: who, to: VAULT, value: M(millions) });
      return s;
    },
    pass(from: Address, to: Address, millions: number, sec: number) {
      transfers.push({ ...at(sec), from, to, value: M(millions) });
      return s;
    },
    fund(wallet: Address, funder: Address, sec = -3_600) {
      const b = at(sec);
      fundings.push({ wallet, funder, value: 10n ** 17n, tx: b.tx, time: b.time });
      return s;
    },
    build(txCounts: ReadonlyMap<string, number> = new Map()): CoinData {
      const system = new Set([ZERO, VAULT, LAUNCHPAD, ROUTER].map((a) => a.toLowerCase()));
      const links = buildLinks({
        actors: actorsOf(trades, transfers, system),
        creator: coin.creator,
        launcher: coin.launcher,
        launchTx: coin.launchTx,
        trades,
        transfers,
        fundings,
        hubs: findHubs(txCounts),
        system,
      });
      return { coin, trades, transfers, links, system, fundingMissing: 0 };
    },
  };
  return s;
}
