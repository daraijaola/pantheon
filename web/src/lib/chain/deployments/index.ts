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
};

// "local" is the private copy of testnet on our server (dev only). The live testnet deployment is
// added here once it exists; until then the app says PANTHEON isn't live yet.
export const DEPLOYMENTS: Record<string, Deployment | undefined> = {
  local: local as Deployment,
  "elysium-testnet": undefined,
};
