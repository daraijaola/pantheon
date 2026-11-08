import "server-only";
import { createPublicClient, http } from "viem";
import { connection } from "next/server";
import { deployment, elysium } from "./chain/config";
import { hypePassportRegistryAbi } from "./chain/abi";
import { registryView } from "@/components/passport-book/view";

export async function readPublicPassport(address: `0x${string}`) {
  await connection();
  if (!deployment) throw new Error("Registry unavailable");
  const client = createPublicClient({ chain: elysium, transport: http(process.env.ELYSIUM_RPC ?? elysium.rpcUrls.default.http[0], { timeout: 4000, retryCount: 0 }) });
  const contract = { address: deployment.passportRegistry, abi: hypePassportRegistryAbi };
  const [p, valid, multiplier] = await client.multicall({ allowFailure: false, contracts: [
    { ...contract, functionName: "passportOf", args: [address] },
    { ...contract, functionName: "isValid", args: [address] },
    { ...contract, functionName: "multiplierOf", args: [address] },
  ] });
  return registryView(address, p, valid, multiplier);
}
