// The whole service on a real chain: API + real relayer + scheduler + real registry and Multicall3
// on anvil (chain id 99801), with the service clock moved together with the chain's. HL and HyperEVM
// are the fixture mocks. Skipped without Foundry.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, nonceManager, toHex, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toSignable } from "../src/eip712.ts";
import { createRegistryReader, elysiumTestnet, registryAbi } from "../src/registry.ts";
import { ElysiumRelayer } from "../src/relayer.ts";
import { ELY, harness, HL_T2, key } from "./harness.ts";

const PATH = `${process.env.PATH}:${homedir()}/.foundry/bin`;
const has = (bin: string) => spawnSync(bin, ["--version"], { env: { ...process.env, PATH } }).status === 0;
const CHECK_DIR = fileURLToPath(new URL("../contracts-check/", import.meta.url));
const ARTIFACT = `${CHECK_DIR}out/HypePassportRegistry.sol/HypePassportRegistry.json`;
const DAY_S = 86_400;

describe.skipIf(!(has("anvil") && has("forge")))("whole service on a real chain", () => {
  let anvil: ChildProcess;
  let rpc: string;
  let registry: Address;
  let h: Awaited<ReturnType<typeof harness>>;
  const attestor = key(7);
  const chain = () => elysiumTestnet(rpc);
  // Like production: multicall-batched reads (Multicall3 is installed at its canonical address).
  const client = () => createPublicClient({ chain: chain(), transport: http(rpc), batch: { multicall: true } });
  const tierOnChain = (a: Address) => client().readContract({ address: registry, abi: registryAbi, functionName: "passportOf", args: [a] });

  /** Move the chain and the service clock forward together. */
  async function advance(sec: number) {
    await client().request({ method: "evm_increaseTime" as never, params: [toHex(sec)] as never });
    await client().request({ method: "evm_mine" as never, params: [] as never });
    h.clock.ms = Number((await client().getBlock()).timestamp) * 1000;
  }

  beforeAll(async () => {
    if (!existsSync(ARTIFACT)) spawnSync("forge", ["build"], { cwd: CHECK_DIR, env: { ...process.env, PATH }, stdio: "ignore" });
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    rpc = `http://127.0.0.1:${port}`;
    anvil = spawn("anvil", ["--host", "127.0.0.1", "--port", String(port), "--chain-id", "99801", "--silent"], { env: { ...process.env, PATH } });
    for (let i = 0; i < 100; i++) {
      try {
        await createPublicClient({ transport: http(rpc) }).getBlockNumber();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const code = readFileSync(new URL("./fixtures/multicall3.runtime.hex", import.meta.url), "utf8").trim() as Hex;
    await client().request({ method: "anvil_setCode" as never, params: ["0xcA11bde05977b3631167028862bE2a173976CA11", code] as never });
    const { abi, bytecode } = JSON.parse(readFileSync(ARTIFACT, "utf8")) as { abi: Abi; bytecode: { object: Hex } };
    const deployer = createWalletClient({ account: key(9), chain: chain(), transport: http(rpc) });
    registry = (await client().waitForTransactionReceipt({
      hash: await deployer.deployContract({ abi, bytecode: bytecode.object, args: [attestor.address, key(8).address] }),
    })).contractAddress!;

    const relayer = new ElysiumRelayer({
      wallet: createWalletClient({ account: privateKeyToAccount(toHex(key(6).getHdKey().privateKey!), { nonceManager }), chain: chain(), transport: http(rpc) }),
      client: client(),
      registry,
    });
    h = await harness({
      registry: createRegistryReader(client(), registry),
      relayer,
      attestorKey: toHex(attestor.getHdKey().privateKey!),
      nowMs: Number((await client().getBlock()).timestamp) * 1000,
    });
  }, 60_000);

  afterAll(async () => {
    await h?.close();
    anvil?.kill();
  });

  it("links with relay, downgrades a day later in a batch, and follows an on-chain unlink", async () => {
    // 1. Link through the API; the relayer submits it.
    const c = await h.app.inject({ method: "POST", url: "/passport/challenge", payload: { hyperliquidAccount: HL_T2.address, elysiumAccount: ELY.address } });
    const td = toSignable(c.json().typedData);
    const v = await h.app.inject({
      method: "POST",
      url: "/passport/verify",
      payload: { nonce: c.json().nonce, hlSignature: await HL_T2.signTypedData(td), elysiumSignature: await ELY.signTypedData(td), relay: true },
    });
    expect(v.json().txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect((await tierOnChain(ELY.address)).tier).toBe(2);
    expect((await h.app.inject({ method: "GET", url: "/health" })).json().relayerBalance).toMatch(/^\d+$/);

    // 2. The account's stake drops; at the next re-check the scheduler relays the downgrade.
    h.fixtures.t2!.delegatorSummary = { delegated: "15.0", undelegated: "0.0", totalPendingWithdrawal: "0.0", nPendingWithdrawals: 0 };
    await advance(DAY_S);
    expect(await h.scheduler().runOnce()).toMatchObject({ checked: 1, signed: 1, relayed: 1, failed: 0 });
    expect((await tierOnChain(ELY.address)).tier).toBe(1);

    // 3. The user unlinks on chain; the scheduler reads the real Unlinked event and stops re-checking.
    const user = createWalletClient({ account: ELY, chain: chain(), transport: http(rpc) });
    await client().waitForTransactionReceipt({ hash: await user.writeContract({ address: registry, abi: registryAbi, functionName: "unlink", args: [] }) });
    expect((await h.scheduler().runOnce()).unlinked).toBe(1);
    expect(h.service.deps.store.bindingByElysium(ELY.address)).toBeUndefined();
    expect(h.service.pokes(0).accounts).toContain(ELY.address);
  }, 60_000);
});
