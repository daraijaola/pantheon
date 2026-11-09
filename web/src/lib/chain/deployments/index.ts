import testnet from "../../../../../deployments/elysium-testnet.json";
import mainnet from "../../../../../deployments/elysium-mainnet.json";
import local from "./local.json";
import { validateDeployment } from "../network-profile";

export type { Deployment } from "../network-profile";

// "elysium-testnet" is the live deployment (Oct 14, verified on the explorer). "local" is the private
// copy of testnet on our server, for development only.
export const deploymentName = process.env.NEXT_PUBLIC_DEPLOYMENT ?? "elysium-testnet";
const manifests: Record<string, unknown> = {
  "elysium-testnet": testnet,
  "elysium-mainnet": mainnet,
  local: { ...local, network: { ...testnet.network, deployedFrom: 9_100_000 } },
};
export const selectedDeployment = validateDeployment(deploymentName, manifests[deploymentName]);
export const network = selectedDeployment.network;
