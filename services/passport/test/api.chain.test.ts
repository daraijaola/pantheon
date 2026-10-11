// §13 P7 acceptance on a real chain: anvil (chain id 99801) running the reference
// HypePassportRegistry. Skipped if Foundry (anvil + forge) is not installed.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, toHex, type Abi, type Address, type Hex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toSignable } from "../src/eip712.ts";
import { createRegistryReader, elysiumTestnet, registryAbi } from "../src/registry.ts";
import { ELY, ELY2, harness, HL_T2, key } from "./harness.ts";

const PATH = `${process.env.PATH}:${homedir()}/.foundry/bin`;
const has = (bin: string) => spawnSync(bin, ["--version"], { env: { ...process.env, PATH } }).status === 0;
const CHECK_DIR = fileURLToPath(new URL("../contracts-check/", import.meta.url));
const ARTIFACT = `${CHECK_DIR}out/HypePassportRegistry.sol/HypePassportRegistry.json`;
const foundry = has("anvil") && has("forge");

describe.skipIf(!foundry)("API against a real registry on anvil (§13 P7)", () => {
  let anvil: ChildProcess;
  let rpc: string;
  let registryAddress: Address;
  let h: Awaited<ReturnType<typeof harness>>;
  const attestor = key(7);
  const chain = () => elysiumTestnet(rpc);
  const wallet = (who: typeof ELY) => createWalletClient({ account: who, chain: chain(), transport: http(rpc) });
  const reader = () => createPublicClient({ chain: chain(), transport: http(rpc) });

  beforeAll(async () => {
    if (!existsSync(ARTIFACT)) spawnSync("forge", ["build"], { cwd: CHECK_DIR, env: { ...process.env, PATH }, stdio: "ignore" });
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    rpc = `http://127.0.0.1:${port}`;
    anvil = spawn("anvil", ["--host", "127.0.0.1", "--port", String(port), "--chain-id", "99801", "--silent"], { env: { ...process.env, PATH } });
    for (let i = 0; i < 100; i++) {
      try {
        await reader().getBlockNumber();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const { abi, bytecode } = JSON.parse(readFileSync(ARTIFACT, "utf8")) as { abi: Abi; bytecode: { object: Hex } };
    const deployer = wallet(key(9)); // anvil funds the mnemonic's first 10 accounts
    const tx = await deployer.deployContract({ abi, bytecode: bytecode.object, args: [attestor.address, key(8).address] });
    registryAddress = (await reader().waitForTransactionReceipt({ hash: tx })).contractAddress!;

    // The service reads the real registry; its clock is the chain's, so deadlines line up.
    const block = await reader().getBlock();
    h = await harness({
      registry: createRegistryReader(reader(), registryAddress),
      attestorKey: toHex(attestor.getHdKey().privateKey!),
      nowMs: Number(block.timestamp) * 1000,
    });
  }, 60_000);

  afterAll(async () => {
    await h?.close();
    anvil?.kill();
  });

  const post = (url: string, payload: object) => h.app.inject({ method: "POST", url, payload });

  it("challenge → sign → verify → submit → GET shows the tier from the chain", async () => {
    const c = (await post("/passport/challenge", { hyperliquidAccount: HL_T2.address, elysiumAccount: ELY.address })).json();
    const td = toSignable(c.typedData);
    const v = await post("/passport/verify", { nonce: c.nonce, hlSignature: await HL_T2.signTypedData(td), elysiumSignature: await ELY.signTypedData(td) });
    expect(v.statusCode).toBe(200);
    const { attestation: a, signature } = v.json();

    // The user's wallet submits it, as the UI does with relay: false (wagmi writeContract).
    const args = [{ ...a, issuedAt: BigInt(a.issuedAt), expiry: BigInt(a.expiry), deadline: BigInt(a.deadline), chainId: BigInt(a.chainId) }, signature];
    const hash = await wallet(ELY).writeContract({ address: registryAddress, abi: registryAbi, functionName: "submit", args } as never);
    expect((await reader().waitForTransactionReceipt({ hash })).status).toBe("success");

    const g = await h.app.inject({ method: "GET", url: `/passport/${ELY.address}` });
    expect(g.json()).toMatchObject({ address: ELY.address, valid: true, tier: 2, stamps: 189, multiplier: "1.20", source: "chain" });
    for (const body of [v.body, g.body]) {
      expect(body.toLowerCase()).not.toContain(HL_T2.address.toLowerCase().slice(2));
      expect(body).not.toMatch(/score|balance/i);
    }
    expect(await reader().readContract({ address: registryAddress, abi: registryAbi, functionName: "multiplierOf", args: [ELY.address] })).toBe(12n * 10n ** 17n);
  });

  it("enforces the real registry's binding rules at /challenge", async () => {
    const taken = await post("/passport/challenge", { hyperliquidAccount: HL_T2.address, elysiumAccount: ELY2.address });
    expect([taken.statusCode, taken.json().error]).toEqual([409, "HL_ALREADY_LINKED"]);

    const hash = await wallet(ELY).writeContract({ address: registryAddress, abi: registryAbi, functionName: "unlink", args: [] });
    await reader().waitForTransactionReceipt({ hash });
    const cooling = await post("/passport/challenge", { hyperliquidAccount: HL_T2.address, elysiumAccount: ELY2.address });
    expect([cooling.statusCode, cooling.json().error]).toEqual([409, "REBIND_COOLDOWN"]);
    expect(Number(cooling.headers["retry-after"])).toBeGreaterThan(6 * 86_400);
  });
});
