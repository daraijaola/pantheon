// Any address, not only a wallet on one coin (feature "wallet"): "@heyDelph check 0x…". From the chain:
// what kind of address it is (wallet, contract or pool), its HYPE and how many transactions it sent.
// From the funding lookup: who first funded it, and when. From DELPHI's coins: the coins it created,
// traded or holds, the linked groups it is in (with each coin's verdict), and groups it paid for.
// A contract or pool is said to be one, and its "funding" is not looked up: it says nothing about an owner.
import { formatEther, getAddress, isAddress, type Address, type Hex, type PublicClient } from "viem";
import { z } from "zod";
import { amount } from "../ai/tools.ts";
import { addressKinds, type AddressKind } from "../chain.ts";
import { KNOWN_HUBS, supplyOf } from "../config.ts";
import { balances, pct } from "../detect.ts";
import { actorsOf, clusters } from "../graph.ts";
import type { Store } from "../store.ts";
import type { Verdict } from "../types.ts";
import { untrusted } from "./text.ts";
import { jsonTool, type ExtraTool } from "./tooling.ts";
import { KNOWN_ADDRESSES, whatIsAddress, type Snapshot } from "./xtools.ts";

/** The first HYPE a wallet ever received, and from whom (src/funding.ts; this is its interface). */
export type FirstFunding = { wallet: Address; funder: Address; via: "tx" | "internal"; value: bigint; tx: Hex; block: bigint; time: number } | null;
export type FirstFundingFn = (wallet: Address) => Promise<FirstFunding>;

/** The chain reads wallet_profile needs. chainReader() makes one from viem's PublicClient. */
export type ChainReader = {
  kind(address: Address): Promise<AddressKind>;
  /** Native HYPE, in wei. */
  balance(address: Address): Promise<bigint>;
  /** Transactions the address sent (its nonce). */
  sentTxs(address: Address): Promise<number>;
};

/** Reads through viem; an address's kind is remembered in DELPHI's cache, as the scan does. */
export function chainReader(client: PublicClient, store: Store): ChainReader {
  return {
    kind: async (a) => (await addressKinds(client, store, [a])).get(a.toLowerCase()) ?? "contract",
    balance: (a) => client.getBalance({ address: a }),
    sentTxs: (a) => client.getTransactionCount({ address: a }),
  };
}

const lc = (a: string) => a.toLowerCase();
const iso = (t: number) => new Date(t * 1000).toISOString().replace(".000Z", "Z");
const sym = (s: string | null) => (s ? untrusted(s, 16) : null);
const HUBS = new Set(KNOWN_HUBS.map(lc));
const KIND: Record<AddressKind, string> = { wallet: "wallet", pool: "a trading pool (a contract, not a wallet)", contract: "a contract, not a wallet" };

function ago(snap: Snapshot, t: number) {
  const s = Math.max(0, snap.readAt.getTime() / 1000 - t);
  return { days: Math.floor(s / 86_400), hours: Math.floor(s / 3_600) };
}

/** Who a funder is, as far as DELPHI knows: a known contract or faucet, a coin creator, a busy hub. */
function funderIs(snap: Snapshot, funder: string, aboutUs: boolean): string {
  const f = lc(funder);
  if (KNOWN_ADDRESSES[f]) return String(whatIsAddress(snap, { address: f }, aboutUs).is);
  if (HUBS.has(f)) return "a public faucet";
  const created = [...snap.ws.coins.values()].filter((d) => lc(d.coin.creator) === f).length;
  const paid = [...snap.ws.fundings.values()].filter((fs) => fs.some((x) => lc(x.funder) === f)).length;
  const hub = [...snap.ws.fundings.values()].some((fs) => fs.some((x) => lc(x.funder) === f && x.publicHub));
  return [
    created ? `the creator wallet of ${created} Ascend coin(s)` : null,
    hub ? "a public hub (a faucet or a very busy address): it links no one" : null,
    paid ? `it funded ${paid} wallet(s) that trade coins DELPHI reads` : null,
  ]
    .filter(Boolean)
    .join("; ") || "unknown to DELPHI";
}

/** Everything DELPHI can say about one address, across all its coins. */
export async function walletProfileAny(
  snap: Snapshot,
  deps: { chain: ChainReader; firstFunding?: FirstFundingFn },
  input: { address: string },
  aboutUs = false,
) {
  const raw = input.address.trim();
  if (!isAddress(raw, { strict: false })) return { error: `${raw.slice(0, 50)} is not a full address (0x and 40 hex characters)` };
  const address = getAddress(raw);
  const w = lc(address);
  const ws = snap.ws;
  const verdictOf = (token: string): Verdict | null => ws.reports.get(lc(token))?.verdict ?? null;
  const coin = ws.reports.get(w);
  if (coin) return { address, kind: "an Ascend coin (its token contract, not a wallet)", symbolSetByCreator: sym(coin.coin.symbol), verdict: coin.verdict, note: "call coin_report for its checks" };

  const [kind, wei, sent] = await Promise.all([deps.chain.kind(address), deps.chain.balance(address), deps.chain.sentTxs(address)]);
  const machinery = [...ws.coins.values()].some((d) => d.system.has(w) && !d.contracts?.has(w));
  const named = KNOWN_ADDRESSES[w] ? String(whatIsAddress(snap, { address: w }, aboutUs).is) : machinery ? "part of Ascend's trading machinery (vault, router or pool)" : null;

  const created: Array<{ token: string; symbolSetByCreator: string | null; verdict: Verdict | null; role: string }> = [];
  const traded: Array<Record<string, unknown>> = [];
  const groups: Array<Record<string, unknown>> = [];
  const paidFor: Array<Record<string, unknown>> = [];
  for (const d of ws.coins.values()) {
    const token = d.coin.token;
    const base = { token, symbolSetByCreator: sym(d.coin.symbol), verdict: verdictOf(token) };
    if (lc(d.coin.creator) === w) created.push({ ...base, role: "creator" });
    else if (lc(d.coin.launcher) === w) created.push({ ...base, role: "sent the launch" });
    const mine = d.trades.filter((t) => lc(t.holder) === w || lc(t.trader) === w);
    const touched = mine.length > 0 || d.transfers.some((t) => lc(t.to) === w || lc(t.from) === w);
    if (touched) {
      const bal = balances(d);
      const held = [...bal.values()].reduce((s, v) => s + v, 0n);
      const has = bal.get(w) ?? 0n;
      const buys = mine.filter((t) => t.side === "buy");
      const sells = mine.filter((t) => t.side === "sell");
      traded.push({
        ...base,
        buys: buys.length,
        sells: sells.length,
        tokensBought: amount(buys.reduce((s, t) => s + t.tokens, 0n)),
        tokensSold: amount(sells.reduce((s, t) => s + t.tokens, 0n)),
        holds: amount(has),
        pctOfSupply: pct(has, supplyOf(d.coin)),
        ...(held > 0n && has > 0n ? { pctOfHeld: pct(has, held) } : {}),
      });
    }
    if (d.links.some((l) => lc(l.a) === w || lc(l.b) === w)) {
      const cl = clusters(d.links, [...actorsOf(d.trades, d.transfers, d.system)].map(lc));
      const root = cl.get(w);
      const members = root ? [...cl].filter(([m, r]) => r === root && !d.system.has(m)).map(([m]) => m) : [];
      if (members.length > 1) {
        const bal = balances(d);
        const held = [...bal.values()].reduce((s, v) => s + v, 0n);
        const together = members.reduce((s, m) => s + (bal.get(m) ?? 0n), 0n);
        groups.push({ ...base, linkedWallets: members.length, groupHoldsPctOfHeld: pct(together, held) });
      }
    }
    const funded = new Set(d.links.filter((l) => l.reason === "shared-funder" && l.via && lc(l.via) === w).flatMap((l) => [lc(l.a), lc(l.b)]));
    if (funded.size) paidFor.push({ ...base, linkedWalletsItFunded: funded.size });
  }

  let firstFunding: unknown = "not looked up: a contract's funding says nothing about who controls it";
  if (kind === "wallet") {
    let f: FirstFunding | undefined;
    let source = "the chain's history";
    try {
      f = deps.firstFunding ? await deps.firstFunding(address) : undefined;
    } catch {
      f = undefined;
    }
    if (f === undefined) {
      // DELPHI's cache: the earliest of the wallet's first 50 incoming payments, for wallets on its coins
      const cached = ws.fundings.get(w)?.[0];
      if (cached) f = { wallet: address, funder: cached.funder, via: cached.kind === "payout" || cached.kind === "multisend" ? "internal" : "tx", value: cached.value, tx: cached.tx, block: 0n, time: cached.time };
      source = "DELPHI's cache (the earliest of the payments it read)";
    }
    firstFunding =
      f === undefined
        ? "unknown: DELPHI has no funding history for this wallet"
        : f === null
          ? "none found: no HYPE was ever sent to it"
          : {
              funder: f.funder,
              hype: Number(formatEther(f.value)).toLocaleString("en-US", { maximumSignificantDigits: 4 }),
              time: iso(f.time),
              ago: ago(snap, f.time),
              how: f.via === "internal" ? "paid inside a contract call" : "a plain transfer",
              funderIs: funderIs(snap, f.funder, aboutUs),
              source,
            };
  }

  const cap = <T>(rows: T[]) => ({ count: rows.length, rows: rows.slice(0, 10) });
  return {
    address,
    kind: KIND[kind],
    ...(named ? { is: named } : {}),
    hype: Number(formatEther(wei)).toLocaleString("en-US", { maximumSignificantDigits: 4 }),
    sentTxs: sent,
    firstFunding,
    coinsCreated: cap(created),
    coinsTradedOrHeld: cap(traded),
    linkedGroups: cap(groups),
    ...(paidFor.length ? { fundedLinkedWalletsOn: cap(paidFor) } : {}),
    network: "Elysium testnet: HYPE here is test money",
    note: "Coins are the ones DELPHI reads (every Ascend launch). A wallet can use fresh wallets for each coin, so none found doesn't prove a first time.",
  };
}

export const walletTool: ExtraTool = {
  feature: "wallet",
  name: "wallet_profile",
  guidance:
    'wallet_profile checks any address ("check 0x…" when it isn\'t a coin): wallet, contract or pool, its HYPE, how many transactions it sent, who first funded it and when, coins it created, traded or holds, and linked groups it is in with each coin\'s verdict. A contract or pool isn\'t a wallet: say what kind of address it is (what_is_address names the ones DELPHI knows) and stop there. For an answer about a wallet, token and verdict are null.',
  build: (env) => {
    const chain = env.deps.chain;
    if (!chain) return null;
    return jsonTool(env, {
      name: "wallet_profile",
      description:
        "Any address across all of DELPHI's coins: kind (wallet, contract or pool), HYPE balance, transactions sent, first funding (who and when), coins it created, coins it traded or holds, linked groups it is in (with each coin's verdict), and groups of wallets it funded.",
      inputSchema: z.object({ address: z.string().describe("A full 0x address (40 hex characters)") }),
      run: (i) => walletProfileAny(env.snap, { chain, firstFunding: env.deps.firstFunding }, i, env.aboutUs),
    });
  },
};
