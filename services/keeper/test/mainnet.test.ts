import { encodeAbiParameters, encodeEventTopics, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { effectsOf, seatAbi, vaultAbi, type Effects } from "../src/chain.ts";
import { tick } from "../src/keeper.ts";
import type { Kind } from "../src/plan.ts";
import { addr, cfg, DEP, fakeChain, none } from "./fakes.ts";

const deployment = { ...DEP, chainId: 99901, pnthRouter: null, creatorSeat: addr(100), creatorEscrow: addr(101) };
const state = () => ({ stakedCursor: "100", stakers: [], sweep: 0, pokesSince: 0 });
const pokes = async () => ({ accounts: [], until: 0 });

describe("V5 mainnet crank", () => {
  it("simulates harvest, fixed team claim, vault pull and rebalance in order; rechecks before sending", async () => {
    const effects: Partial<Record<Kind, Effects>> = {
      harvest: { ...none(), arrived: 100n },
      "claim-team": { ...none(), payees: [{ slot: 0n, account: addr(1), amount: 15n }] },
      "claim-fees": { ...none(), feesClaimed: 85n },
      rebalance: { ...none(), streamed: [{ token: DEP.usdc, amount: 85n }] },
    };
    const { chain, log } = fakeChain({ effects });
    const send = chain.send;
    chain.send = async call => {
      const result = await send(call);
      effects[call.kind as keyof typeof effects] = none();
      return result;
    };
    const config = cfg({ deployment, mode: "live" });
    await tick({ cfg: config, chain, pokes, state: state(), sender: addr(1) });
    expect(log.requests[0]!.map(c => c.functionName)).toEqual(["harvest", "claim", "claimFees", "rebalance"]);
    expect(log.requests[0]![1]!.args).toEqual([0n, false]);
    expect(log.sent.map(c => c.kind)).toEqual(["harvest", "claim-team", "claim-fees", "rebalance"]);
    expect(log.requests.slice(1).every(r => r.length === 1)).toBe(true);
    const again = await tick({ cfg: config, chain, pokes, state: state(), sender: addr(1) });
    expect(again.sent).toEqual([]);
    expect(again.calls.slice(0, 3).every(c => !c.worthSending && c.lines.length === 0)).toBe(true);
  });

  it("never sends failed claims or an empty harvest", async () => {
    const { chain, log } = fakeChain({ failing: ["claim-team", "claim-fees"] });
    const report = await tick({ cfg: cfg({ deployment, mode: "live" }), chain, pokes, state: state(), sender: addr(1) });
    expect(log.sent).toEqual([]);
    expect(report.calls.every(c => !c.worthSending)).toBe(true);
  });
  it("persists a V5 breaker reset even without a buy, without changing testnet selection", async () => {
    const effects = { rebalance: { ...none(), skips: [{ token: addr(9), reason: "BREAKER" as const }] } };
    const mainnet = fakeChain({ effects });
    const testnet = fakeChain({ effects });
    await tick({ cfg: cfg({ deployment, mode: "live" }), chain: mainnet.chain, pokes, state: state(), sender: addr(1) });
    await tick({ cfg: cfg({ mode: "live" }), chain: testnet.chain, pokes, state: state(), sender: addr(1) });
    expect(mainnet.log.sent.map(c => c.kind)).toEqual(["rebalance"]);
    expect(testnet.log.sent).toEqual([]);
  });

  it("does not send a claim another crank emptied after the bundle simulation", async () => {
    const { chain, log } = fakeChain({ effects: { "claim-fees": { ...none(), feesClaimed: 85n } } });
    const simulate = chain.simulate;
    chain.simulate = async (calls, sender) => (await simulate(calls, sender)).map(s => calls.length === 1 ? { ...s, effects: none() } : s);
    await tick({ cfg: cfg({ deployment, mode: "live" }), chain, pokes, state: state(), sender: addr(1) });
    expect(log.sent).toEqual([]);
  });

  it("decodes quote payments only from the configured seat and vault", () => {
    const log = {
      address: deployment.creatorSeat,
      topics: encodeEventTopics({ abi: seatAbi, eventName: "PayeeClaimed", args: { slot: 0n, account: addr(1) } }) as Hex[],
      data: encodeAbiParameters([{ type: "bool" }, { type: "uint256" }], [false, 15n]),
    };
    const from = { seat: deployment.creatorSeat, vault: deployment.indexVault, staking: deployment.staking };
    expect(effectsOf([log], from).payees?.[0]?.amount).toBe(15n);
    expect(effectsOf([{ ...log, address: addr(99) }], from).payees).toBeUndefined();
    expect(effectsOf([{ ...log, data: "0x" }], from).payees).toBeUndefined();
    const fee = { address: deployment.indexVault, topics: encodeEventTopics({ abi: vaultAbi, eventName: "FeesClaimed" }) as Hex[], data: encodeAbiParameters([{ type: "uint256" }], [85n]) };
    expect(effectsOf([fee], from).feesClaimed).toBe(85n);
  });
});
