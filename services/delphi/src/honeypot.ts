// The honeypot tests: can the coin really be moved and sold, and what does it keep on the way? All of
// it is dry runs (eth_simulateV1) on top of one real block: nothing is signed or sent, and no real
// balance changes. Fresh test wallets are made-up addresses with no history.
//
// - Transfer: a real holder sends some coins to a fresh wallet, which then passes them on to another
//   fresh wallet. What arrives shows a transfer tax; a refusal shows a block (and its revert reason).
// - Sale on Kalos: the holder sells through Kalos's router, and a fresh wallet buys with HYPE and sells
//   it all back. Each step is compared with Kalos's own quote (QuoterV2) at that moment, so the pool's
//   fee and price impact cancel out and what is left is the coin's own tax. A coin that keeps part of
//   every transfer cannot be sold into a Uniswap-V3-style pool at all: the pool gets less than it was
//   promised and refuses ("IIA").
import { decodeFunctionResult, encodeFunctionData, getAddress, keccak256, parseAbi, toEventSelector, toHex, type Address, type Hex } from "viem";
import type { KalosContracts } from "./kalos.ts";
import { answerData, balanceOfData, DEAD, ERC20, ethCall, getCode, outcome, pctOf, wordUint, ZERO } from "./reads.ts";
import type { BatchRpc } from "./rpc.ts";
import { simulate, type Revert, type SimCall, type SimResult } from "./simulate.ts";
import { delegationTarget } from "./bytecode.ts";

/** Made-up wallets for dry runs: derived from fixed words, so every run (and every replay) uses the same ones. */
const testWallet = (word: string): Address => getAddress(`0x${keccak256(toHex(`delphi-safety:${word}`)).slice(26)}`);
export const TEST_WALLETS = { receiver: testWallet("receiver"), onward: testWallet("onward"), buyer: testWallet("buyer") } as const;

const TRANSFER_TOPIC = toEventSelector("Transfer(address,address,uint256)");
/** Far in the future: Kalos's router refuses a trade after its deadline. */
const DEADLINE = 2n ** 64n;

const ROUTER = parseAbi([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
]);
const QUOTER = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);
const FACTORY = parseAbi(["function getPool(address, address, uint24) view returns (address)"]);
const POOL = parseAbi(["function liquidity() view returns (uint128)"]);

export type HolderPick = { holder: Address; balance: bigint; transfersSeen: number; fromBlock: bigint; toBlock: bigint };

/**
 * How far back to look for holders, in blocks (about 0.19 s each on Elysium testnet). Windows start
 * small near the head and grow `growth` times each round, so a busy coin is read for minutes of
 * history and a quiet one for days.
 */
export type HolderSearch = { windowBlocks: number; growth: number; maxWindowBlocks: number; maxLookbackBlocks: number; enoughTransfers: number; candidates: number };

type Log = { topics: Hex[]; blockNumber: Hex };

/**
 * The wallet (not a contract) holding the most of `token` among the latest recipients of its
 * transfers. Walks back from `block` in windows; a window the node refuses for having too many logs
 * (its cap is 10,000) is split into ten.
 */
export async function pickHolder(rpc: BatchRpc, token: Address, block: bigint, search: HolderSearch, exclude: readonly Address[] = []): Promise<HolderPick | null> {
  const logs: Log[] = [];
  let top = block;
  const floor = block - BigInt(search.maxLookbackBlocks) > 0n ? block - BigInt(search.maxLookbackBlocks) : 0n;
  let todo: Array<[bigint, bigint]> = [];
  let W = BigInt(search.windowBlocks);
  while (logs.length < search.enoughTransfers && (top >= floor || todo.length)) {
    if (!todo.length) {
      if (logs.length || top < block) W = W * BigInt(search.growth) < BigInt(search.maxWindowBlocks) ? W * BigInt(search.growth) : BigInt(search.maxWindowBlocks);
      for (let i = 0; i < 10 && top >= floor; i++) {
        const from = top - W + 1n > floor ? top - W + 1n : floor;
        todo.push([from, top]);
        top = from - 1n;
      }
    }
    const answers = await rpc.many<Log[]>(
      todo.map(([from, to]) => ({ method: "eth_getLogs", params: [{ address: token, topics: [TRANSFER_TOPIC], fromBlock: toHex(from), toBlock: toHex(to) }] })),
    );
    const again: Array<[bigint, bigint]> = [];
    answers.forEach((a, i) => {
      const [from, to] = todo[i]!;
      if (a.result) logs.push(...a.result);
      else if (/limit|too many|exceed/i.test(a.error.message) && to > from) {
        const step = (to - from + 1n + 9n) / 10n;
        for (let s = from; s <= to; s += step) again.push([s, s + step - 1n < to ? s + step - 1n : to]);
      } else throw new Error(`eth_getLogs ${from}-${to}: ${a.error.message}`);
    });
    todo = again;
  }
  logs.sort((a, b) => Number(BigInt(b.blockNumber) - BigInt(a.blockNumber)));
  const skip = new Set([ZERO, DEAD, token, ...exclude].map((a) => a.toLowerCase()));
  const candidates: Address[] = [];
  for (const l of logs) {
    const to = l.topics[2];
    if (!to) continue;
    const a = getAddress(`0x${to.slice(26)}`);
    if (skip.has(a.toLowerCase())) continue;
    skip.add(a.toLowerCase());
    candidates.push(a);
    if (candidates.length >= search.candidates) break;
  }
  if (!candidates.length) return null;
  const tag = toHex(block);
  const answers = await rpc.many(candidates.flatMap((c) => [ethCall(token, balanceOfData(c), tag), getCode(c, tag)]));
  let best: { holder: Address; balance: bigint } | null = null;
  for (const [i, holder] of candidates.entries()) {
    const code = answers[2 * i + 1]!.result as Hex | undefined;
    if (code === undefined || (code !== "0x" && !delegationTarget(code))) continue;
    const balance = wordUint(answerData(answers[2 * i])) ?? 0n;
    if (balance > 0n && (!best || balance > best.balance)) best = { holder, balance };
  }
  if (!best) return null;
  const oldest = BigInt(logs[logs.length - 1]!.blockNumber);
  return { ...best, transfersSeen: logs.length, fromBlock: oldest, toBlock: block };
}

const transferData = (to: Address, amount: bigint) => encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [to, amount] });
const approveData = (spender: Address, amount: bigint) => encodeFunctionData({ abi: ERC20, functionName: "approve", args: [spender, amount] });
const uintOf = (r: SimResult | undefined) => (r?.ok ? (wordUint(r.returnData) ?? 0n) : 0n);
/** A transfer that "succeeds" but answers false did not happen. */
const returnedFalse = (r: SimResult) => r.ok && r.returnData.length >= 66 && BigInt(r.returnData.slice(0, 66)) === 0n;

export type TransferTest = {
  holder: Address;
  amount: string;
  receiver: Address;
  /** null when the transfer was refused. */
  received: string | null;
  /** What left the holder's balance (more than `amount` if the coin charges the sender extra). */
  holderPaid: string | null;
  taxPct: number | null;
  blocked: boolean;
  revert: Revert | null;
  /** Other Transfer events in the same transfer: where a tax went. */
  sideTransfers: Array<{ from: Address; to: Address; value: string }>;
  /** The receiver passes everything it got on to a second fresh wallet. */
  onward: { amount: string; received: string | null; blocked: boolean; revert: Revert | null } | null;
};

/** Calls run first in the same dry run, and HYPE given to test wallets (a fresh buyer's purchase, say). */
export type Setup = { calls: SimCall[]; balances: Record<Address, bigint> };
const NO_SETUP: Setup = { calls: [], balances: {} };

/** Sends `amount` from `holder` to a fresh wallet, then on to another, in a dry run. */
export async function transferTest(rpc: BatchRpc, block: Hex, token: Address, holder: Address, amount: bigint, setup: Setup = NO_SETUP): Promise<TransferTest> {
  const { receiver, onward } = TEST_WALLETS;
  const n = setup.calls.length;
  const first = (await simulate(rpc, block, [
    ...setup.calls,
    { from: holder, to: token, data: balanceOfData(holder) },
    { from: holder, to: token, data: transferData(receiver, amount) },
    { from: holder, to: token, data: balanceOfData(receiver) },
    { from: holder, to: token, data: balanceOfData(holder) },
  ], setup.balances)).slice(n);
  const [before, sent, got, after] = first as [SimResult, SimResult, SimResult, SimResult];
  const blocked = !sent.ok || returnedFalse(sent);
  const base: TransferTest = {
    holder,
    amount: amount.toString(),
    receiver,
    received: null,
    holderPaid: null,
    taxPct: null,
    blocked,
    revert: sent.revert ?? (returnedFalse(sent) ? { data: sent.returnData, reason: "transfer() returned false", message: "returned false" } : null),
    sideTransfers: [],
    onward: null,
  };
  if (blocked) return base;
  const received = uintOf(got);
  const paid = uintOf(before) - uintOf(after);
  const sideTransfers = sent.logs
    .filter((l) => l.address === token && l.topics[0] === TRANSFER_TOPIC && l.topics.length === 3)
    .map((l) => ({ from: getAddress(`0x${l.topics[1]!.slice(26)}`), to: getAddress(`0x${l.topics[2]!.slice(26)}`), value: BigInt(l.data).toString() }))
    .filter((t) => !(t.from === holder && t.to === receiver));
  const result: TransferTest = {
    ...base,
    received: received.toString(),
    holderPaid: paid.toString(),
    taxPct: pctOf(amount > received ? amount - received : 0n, amount),
    sideTransfers,
  };
  if (received === 0n) return result;
  const second = (await simulate(rpc, block, [
    ...setup.calls,
    { from: holder, to: token, data: transferData(receiver, amount) },
    { from: receiver, to: token, data: transferData(onward, received) },
    { from: receiver, to: token, data: balanceOfData(onward) },
  ], setup.balances)).slice(n);
  const passed = second[1]!;
  const onwardBlocked = !passed.ok || returnedFalse(passed);
  result.onward = {
    amount: received.toString(),
    received: onwardBlocked ? null : uintOf(second[2]).toString(),
    blocked: onwardBlocked,
    revert: passed.revert ?? (returnedFalse(passed) ? { data: passed.returnData, reason: "transfer() returned false", message: "returned false" } : null),
  };
  return result;
}

export type KalosPool = { pool: Address; fee: number; whypeInPool: string; liquidity: string };

/** The coin's Kalos pools against WHYPE, found on chain through Kalos's factory, deepest (most WHYPE) first. */
export async function kalosPools(rpc: BatchRpc, block: Hex, token: Address, kalos: KalosContracts, feeTiers: readonly number[]): Promise<KalosPool[]> {
  if (token.toLowerCase() === kalos.whype.toLowerCase()) return [];
  const found = await rpc.many(feeTiers.map((fee) => ethCall(kalos.factory, encodeFunctionData({ abi: FACTORY, functionName: "getPool", args: [token, kalos.whype, fee] }), block)));
  const pools = found.flatMap((a, i) => {
    const data = answerData(a);
    const pool = data && /^0x0{24}[0-9a-f]{40}$/i.test(data) ? getAddress(`0x${data.slice(26)}`) : null;
    return pool && pool !== ZERO ? [{ pool, fee: feeTiers[i]! }] : [];
  });
  if (!pools.length) return [];
  const reads = await rpc.many(pools.flatMap((p) => [ethCall(kalos.whype, balanceOfData(p.pool), block), ethCall(p.pool, encodeFunctionData({ abi: POOL, functionName: "liquidity" }), block)]));
  return pools
    .map((p, i) => ({ ...p, whypeInPool: (wordUint(answerData(reads[2 * i])) ?? 0n).toString(), liquidity: (wordUint(answerData(reads[2 * i + 1])) ?? 0n).toString() }))
    .filter((p) => p.liquidity !== "0")
    .sort((a, b) => (BigInt(b.whypeInPool) > BigInt(a.whypeInPool) ? 1 : BigInt(b.whypeInPool) < BigInt(a.whypeInPool) ? -1 : 0));
}

const quoteData = (tokenIn: Address, tokenOut: Address, amountIn: bigint, fee: number) =>
  encodeFunctionData({ abi: QUOTER, functionName: "quoteExactInputSingle", args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }] });
const swapData = (tokenIn: Address, tokenOut: Address, fee: number, recipient: Address, amountIn: bigint) =>
  encodeFunctionData({ abi: ROUTER, functionName: "exactInputSingle", args: [{ tokenIn, tokenOut, fee, recipient, deadline: DEADLINE, amountIn, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }] });
const quoted = (r: SimResult | undefined): bigint | null => {
  if (!r?.ok) return null;
  try {
    return decodeFunctionResult({ abi: QUOTER, functionName: "quoteExactInputSingle", data: r.returnData })[0];
  } catch {
    return null;
  }
};

/** One trade in a dry run: what Kalos quoted, what really arrived, and the difference. */
export type TradeLeg = {
  amountIn: string;
  quoted: string | null;
  received: string | null;
  /** What left the seller's balance, when that is the coin (a sale). */
  paid: string | null;
  /** Shortfall against the quote, in %. */
  taxPct: number | null;
  ok: boolean;
  revert: Revert | null;
};

const leg = (amountIn: bigint, quote: bigint | null, swap: SimResult, received: bigint | null, paid: bigint | null): TradeLeg => ({
  amountIn: amountIn.toString(),
  quoted: quote === null ? null : quote.toString(),
  received: swap.ok && received !== null ? received.toString() : null,
  paid: swap.ok && paid !== null ? paid.toString() : null,
  taxPct: swap.ok && received !== null && quote ? pctOf(quote > received ? quote - received : 0n, quote) : null,
  ok: swap.ok,
  revert: swap.revert,
});

/**
 * A sale size that stays small next to the pool: `amount`, scaled down so Kalos's quote for it is at
 * most `maxShareBps` of the pool's WHYPE (a big holder's 1% can be a fifth of a thin pool).
 */
export async function saleSize(rpc: BatchRpc, block: Hex, token: Address, amount: bigint, pool: KalosPool, kalos: KalosContracts, maxShareBps: number): Promise<bigint> {
  const [a] = await rpc.many([ethCall(kalos.quoterV2, quoteData(token, kalos.whype, amount, pool.fee), block)]);
  const o = outcome(a!);
  const quote = o.ok ? wordUint(o.data) : null;
  const cap = (BigInt(pool.whypeInPool) * BigInt(maxShareBps)) / 10_000n;
  if (!quote || quote <= cap) return amount;
  const scaled = (amount * cap) / quote;
  return scaled > 0n ? scaled : amount;
}

/** The holder sells `amount` for WHYPE through Kalos's router. */
export async function holderSell(rpc: BatchRpc, block: Hex, token: Address, holder: Address, amount: bigint, pool: KalosPool, kalos: KalosContracts): Promise<TradeLeg> {
  const r = await simulate(rpc, block, [
    { from: holder, to: kalos.quoterV2, data: quoteData(token, kalos.whype, amount, pool.fee) },
    { from: holder, to: token, data: approveData(kalos.swapRouter, amount) },
    { from: holder, to: kalos.whype, data: balanceOfData(holder) },
    { from: holder, to: token, data: balanceOfData(holder) },
    { from: holder, to: kalos.swapRouter, data: swapData(token, kalos.whype, pool.fee, holder, amount) },
    { from: holder, to: kalos.whype, data: balanceOfData(holder) },
    { from: holder, to: token, data: balanceOfData(holder) },
  ]);
  if (!r[1]!.ok) return leg(amount, quoted(r[0]), r[1]!, null, null);
  return leg(amount, quoted(r[0]), r[4]!, uintOf(r[5]) - uintOf(r[2]), uintOf(r[3]) - uintOf(r[6]));
}

/** A fresh wallet buys with `buyWei` of HYPE through Kalos's router, then sells everything it got. */
export async function roundTrip(rpc: BatchRpc, block: Hex, token: Address, buyWei: bigint, pool: KalosPool, kalos: KalosContracts): Promise<{ buy: TradeLeg; sell: TradeLeg | null; setup: Setup | null }> {
  const { buyer, money, buyCall } = buyerSetup(token, buyWei, pool, kalos);
  const a = await simulate(rpc, block, [{ from: buyer, to: kalos.quoterV2, data: quoteData(kalos.whype, token, buyWei, pool.fee) }, buyCall, { from: buyer, to: token, data: balanceOfData(buyer) }], money);
  const bought = uintOf(a[2]);
  const buy = leg(buyWei, quoted(a[0]), a[1]!, bought, null);
  if (!a[1]!.ok || bought === 0n) return { buy, sell: null, setup: null };
  const setup: Setup = { calls: [buyCall], balances: money };
  const b = await simulate(
    rpc,
    block,
    [
      buyCall,
      { from: buyer, to: token, data: approveData(kalos.swapRouter, bought) },
      { from: buyer, to: kalos.quoterV2, data: quoteData(token, kalos.whype, bought, pool.fee) },
      { from: buyer, to: kalos.whype, data: balanceOfData(buyer) },
      { from: buyer, to: kalos.swapRouter, data: swapData(token, kalos.whype, pool.fee, buyer, bought) },
      { from: buyer, to: kalos.whype, data: balanceOfData(buyer) },
      { from: buyer, to: token, data: balanceOfData(buyer) },
    ],
    money,
  );
  if (!b[1]!.ok) return { buy, sell: leg(bought, quoted(b[2]), b[1]!, null, null), setup };
  return { buy, sell: leg(bought, quoted(b[2]), b[4]!, uintOf(b[5]) - uintOf(b[3]), bought - uintOf(b[6])), setup };
}

/** The fresh buyer's purchase: `buyWei` of HYPE into the coin through Kalos's router. */
function buyerSetup(token: Address, buyWei: bigint, pool: KalosPool, kalos: KalosContracts) {
  const { buyer } = TEST_WALLETS;
  return { buyer, money: { [buyer]: buyWei * 2n }, buyCall: { from: buyer, to: kalos.swapRouter, data: swapData(kalos.whype, token, pool.fee, buyer, buyWei), value: buyWei } };
}

/** Reads one holder's balance at `block` (0 when the call fails). */
export async function balanceAt(rpc: BatchRpc, block: Hex, token: Address, who: Address): Promise<bigint> {
  const [a] = await rpc.many([ethCall(token, balanceOfData(who), block)]);
  const o = outcome(a!);
  return o.ok ? (wordUint(o.data) ?? 0n) : 0n;
}
