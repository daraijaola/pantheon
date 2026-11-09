import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeAbiParameters, encodeEventTopics, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { ESCROW_LAUNCHED, HOOK_SWAP, V4_INITIALIZE, V4_SWAP, V5_LAUNCHED } from "../src/chain.ts";
import { decodeHookSwap, decodeLaunch, decodePool, decodeSwap, joinEscrowLaunches, mergeV5Swaps, type Swap } from "../src/ingest.ts";
import type { RawLog } from "../src/store.ts";

const addr = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}`;
const hash = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const base = { tx: hash(1), block: 3120163n, logIndex: 1, address: addr(1) };
const launch: RawLog = { ...base, topics: encodeEventTopics({ abi: [V5_LAUNCHED], eventName: "Launched", args: { poolId: hash(2), token: addr(2), creator: addr(3) } }) as Hex[], data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint24" }, { type: "uint24" }], [addr(4), 10n ** 27n, 0n, 15000, 0]) };
const route: RawLog = { ...base, logIndex: 2, topics: encodeEventTopics({ abi: [ESCROW_LAUNCHED], eventName: "EscrowLaunched", args: { poolId: hash(2), escrow: addr(3), recipient: addr(5) } }) as Hex[], data: encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "address" }, { type: "bool" }], [addr(6), addr(0), addr(7), false]) };

describe("V5 Ascend readers", () => {
  it("joins creator escrow and seat to the actual developer, without changing unmatched/direct launches", () => {
    const l = decodeLaunch(launch, 99901);
    expect(joinEscrowLaunches([l], [route])[0]).toMatchObject({ creator: addr(6), escrow: addr(3), recipient: addr(5) });
    expect(joinEscrowLaunches([l], [])).toEqual([l]);
    expect(joinEscrowLaunches([l], [{ ...route, tx: hash(99) }])).toEqual([l]);
    expect(() => decodeLaunch({ ...launch, data: "0x" }, 99901)).toThrow();
  });

  it("decodes the exact V4 Initialize key", () => {
    const log: RawLog = { ...base, topics: encodeEventTopics({ abi: [V4_INITIALIZE], eventName: "Initialize", args: { id: hash(2), currency0: addr(2), currency1: addr(4) } }) as Hex[], data: encodeAbiParameters([{ type: "uint24" }, { type: "int24" }, { type: "address" }, { type: "uint160" }, { type: "int24" }], [0x800000, 200, addr(1), 1n, -400600]) };
    expect(decodePool(log, 99901)).toEqual({ poolId: hash(2), currency0: addr(2), currency1: addr(4), hooks: addr(1) });
  });

  it("combines AMM caller deltas minus hook deltas once, including inventory-only swaps", () => {
    const pm: RawLog = { ...base, logIndex: 5, topics: encodeEventTopics({ abi: [V4_SWAP], eventName: "Swap", args: { id: hash(2), sender: addr(8) } }) as Hex[], data: encodeAbiParameters([{ type: "int128" }, { type: "int128" }, { type: "uint160" }, { type: "uint128" }, { type: "int24" }, { type: "uint24" }], [18184189802378100528339434n, -74250000n, 161571829104062828236n, 2002332385529805675n, -400233, 0]) };
    const hook: RawLog = { ...base, logIndex: 6, topics: encodeEventTopics({ abi: [HOOK_SWAP], eventName: "HookSwap", args: { poolId: hash(2), sender: addr(8) } }) as Hex[], data: encodeAbiParameters([{ type: "int128" }, { type: "int128" }, { type: "uint128" }, { type: "uint128" }], [0n, 750000n, 0n, 750000n]) };
    const core = decodeSwap(pm, 99901);
    const fee = decodeHookSwap(hook);
    const ids = new Set([hash(2)]);
    const trades = mergeV5Swaps([core], [fee], ids);
    expect(trades).toHaveLength(1);
    expect(trades[0]!.amount1).toBe(-75000000n);
    expect(trades[0]!.amount0).toBe(core.amount0);
    const outside: Swap = { ...core, poolId: hash(99) };
    expect(mergeV5Swaps([outside], [], ids)).toEqual([outside]);
    expect(mergeV5Swaps([], [], ids)).toEqual([]);
    expect(mergeV5Swaps([], [{ ...fee, amount0: -100n, amount1: 50n }], ids)[0]).toMatchObject({ amount0: 100n, amount1: -50n });
    const later = { ...core, logIndex: 8, amount1: -1000n };
    const laterFee = { ...fee, logIndex: 9, amount1: 10n };
    expect(mergeV5Swaps([later, core], [laterFee, fee], ids).map(s => s.amount1)).toEqual([-75000000n, -1010n]);
    expect(() => mergeV5Swaps([core], [{ ...fee, sender: addr(99) }], ids)).toThrow(/missing its HookSwap/);
    expect(() => mergeV5Swaps([core], [], ids)).toThrow(/missing its HookSwap/);
  });

  it("boots the selected mainnet readers without unpublished venues or legacy custody getters", () => {
    const dir = mkdtempSync(join(tmpdir(), "pantheon-v5-readers-"));
    try {
      const p = JSON.parse(readFileSync(new URL("../../../deployments/elysium-mainnet.json", import.meta.url), "utf8"));
      Object.assign(p.network, { explorerUrl: "https://explorer.invalid", explorerApi: "https://explorer.invalid/api", archiveRpc: "http://127.0.0.1:1", creationExplorer: "https://explorer.invalid" });
      const path = join(dir, "elysium-mainnet.json");
      writeFileSync(path, JSON.stringify(p));
      const source = `
        import assert from 'node:assert/strict';
        const { profile } = await import('../../services/network.mts');
        const { ascendEvents, launchpadAddresses } = await import('./src/chain.ts');
        const { DEFAULT_LAUNCHPAD, ascendLaunch, OFFICIAL_TOKENS } = await import('./src/safety.ts');
        const { PERPME } = await import('./src/perpme.ts');
        const { KALOS } = await import('./src/kalos.ts');
        assert.equal(ascendEvents().launched.inputs.length, 8);
        assert.equal(DEFAULT_LAUNCHPAD, profile().launchpad);
        assert.equal(KALOS.factory, null); assert.equal(PERPME.launchFactory, null);
        assert(!OFFICIAL_TOKENS.some(t => t.address.toLowerCase() === '0x048aceb334cb1835dc897a749c5985e169eab1c5'));
        const calls=[];
        await launchpadAddresses({readContract: async q => { calls.push(q.functionName); return profile().network.external.ascend.poolManager; }}, DEFAULT_LAUNCHPAD);
        assert.deepEqual(calls, ['poolManager']);
        const launch=${JSON.stringify({ topics: launch.topics, data: launch.data, transactionHash: launch.tx, blockNumber: "0x2f9c23" })};
        const route=${JSON.stringify({ topics: route.topics, data: route.data, transactionHash: route.tx, blockNumber: "0x2f9c23" })};
        const rpc={call: async (_m, [q]) => q.address === DEFAULT_LAUNCHPAD ? [launch] : [route]};
        const result=await ascendLaunch(rpc, DEFAULT_LAUNCHPAD, '${addr(2)}', '0x2f9da4');
        assert.equal(result.creator, '${addr(6)}');
        console.log('PASS selected mainnet V5 custody, event and safety paths; unpublished venues disabled');
      `;
      const output = execFileSync(process.execPath, ["--input-type=module", "-e", source], { cwd: new URL("..", import.meta.url), env: { PATH: process.env.PATH, NETWORK: "mainnet", DEPLOYMENT_FILE: path }, encoding: "utf8" });
      expect(output).toContain("PASS selected mainnet V5");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
