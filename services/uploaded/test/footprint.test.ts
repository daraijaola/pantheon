// A wallet's whole footprint, on stand-in logs: no network. Logs are written by contracts and any contract can
// write anything, so most of these are about what a stranger could plant.
import { ResponseBodyTooLargeError } from "viem";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/api.ts";
import { politeFetch } from "../src/chain.ts";
import { allLogs, chainFootprint, FootprintReader, TooBig, type FootprintCalls, type Meta, type RawLog, type Tx } from "../src/footprint.ts";
import { knownContracts } from "../src/known.ts";
import { Verdicts } from "../src/verdicts.ts";

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const APPROVAL = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
const FOR_ALL = "0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31";
const ME = "0x79a320a02db0c1cbe7a5f2cd47210ea6f3b9f23a";
const STRANGER = "0x2222222222222222222222222222222222222222";
const ROUTER = "0x3333333333333333333333333333333333333333";
const TOKEN = "0x4444444444444444444444444444444444444444";
const OTHER = "0x5555555555555555555555555555555555555555";
const NFT = "0x6666666666666666666666666666666666666666";
const UNLIMITED = 2n ** 256n - 1n;

const topic = (a: string) => `0x${a.slice(2).padStart(64, "0")}`;
const word = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;
let at = 0;
const log = (address: string, topics: string[], data: string, block: number, tx: string): RawLog => ({ address, topics, data, blockNumber: `0x${block.toString(16)}`, transactionHash: tx, logIndex: `0x${(at++).toString(16)}`, blockTimestamp: `0x${(1_760_000_000 + block).toString(16)}` });
const transfer = (token: string, from: string, to: string, amount: bigint, block: number, tx: string) => log(token, [TRANSFER, topic(from), topic(to)], word(amount), block, tx);
const nft = (collection: string, from: string, to: string, id: bigint, block: number, tx: string) => log(collection, [TRANSFER, topic(from), topic(to), word(id)], "0x", block, tx);
const approve = (token: string, spender: string, amount: bigint, block: number, tx: string) => log(token, [APPROVAL, topic(ME), topic(spender)], word(amount), block, tx);
const forAll = (collection: string, operator: string, on: boolean, block: number, tx: string) => log(collection, [FOR_ALL, topic(ME), topic(operator)], word(on ? 1n : 0n), block, tx);

type World = {
  logs: RawLog[];
  contract?: boolean;
  balances?: Record<string, bigint | null>;
  allowances?: Record<string, bigint | null>;
  txs?: Record<string, Tx | null>;
  meta?: Record<string, Meta>;
};

function chain(w: World) {
  const asked = { txs: 0, meta: 0, logs: 0 };
  const has = (topics: Array<string | null>, l: RawLog) => topics.every((t, i) => t === null || l.topics[i] === t);
  const calls: FootprintCalls = {
    head: async () => 1_000n,
    isContract: async () => w.contract ?? false,
    logs: async (topics) => (asked.logs++, w.logs.filter((l) => has(topics, l))),
    balances: async (_w, tokens) => tokens.map((t) => (t in (w.balances ?? {}) ? w.balances![t]! : 0n)),
    meta: async (tokens) => (asked.meta++, tokens.map((t) => w.meta?.[t] ?? { symbol: "TKN", name: "Token", decimals: 18 })),
    allowances: async (_w, pairs) => pairs.map((p) => {
      const key = `${p.token}:${p.spender}`;
      return key in (w.allowances ?? {}) ? w.allowances![key]! : 0n;
    }),
    transactions: async (txs) => (asked.txs += txs.length, txs.map((tx) => (tx in (w.txs ?? {}) ? w.txs![tx]! : { from: ME, to: ROUTER }))),
  };
  return { calls, asked };
}

const facts = (known: Record<string, "CLEAN" | "FLAG"> = {}) => ({ network: () => "testnet" as const, verdict: (t: string) => (known[t] ? ({ verdict: known[t] } as never) : ({ known: false, token: t, verdict: "UNKNOWN", reason: "" } as const)) });
const read = (w: World, names = {}, f = facts()) => new FootprintReader(f, chain(w).calls, names).read(ME);
const fromStranger: Tx = { from: STRANGER, to: STRANGER };

describe("every log, however many", () => {
  const huge = (limit: number, logs: RawLog[]) => {
    const asked: Array<[bigint, bigint]> = [];
    const request = async ({ params }: { method: string; params: unknown[] }) => {
      const { fromBlock, toBlock } = params[0] as { fromBlock: string; toBlock: string };
      const [from, to] = [BigInt(fromBlock), BigInt(toBlock)];
      asked.push([from, to]);
      const found = logs.filter((l) => BigInt(l.blockNumber) >= from && BigInt(l.blockNumber) <= to);
      if (found.length > limit) throw new Error('RPC Request failed.\nDetails: logs count limit exceeded (10000)');
      return found;
    };
    return { request, asked };
  };

  it("cuts a refused range in half until each part fits, and loses nothing", async () => {
    const logs = Array.from({ length: 64 }, (_, i) => transfer(TOKEN, ME, STRANGER, 1n, i, `0x${i}`));
    const { request, asked } = huge(10, logs);
    const got = await allLogs(request, [TRANSFER], 0n, 63n, { left: 1_000 });
    expect(got.map((l) => l.transactionHash).sort()).toEqual(logs.map((l) => l.transactionHash).sort());
    expect(asked.length).toBeGreaterThan(1);
  });

  it("asks once if the range fits", async () => {
    const { request, asked } = huge(10, [transfer(TOKEN, ME, STRANGER, 1n, 5, "0x1")]);
    await allLogs(request, [TRANSFER], 0n, 63n, { left: 1_000 });
    expect(asked).toHaveLength(1);
  });

  it("gives up on any other error, rather than asking a million times", async () => {
    let calls = 0;
    await expect(allLogs(async () => { calls++; throw new Error("the node is down"); }, [TRANSFER], 0n, 1_000_000n, { left: 1_000 })).rejects.toThrow("the node is down");
    expect(calls).toBe(1);
  });

  it("calls a single block over the limit too big: it can't be cut smaller", async () => {
    await expect(allLogs(async () => { throw new Error("logs count limit exceeded"); }, [TRANSFER], 7n, 7n, { left: 1_000 })).rejects.toBeInstanceOf(TooBig);
  });

  it("cuts a range the same way when the answer is too many bytes for the client", async () => {
    const logs = Array.from({ length: 64 }, (_, i) => transfer(TOKEN, ME, STRANGER, 1n, i, `0x${i}`));
    const request = async ({ params }: { method: string; params: unknown[] }) => {
      const { fromBlock, toBlock } = params[0] as { fromBlock: string; toBlock: string };
      const [from, to] = [BigInt(fromBlock), BigInt(toBlock)];
      const found = logs.filter((l) => BigInt(l.blockNumber) >= from && BigInt(l.blockNumber) <= to);
      if (found.length > 10) throw new ResponseBodyTooLargeError({ maxSize: 10, size: found.length });
      return found;
    };
    expect(await allLogs(request, [TRANSFER], 0n, 63n, { left: 1_000 })).toHaveLength(64);
  });

  it("calls a single block over the byte limit too big as well", async () => {
    await expect(allLogs(async () => { throw new ResponseBodyTooLargeError({ maxSize: 10, size: 11 }); }, [TRANSFER], 7n, 7n, { left: 1_000 })).rejects.toBeInstanceOf(TooBig);
  });
});

describe("a wallet too big to read", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => transfer(TOKEN, ROUTER, ME, 1n, i + 1, `0x${i.toString(16)}`));

  it("stops at the budget, instead of reading a platform's millions", async () => {
    let asked = 0;
    const request = async ({ params }: { method: string; params: unknown[] }) => {
      asked++;
      const { fromBlock, toBlock } = params[0] as { fromBlock: string; toBlock: string };
      const size = Number(BigInt(toBlock) - BigInt(fromBlock));
      if (size > 100) throw new Error("logs count limit exceeded (10000)");
      return Array.from({ length: 50 }, (_, i) => transfer(TOKEN, ROUTER, ME, 1n, i, "0xa"));
    };
    await expect(allLogs(request, [TRANSFER], 0n, 2n ** 40n, { left: 200 })).rejects.toBeInstanceOf(TooBig);
    expect(asked).toBeLessThan(80);
  });

  it("shares one budget across all its searches", async () => {
    const budget = { left: 5 };
    const request = async () => many(3);
    await allLogs(request, [TRANSFER], 0n, 9n, budget);
    await expect(allLogs(request, [APPROVAL], 0n, 9n, budget)).rejects.toBeInstanceOf(TooBig);
  });

  const stuffed = () => {
    let reads = 0;
    const { calls } = chain({ logs: [] });
    const logs: FootprintCalls["logs"] = async () => {
      reads++;
      throw new TooBig("too much history to read");
    };
    return { calls: { ...calls, logs }, reads: () => reads };
  };

  it("says so, and doesn't go back to the node for an hour", async () => {
    const { calls, reads } = stuffed();
    let time = 1_000;
    const f = new FootprintReader(facts(), calls, {}, { now: () => time });
    await expect(f.read(ME)).rejects.toBeInstanceOf(TooBig);
    const first = reads();
    time += 59 * 60_000;
    await expect(f.read(ME)).rejects.toBeInstanceOf(TooBig);
    expect(reads()).toBe(first);
    time += 2 * 60_000;
    await expect(f.read(ME)).rejects.toBeInstanceOf(TooBig);
    expect(reads()).toBeGreaterThan(first);
  });

  it("isn't taken for a node failure, and a node failure isn't taken for too big", async () => {
    const { calls } = chain({ logs: [] });
    let broken = true;
    const f = new FootprintReader(facts(), { ...calls, logs: async () => { if (broken) throw new Error("down"); return []; } });
    await expect(f.read(ME)).rejects.toThrow("down");
    broken = false;
    await expect(f.read(ME)).resolves.toMatchObject({ complete: true });
  });
});

describe("too many logs isn't a rate limit", () => {
  const answering = (body: object) => async () => new Response(JSON.stringify(body));

  it("hands it straight back, so the range can be cut without waiting two minutes", async () => {
    const waits: number[] = [];
    const fetcher = politeFetch({ fetch: answering({ jsonrpc: "2.0", id: 1, error: { code: -32005, message: "logs count limit exceeded (10000)" } }) as never, sleep: async (ms) => void waits.push(ms), minGapMs: 0 });
    await fetcher("http://node", {});
    expect(waits).toEqual([]);
  });

  it("still waits on a real rate limit with the same code", async () => {
    const waits: number[] = [];
    const fetcher = politeFetch({ fetch: answering({ jsonrpc: "2.0", id: 1, error: { code: -32005, message: "daily request count exceeded" } }) as never, sleep: async (ms) => void waits.push(ms), minGapMs: 0, retries: 2 });
    await fetcher("http://node", {});
    expect(waits).toEqual([2_000, 4_000]);
  });
});

describe("the tokens a wallet touched", () => {
  it("lists a token DELPHI never read, with what came in, went out and when", async () => {
    const f = await read({
      logs: [transfer(TOKEN, STRANGER, ME, 700n, 10, "0xa"), transfer(TOKEN, ME, STRANGER, 200n, 20, "0xb"), transfer(TOKEN, STRANGER, ME, 50n, 30, "0xc")],
      balances: { [TOKEN]: 550n },
    });
    expect(f.tokens).toHaveLength(1);
    expect(f.tokens[0]).toMatchObject({
      token: TOKEN,
      verdict: "UNKNOWN",
      holdsNow: true,
      balance: { raw: "550", amount: "0.00000000000000055" },
      received: { count: 2, raw: "750" },
      sent: { count: 1, raw: "200" },
      firstSeen: { block: "10", tx: "0xa", time: new Date((1_760_000_000 + 10) * 1000).toISOString() },
      lastSeen: { block: "30", tx: "0xc" },
    });
    expect(f.totals).toMatchObject({ tokensTouched: 1, tokensHeld: 1, heldNotRead: 1 });
  });

  it("carries DELPHI's verdict when it has one", async () => {
    const f = await read({ logs: [transfer(TOKEN, STRANGER, ME, 1n, 10, "0xa")], balances: { [TOKEN]: 1n } }, {}, facts({ [TOKEN]: "FLAG" }));
    expect(f.tokens[0]?.verdict).toBe("FLAG");
    expect(f.totals.heldNotRead).toBe(0);
  });

  it("takes the balance from the token, not from adding up logs", async () => {
    const f = await read({ logs: [transfer(TOKEN, STRANGER, ME, 700n, 10, "0xa")], balances: { [TOKEN]: 3n } });
    expect(f.tokens[0]?.balance?.raw).toBe("3");
  });

  it("marks a token it has left as touched, not held", async () => {
    const f = await read({ logs: [transfer(TOKEN, STRANGER, ME, 7n, 10, "0xa"), transfer(TOKEN, ME, STRANGER, 7n, 11, "0xb")] });
    expect(f.tokens[0]?.holdsNow).toBe(false);
    expect(f.totals).toMatchObject({ tokensTouched: 1, tokensHeld: 0 });
  });

  it("counts a send to itself once each way, not twice over", async () => {
    const f = await read({ logs: [transfer(TOKEN, ME, ME, 5n, 10, "0xa")], balances: { [TOKEN]: 5n } });
    expect(f.tokens[0]).toMatchObject({ received: { count: 1, raw: "5" }, sent: { count: 1, raw: "5" } });
  });

  it("puts held tokens first, then the most recent", async () => {
    const f = await read({ logs: [transfer(TOKEN, STRANGER, ME, 1n, 50, "0xa"), transfer(OTHER, STRANGER, ME, 1n, 10, "0xb")], balances: { [OTHER]: 1n } });
    expect(f.tokens.map((t) => t.token)).toEqual([OTHER, TOKEN]);
  });

  it("ignores zero transfers: anyone can make one 'from' any wallet", async () => {
    const f = await read({ logs: [transfer(TOKEN, ME, STRANGER, 0n, 10, "0xa")], balances: { [TOKEN]: 0n } });
    expect(f.tokens).toEqual([]);
    expect(f.totals.tokensTouched).toBe(0);
  });

  it("says unknown, never zero, when a balance can't be read", async () => {
    const f = await read({ logs: [transfer(TOKEN, STRANGER, ME, 1n, 10, "0xa")], balances: { [TOKEN]: null } });
    expect(f.tokens[0]).toMatchObject({ balance: null, holdsNow: null });
    expect(f.unread).toEqual([TOKEN]);
    expect(f.complete).toBe(false);
  });

  it("says the amount is unknown, not a wrong number, if decimals can't be read", async () => {
    const f = await read({ logs: [transfer(TOKEN, STRANGER, ME, 1n, 10, "0xa")], balances: { [TOKEN]: 5n }, meta: { [TOKEN]: { symbol: "X", name: null, decimals: null } } });
    expect(f.tokens[0]?.balance).toEqual({ raw: "5", amount: null });
  });

  it("cleans the names strangers give their tokens", async () => {
    const f = await read({ logs: [transfer(TOKEN, STRANGER, ME, 1n, 10, "0xa")], balances: { [TOKEN]: 1n }, meta: { [TOKEN]: { symbol: "A‮evil\n", name: "x".repeat(200), decimals: 18 } } });
    expect(f.tokens[0]?.symbol).toBe("A evil");
    expect(f.tokens[0]?.name).toHaveLength(40);
  });

  it("marks the network on the answer", async () => {
    expect((await read({ logs: [] })).network).toBe("testnet");
  });

  it("refuses to answer before DELPHI's coins are loaded, and doesn't guess the network", async () => {
    await expect(new FootprintReader({ ...facts(), network: () => null }, chain({ logs: [] }).calls).read(ME)).rejects.toThrow(/no coins loaded/);
  });

  it("an empty wallet is an empty answer that's complete", async () => {
    const f = await read({ logs: [] });
    expect(f).toMatchObject({ tokens: [], nfts: [], approvals: [], nftOperators: [], apps: [], unread: [], complete: true });
  });
});

describe("coins it never asked for", () => {
  it("marks a coin that only arrived in someone else's transaction, and leaves it out of the totals", async () => {
    const f = await read({ logs: [transfer(TOKEN, STRANGER, ME, 9n, 10, "0xa")], balances: { [TOKEN]: 9n }, txs: { "0xa": fromStranger } });
    expect(f.tokens[0]).toMatchObject({ sentIn: true, fromOthers: { count: 1, raw: "9" } });
    expect(f.totals).toMatchObject({ tokensTouched: 0, tokensHeld: 0, heldNotRead: 0, sentIn: 1 });
  });

  it("doesn't mark a coin it bought in its own transaction", async () => {
    const f = await read({ logs: [transfer(TOKEN, ROUTER, ME, 9n, 10, "0xa")], balances: { [TOKEN]: 9n } });
    expect(f.tokens[0]).toMatchObject({ sentIn: false, fromOthers: { count: 0, raw: "0" } });
  });

  it("a stranger's dust before a real buy doesn't turn the buy into 'sent in'", async () => {
    const f = await read({ logs: [transfer(TOKEN, STRANGER, ME, 1n, 10, "0xa"), transfer(TOKEN, ROUTER, ME, 500n, 20, "0xb")], balances: { [TOKEN]: 501n }, txs: { "0xa": fromStranger } });
    expect(f.tokens[0]).toMatchObject({ sentIn: false, fromOthers: { count: 1, raw: "1" } });
    expect(f.totals.tokensHeld).toBe(1);
  });

  it("a planted transfer 'from' the wallet can't hide a coin that was sent in", async () => {
    const f = await read({ logs: [transfer(TOKEN, STRANGER, ME, 9n, 10, "0xa"), transfer(TOKEN, ME, STRANGER, 1n, 11, "0xb")], balances: { [TOKEN]: 8n }, txs: { "0xa": fromStranger, "0xb": fromStranger } });
    expect(f.tokens[0]?.sentIn).toBe(true);
    expect(f.totals.tokensHeld).toBe(0);
  });

  it("selling part of a coin that was sent in doesn't make the rest its own", async () => {
    const f = await read({ logs: [transfer(TOKEN, STRANGER, ME, 9n, 10, "0xa"), transfer(TOKEN, ME, ROUTER, 4n, 11, "0xb")], balances: { [TOKEN]: 5n }, txs: { "0xa": fromStranger } });
    expect(f.tokens[0]?.sentIn).toBe(true);
  });

  it("can't tell, and says so, if a transaction can't be read: never 'not sent in'", async () => {
    const f = await read({ logs: [transfer(TOKEN, STRANGER, ME, 9n, 10, "0xa")], balances: { [TOKEN]: 9n }, txs: { "0xa": null } });
    expect(f.tokens[0]).toMatchObject({ sentIn: null, fromOthers: null });
    expect(f.complete).toBe(false);
  });

  it("one arrival in its own transaction settles it, even if another can't be read", async () => {
    const f = await read({ logs: [transfer(TOKEN, ROUTER, ME, 9n, 10, "0xa"), transfer(TOKEN, STRANGER, ME, 1n, 11, "0xb")], balances: { [TOKEN]: 10n }, txs: { "0xb": null } });
    expect(f.tokens[0]).toMatchObject({ sentIn: false, fromOthers: null });
  });

  it("a stranger's broken token can't mark a wallet as unread", async () => {
    const f = await read({ logs: [transfer(TOKEN, STRANGER, ME, 9n, 10, "0xa")], balances: { [TOKEN]: null }, txs: { "0xa": fromStranger } });
    expect(f.tokens[0]).toMatchObject({ balance: null, sentIn: true });
    expect(f).toMatchObject({ unread: [], complete: true });
  });

  it("does the same for NFTs", async () => {
    const f = await read({ logs: [nft(NFT, STRANGER, ME, 1n, 10, "0xa")], balances: { [NFT]: 1n }, txs: { "0xa": fromStranger } });
    expect(f.nfts[0]?.sentIn).toBe(true);
    expect(f.totals).toMatchObject({ nftCollections: 0, nftsHeld: 0, nftsSentIn: 1 });
  });
});

describe("a contract", () => {
  it("can't have a coin 'sent in', because it never sends transactions: that stays unknown", async () => {
    const { calls, asked } = chain({ logs: [transfer(TOKEN, STRANGER, ME, 9n, 10, "0xa")], balances: { [TOKEN]: 9n }, txs: { "0xa": fromStranger }, contract: true });
    const f = await new FootprintReader(facts(), calls).read(ME);
    expect(f.isContract).toBe(true);
    expect(f.tokens[0]).toMatchObject({ sentIn: null, fromOthers: null });
    expect(f.totals).toMatchObject({ tokensHeld: 1, sentIn: 0 });
    expect(f.complete).toBe(true);
    expect(asked.txs).toBe(0);
  });

  it("is told apart from a wallet", async () => {
    expect((await read({ logs: [] })).isContract).toBe(false);
  });
});

describe("telling a contract from a wallet", () => {
  const coded = (code: string | undefined) => chainFootprint({ getCode: async () => code } as never).isContract(ME);

  it("reads the address's code, and a wallet that delegates still counts as a wallet", async () => {
    expect(await coded("0x6080604052")).toBe(true);
    expect(await coded(undefined)).toBe(false);
    expect(await coded("0x")).toBe(false);
    expect(await coded(`0xef0100${"ab".repeat(20)}`)).toBe(false);
  });
});

describe("NFTs", () => {
  it("lists what it holds and drops what it let go", async () => {
    const f = await read({ logs: [nft(NFT, STRANGER, ME, 1n, 10, "0xa"), nft(NFT, STRANGER, ME, 2n, 11, "0xb"), nft(NFT, ME, STRANGER, 1n, 12, "0xc")], balances: { [NFT]: 1n } });
    expect(f.nfts[0]).toMatchObject({ collection: NFT, heldCount: 1, held: ["2"], firstSeen: { block: "10" }, lastSeen: { block: "12" } });
    expect(f.tokens).toEqual([]);
  });

  it("takes the count from the collection, so planted logs can't add to it", async () => {
    const f = await read({ logs: [nft(NFT, ROUTER, ME, 1n, 10, "0xa"), nft(NFT, ROUTER, ME, 2n, 11, "0xb")], balances: { [NFT]: 0n } });
    expect(f.nfts[0]).toMatchObject({ heldCount: 0, held: [] });
    expect(f.totals.nftsHeld).toBe(0);
  });

  it("says unknown, never zero, when the collection can't be read", async () => {
    const f = await read({ logs: [nft(NFT, ROUTER, ME, 1n, 10, "0xa")], balances: { [NFT]: null } });
    expect(f.nfts[0]?.heldCount).toBeNull();
    expect(f.unread).toEqual([NFT]);
    expect(f.complete).toBe(false);
  });
});

describe("approvals still open", () => {
  it("names the spender it knows, and flags an unlimited one", async () => {
    const f = await read({ logs: [approve(TOKEN, ROUTER, UNLIMITED, 10, "0xa")], allowances: { [`${TOKEN}:${ROUTER}`]: UNLIMITED } }, { [ROUTER]: "Ascend's router" });
    expect(f.approvals).toEqual([expect.objectContaining({ token: TOKEN, spender: ROUTER, spenderName: "Ascend's router", unlimited: true, givenAt: expect.objectContaining({ block: "10" }) })]);
    expect(f.totals).toMatchObject({ approvalsOpen: 1, unlimited: 1 });
  });

  it("asks the token what's left, so a spent or revoked approval isn't listed", async () => {
    const f = await read({ logs: [approve(TOKEN, ROUTER, 100n, 10, "0xa")], allowances: { [`${TOKEN}:${ROUTER}`]: 0n } });
    expect(f.approvals).toEqual([]);
  });

  it("gives what's left, not what was approved", async () => {
    const f = await read({ logs: [approve(TOKEN, ROUTER, 100n, 10, "0xa")], allowances: { [`${TOKEN}:${ROUTER}`]: 30n } });
    expect(f.approvals[0]).toMatchObject({ unlimited: false, allowance: { raw: "30" } });
  });

  it("lists a spender once, at its latest approval", async () => {
    const f = await read({ logs: [approve(TOKEN, ROUTER, 1n, 10, "0xa"), approve(TOKEN, ROUTER, 2n, 20, "0xb")], allowances: { [`${TOKEN}:${ROUTER}`]: 2n } });
    expect(f.approvals).toHaveLength(1);
    expect(f.approvals[0]?.givenAt.block).toBe("20");
  });

  it("keeps an approval it can't read, because it may still be open", async () => {
    const f = await read({ logs: [approve(TOKEN, ROUTER, 1n, 10, "0xa")], allowances: { [`${TOKEN}:${ROUTER}`]: null } });
    expect(f.approvals[0]).toMatchObject({ allowance: null, unlimited: null });
    expect(f.unread).toEqual([TOKEN]);
    expect(f.complete).toBe(false);
  });

  it("lists unlimited ones first", async () => {
    const f = await read({ logs: [approve(TOKEN, ROUTER, 1n, 10, "0xa"), approve(OTHER, ROUTER, UNLIMITED, 5, "0xb")], allowances: { [`${TOKEN}:${ROUTER}`]: 1n, [`${OTHER}:${ROUTER}`]: UNLIMITED } });
    expect(f.approvals.map((a) => a.token)).toEqual([OTHER, TOKEN]);
  });

  it("lists a whole-collection permission only while it's on", async () => {
    const f = await read({ logs: [forAll(NFT, ROUTER, true, 10, "0xa"), forAll(OTHER, ROUTER, true, 11, "0xb"), forAll(OTHER, ROUTER, false, 12, "0xc")] }, { [ROUTER]: "A market" });
    expect(f.nftOperators).toEqual([expect.objectContaining({ collection: NFT, operator: ROUTER, operatorName: "A market" })]);
    expect(f.totals).toMatchObject({ approvalsOpen: 1, unlimited: 1 });
  });
});

describe("apps", () => {
  it("counts each transaction once, with its first and last use", async () => {
    const f = await read({ logs: [transfer(TOKEN, ROUTER, ME, 5n, 10, "0xa"), transfer(OTHER, ME, ROUTER, 5n, 10, "0xa"), transfer(TOKEN, ME, ROUTER, 5n, 20, "0xb")], balances: { [TOKEN]: 0n } }, { [ROUTER]: "A router" });
    expect(f.apps).toEqual([expect.objectContaining({ contract: ROUTER, name: "A router", txs: 2, firstSeen: expect.objectContaining({ block: "10" }), lastSeen: expect.objectContaining({ block: "20" }) })]);
  });

  it("leaves out other people's transactions", async () => {
    const f = await read({ logs: [transfer(TOKEN, STRANGER, ME, 5n, 10, "0xa")], txs: { "0xa": fromStranger } });
    expect(f.apps).toEqual([]);
  });

  it("leaves out tokens themselves: an approval isn't using an app", async () => {
    const f = await read({ logs: [approve(TOKEN, ROUTER, 1n, 10, "0xa")], allowances: { [`${TOKEN}:${ROUTER}`]: 1n }, txs: { "0xa": { from: ME, to: TOKEN } } });
    expect(f.apps).toEqual([]);
  });

  it("leaves a contract it can't name unnamed", async () => {
    const f = await read({ logs: [transfer(TOKEN, ROUTER, ME, 5n, 10, "0xa")] });
    expect(f.apps[0]).toMatchObject({ contract: ROUTER, name: null });
  });
});

describe("remembering", () => {
  it("asks the chain once for a burst of reads, and learns a token's name once ever", async () => {
    const { calls, asked } = chain({ logs: [transfer(TOKEN, ROUTER, ME, 5n, 10, "0xa")] });
    let time = 0;
    const f = new FootprintReader(facts(), calls, {}, { now: () => time, ttlMs: 10 });
    await Promise.all([f.read(ME), f.read(ME), f.read(ME.toUpperCase().replace("0X", "0x"))]);
    expect(asked.logs).toBe(4);
    time = 1_000;
    await f.read(ME);
    expect(asked.logs).toBe(8);
    expect(asked.meta).toBe(1);
  });

  it("remembers nothing when the chain fails", async () => {
    const { calls } = chain({ logs: [] });
    let broken = true;
    const f = new FootprintReader(facts(), { ...calls, head: async () => { if (broken) throw new Error("down"); return 1n; } });
    await expect(f.read(ME)).rejects.toThrow("down");
    broken = false;
    await expect(f.read(ME)).resolves.toMatchObject({ complete: true });
  });
});

describe("the names we give contracts", () => {
  it("names ours and Ascend's, in lower case to match the chain, and nothing else", () => {
    const named = knownContracts({ staking: "0x30c88fce1fAD545Df0fC603287f93F0f94076224", indexVault: "0xE636003Feb05D0FB8f6016733C3d723446C9f221" });
    expect(named["0x30c88fce1fad545df0fc603287f93f0f94076224"]).toBe("PANTHEON staking");
    expect(named["0xe636003feb05d0fb8f6016733c3d723446c9f221"]).toBe("PANTHEON's basket vault");
    expect(Object.keys(named).every((a) => a === a.toLowerCase())).toBe(true);
  });
});

describe("asking the server", () => {
  const verdicts = new Verdicts(new URL("./fixtures/scan.json", import.meta.url).pathname);
  verdicts.refresh();

  it("answers with the footprint, and refuses a bad address", async () => {
    const footprint = new FootprintReader(facts(), chain({ logs: [transfer(TOKEN, ROUTER, ME, 5n, 10, "0xa")] }).calls);
    const app = buildApp(verdicts, { footprint });
    const ok = await app.inject({ url: `/wallets/${ME}/footprint` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().totals.tokensTouched).toBe(1);
    expect((await app.inject({ url: "/wallets/0x123/footprint" })).statusCode).toBe(400);
  });

  it("answers 503 when the chain fails, never an empty footprint, and keeps the error to itself", async () => {
    const { calls } = chain({ logs: [] });
    const app = buildApp(verdicts, { footprint: new FootprintReader(facts(), { ...calls, head: () => Promise.reject(new Error("secret node detail")) }) });
    const res = await app.inject({ url: `/wallets/${ME}/footprint` });
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toContain("secret node detail");
  });

  it("answers 422 TOO_BIG for a platform's contract, not as if the chain were down", async () => {
    const { calls } = chain({ logs: [] });
    const app = buildApp(verdicts, { footprint: new FootprintReader(facts(), { ...calls, logs: () => Promise.reject(new TooBig("x")) }) });
    const res = await app.inject({ url: `/wallets/${ME}/footprint` });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: "TOO_BIG" });
  });

  it("has no route for other chains unless they're turned on", async () => {
    expect((await buildApp(verdicts, {}).inject({ url: `/wallets/${ME}/elsewhere` })).statusCode).toBe(404);
  });
});
