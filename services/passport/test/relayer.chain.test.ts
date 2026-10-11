// The real ElysiumRelayer against real contracts on anvil (chain id 99801): the reference
// HypePassportRegistry and the canonical Multicall3 runtime code. Skipped without Foundry.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, keccak256, nonceManager, toHex, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildAttestation, signAttestation } from "../src/attest.ts";
import { elysiumTestnet, registryAbi } from "../src/registry.ts";
import { ElysiumRelayer } from "../src/relayer.ts";
import { key } from "./harness.ts";

const PATH = `${process.env.PATH}:${homedir()}/.foundry/bin`;
const has = (bin: string) => spawnSync(bin, ["--version"], { env: { ...process.env, PATH } }).status === 0;
const CHECK_DIR = fileURLToPath(new URL("../contracts-check/", import.meta.url));
const ARTIFACT = `${CHECK_DIR}out/HypePassportRegistry.sol/HypePassportRegistry.json`;
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as Address;
/** Runtime code hash of Multicall3 on Elysium, Ethereum and HyperEVM (checked live 2026-10-11). */
const MULTICALL3_CODEHASH = "0xd5c15df687b16f2ff992fc8d767b4216323184a2bbc6ee2f9c398c318e770891";

describe.skipIf(!(has("anvil") && has("forge")))("ElysiumRelayer on a real chain", () => {
  let anvil: ChildProcess;
  let rpc: string;
  let registry: Address;
  let relayer: ElysiumRelayer;
  let nowSec: number;
  const attestor = key(7);
  const client = () => createPublicClient({ chain: elysiumTestnet(rpc), transport: http(rpc) });
  const tierOf = (a: Address) => client().readContract({ address: registry, abi: registryAbi, functionName: "isValid", args: [a] });

  beforeAll(async () => {
    if (!existsSync(ARTIFACT)) spawnSync("forge", ["build"], { cwd: CHECK_DIR, env: { ...process.env, PATH }, stdio: "ignore" });
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    rpc = `http://127.0.0.1:${port}`;
    anvil = spawn("anvil", ["--host", "127.0.0.1", "--port", String(port), "--chain-id", "99801", "--silent"], { env: { ...process.env, PATH } });
    for (let i = 0; i < 100; i++) {
      try {
        await client().getBlockNumber();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const code = readFileSync(new URL("./fixtures/multicall3.runtime.hex", import.meta.url), "utf8").trim() as Hex;
    expect(keccak256(code)).toBe(MULTICALL3_CODEHASH);
    await client().request({ method: "anvil_setCode" as never, params: [MULTICALL3, code] as never });

    const { abi, bytecode } = JSON.parse(readFileSync(ARTIFACT, "utf8")) as { abi: Abi; bytecode: { object: Hex } };
    const deployer = createWalletClient({ account: key(9), chain: elysiumTestnet(rpc), transport: http(rpc) });
    const tx = await deployer.deployContract({ abi, bytecode: bytecode.object, args: [attestor.address, key(8).address] });
    registry = (await client().waitForTransactionReceipt({ hash: tx })).contractAddress!;

    // The relayer is a plain funded key with viem's nonce manager, as in production.
    const account = privateKeyToAccount(toHex(key(6).getHdKey().privateKey!), { nonceManager });
    relayer = new ElysiumRelayer({
      wallet: createWalletClient({ account, chain: elysiumTestnet(rpc), transport: http(rpc) }),
      client: client(),
      registry,
    });
    nowSec = Number((await client().getBlock()).timestamp);
  }, 60_000);

  afterAll(() => anvil?.kill());

  const signed = async (i: number, opts: { tier?: number; lateBy?: number; wrongSigner?: boolean } = {}) => {
    const account = key(20 + i).address;
    const a = buildAttestation({ account, hlKey: keccak256(toHex(`hl-${i}`)), tier: opts.tier ?? 2, stamps: 5 }, nowSec - (opts.lateBy ?? 0));
    return { attestation: a, signature: await signAttestation(opts.wrongSigner ? key(10) : attestor, registry, a) };
  };

  it("submits one attestation and only reports success once the passport is issued", async () => {
    const { attestation, signature } = await signed(1);
    const hash = await relayer.submit(attestation, signature);
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await tierOf(attestation.account)).toBe(true);
    await expect(relayer.submit(attestation, signature)).rejects.toThrow(); // replay: StaleAttestation
  });

  it("batches through Multicall3: good ones land, bad ones come back with the registry's reason", async () => {
    const items = [await signed(2), await signed(3), await signed(4, { lateBy: 7_200 }), await signed(5, { wrongSigner: true }), await signed(6, { tier: 3 })];
    const results = await relayer.submitMany(items);
    expect(results.map((r) => (r.ok ? "ok" : r.reason))).toEqual(["ok", "ok", "DeadlinePassed", "BadSignature", "ok"]);
    const okHashes = new Set(results.filter((r) => r.ok).map((r) => (r as { txHash: Hex }).txHash));
    expect(okHashes.size).toBe(1); // one transaction for the whole batch
    for (const i of [0, 1, 4]) expect(await tierOf(items[i]!.attestation.account)).toBe(true);
    for (const i of [2, 3]) expect(await tierOf(items[i]!.attestation.account)).toBe(false);
  });

  it("sends parallel submits without nonce clashes, and reports its gas balance", async () => {
    const [a, b] = [await signed(7), await signed(8)];
    await Promise.all([relayer.submit(a.attestation, a.signature), relayer.submit(b.attestation, b.signature)]);
    expect(await tierOf(a.attestation.account)).toBe(true);
    expect(await tierOf(b.attestation.account)).toBe(true);
    expect(await relayer.balance()).toBeGreaterThan(0n);
  });
});
