import testnet from "./elysium-testnet.json";
import local from "./local.json";

/** PANTHEON's contract addresses per network, written by `script/Deploy.s.sol`. */
export type Deployment = {
  chainId: number;
  launchpad: `0x${string}`;
  usdc: `0x${string}`;
  burnSink: `0x${string}`;
  passportRegistry: `0x${string}`;
  covenantFactory: `0x${string}`;
  pnth: `0x${string}`;
  pnthPool: `0x${string}`;
  pnthRouter: `0x${string}`;
  constituentRegistry: `0x${string}`;
  staking: `0x${string}`;
  indexVault: `0x${string}`;
  /** A small verified swap helper (testnet): buys PNTH straight from its Ascend pool. */
  swapper?: `0x${string}`;
  /** Testnet only: free PNTH once per wallet, for when PNTH's pool is sold out. */
  drip?: `0x${string}`;
};

// "elysium-testnet" is the live deployment (Oct 14, verified on the explorer). "local" is the private
// copy of testnet on our server, for development only.
export const DEPLOYMENTS: Record<string, Deployment | undefined> = {
  "elysium-testnet": testnet as Deployment,
  local: local as Deployment,
};
