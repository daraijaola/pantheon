export type Address = `0x${string}`;
export type Network = {
  chainId: number;
  name: string;
  testnet: boolean;
  publicRpc: string;
  explorerUrl: string;
  deployedFrom: number;
  external: { usdc: Address; whype: Address; multicall3: Address; ascendLaunchpad: Address; ascendRouter: Address };
  acquireUrl: string | null;
};
export type Deployment = {
  chainId: number;
  launchpad: Address;
  usdc: Address;
  burnSink: Address;
  passportRegistry: Address;
  covenantFactory: Address;
  pnth: Address;
  pnthPool: Address;
  pnthRouter: Address;
  creatorSeat?: Address;
  creatorEscrow?: Address;
  constituentRegistry: Address;
  staking: Address;
  indexVault: Address;
  swapper?: Address;
  drip?: Address;
  network: Network;
};

const contracts = ["launchpad", "usdc", "burnSink", "passportRegistry", "covenantFactory", "pnth", "pnthRouter", "constituentRegistry", "staking", "indexVault"] as const;
const externals = ["usdc", "whype", "multicall3", "ascendLaunchpad", "ascendRouter"] as const;
export function ascendBuyUrl(token: Address): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(token) || /^0x0{40}$/.test(token)) throw new Error("PNTH token address required");
  return `https://app.ascendlaunch.xyz/tokens/${token}`;
}

export function validateDeployment(name: string, input: unknown): Deployment {
  const value = input as Deployment | undefined;
  if (!value) throw new Error(`Network profile ${name}: unknown deployment`);
  const n = value.network;
  const requiredContracts = n?.testnet === false ? [...contracts.filter(k => k !== "pnthRouter" && k !== "covenantFactory"), "creatorSeat", "creatorEscrow"] as const : contracts;
  const fields: [string, unknown][] = [
    ["chainId", value.chainId], ...requiredContracts.map((key): [string, unknown] => [key, value[key]]),
    ["pnthPool", value.pnthPool], ["network.chainId", n?.chainId], ["network.name", n?.name],
    ["network.testnet", n?.testnet], ["network.publicRpc", n?.publicRpc],
    ["network.explorerUrl", n?.explorerUrl], ["network.deployedFrom", n?.deployedFrom],
    ...externals.map((key): [string, unknown] => [`network.external.${key}`, n?.external?.[key]]),
    ...(!n?.testnet ? [["network.acquireUrl", n?.acquireUrl] as [string, unknown]] : []),
  ];
  const missing = fields.filter(([, v]) => v === null || v === undefined || v === "").map(([key]) => key);
  if (missing.length) throw new Error(`Network profile ${name}: missing required fields: ${missing.join(", ")}`);
  const invalid: string[] = [];
  const expected = name === "elysium-mainnet" ? 99901 : name === "elysium-testnet" || name === "local" ? 99801 : null;
  if (expected !== null && (n.chainId !== expected || n.testnet !== (expected === 99801))) invalid.push("network.chainId/testnet");
  if (!Number.isSafeInteger(n.chainId) || n.chainId <= 0 || n.chainId !== value.chainId) invalid.push("network.chainId");
  if (typeof n.testnet !== "boolean") invalid.push("network.testnet");
  if (typeof n.name !== "string") invalid.push("network.name");
  if (!Number.isSafeInteger(n.deployedFrom) || n.deployedFrom < 0) invalid.push("network.deployedFrom");
  for (const key of requiredContracts) if (!/^0x[0-9a-fA-F]{40}$/.test(value[key]!) || /^0x0{40}$/.test(value[key]!)) invalid.push(key);
  for (const key of externals) if (!/^0x[0-9a-fA-F]{40}$/.test(n.external[key]) || /^0x0{40}$/.test(n.external[key])) invalid.push(`network.external.${key}`);
  if (!/^0x[0-9a-fA-F]{64}$/.test(value.pnthPool)) invalid.push("pnthPool");
  if (String(value.usdc).toLowerCase() !== String(n.external.usdc).toLowerCase()) invalid.push("network.external.usdc");
  if (String(value.launchpad).toLowerCase() !== String(n.external.ascendLaunchpad).toLowerCase()) invalid.push("network.external.ascendLaunchpad");
  for (const [key, url] of [["publicRpc", n.publicRpc], ["explorerUrl", n.explorerUrl], ["acquireUrl", n.acquireUrl]] as const) {
    if (key === "acquireUrl" && n.testnet && url === null) continue;
    try {
      const parsed = new URL(url!);
      if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password || (key === "publicRpc" && /(^|\.)alchemy\.com$/.test(parsed.hostname))) invalid.push(`network.${key}`);
    } catch { invalid.push(`network.${key}`); }
  }
  if (invalid.length) throw new Error(`Network profile ${name}: invalid fields: ${invalid.join(", ")}. Private provider RPCs belong in server-only ELYSIUM_RPC.`);
  return value;
}
