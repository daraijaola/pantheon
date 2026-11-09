import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import testnet from "../deployments/elysium-testnet.json" with { type: "json" };

type AddressKey = Exclude<keyof typeof testnet, "network" | "chainId"> | "factory" | "positionManager" | "whype" | "multicall3" | "ascendLaunchpad" | "ascendRouter" | "launchFactory" | "poolFactory" | "router" | "quoter" | "locker" | "coinDeployer" | "oldLaunchFactory" | "oldLocker" | "swapRouter" | "quoterV2";
type Typed<T> = { [K in keyof T]: K extends "contracts" | "baseTokens" | "perpmeQuotes" | "knownHubs" ? `0x${string}`[] : K extends AddressKey ? `0x${string}` : T[K] extends object ? Typed<T[K]> : T[K] };
export type Profile = Typed<typeof testnet> & { creatorSeat?: `0x${string}`; creatorEscrow?: `0x${string}`; network: { external: { ascend?: Record<string, `0x${string}`> } } };
export type Environment = Record<string, string | undefined>;
export type Service = "indexer" | "keeper" | "passport" | "trials" | "uploaded" | "delphi" | "feed" | "x";

export function deploymentName(env: Environment = process.env): string {
  const network = env.NETWORK ? (env.NETWORK.startsWith("elysium-") ? env.NETWORK : `elysium-${env.NETWORK}`) : undefined;
  const file = env.DEPLOYMENT_FILE || (env.DEPLOYMENT?.endsWith(".json") ? env.DEPLOYMENT : undefined);
  const fileName = file ? basename(file, ".json") : undefined;
  const fromFile = fileName && ["elysium-testnet", "elysium-mainnet"].includes(fileName) ? fileName : undefined;
  const name = env.DEPLOYMENT || env.NEXT_PUBLIC_DEPLOYMENT || network || fromFile || "elysium-testnet";
  const selected = name.endsWith(".json") ? network || env.NEXT_PUBLIC_DEPLOYMENT || fromFile || "elysium-testnet" : name;
  if (!["elysium-testnet", "elysium-mainnet"].includes(selected)) throw new Error("Network profile: invalid NETWORK/deployment selection");
  if (network && network !== selected) throw new Error("Network profile: conflicting NETWORK/deployment selection");
  if (fromFile && fromFile !== selected) throw new Error("Network profile: conflicting deployment file selection");
  return selected;
}

const required: Record<Service, string[]> = {
  indexer: ["pnth", "pnthRouter", "indexVault", "constituentRegistry", "staking", "usdc", "burnSink", "network.deployedFrom"],
  keeper: ["pnth", "pnthRouter", "indexVault", "constituentRegistry", "staking", "passportRegistry", "network.deployedFrom"],
  passport: ["passportRegistry"],
  trials: ["passportRegistry", "staking"],
  uploaded: ["staking", "passportRegistry", "pnth", "usdc", "network.archiveRpc"],
  delphi: ["launchpad", "burnSink", "network.explorerApi", "network.archiveRpc", "network.creationExplorer", "network.ascendFromBlock", "network.external.ascendRouter", "network.external.kalos", "network.external.perpme", "network.baseTokens", "network.perpmeQuotes"],
  feed: [],
  x: ["pnth", "staking", "constituentRegistry", "network.explorerApi", "network.ascendFromBlock", "launchpad"],
};

export function valueAt(input: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((v, key) => v && typeof v === "object" ? (v as Record<string, unknown>)[key] : undefined, input);
}

export function profile(env: Environment = process.env, service?: Service, input?: unknown): Profile {
  const name = deploymentName(env);
  const file = env.DEPLOYMENT_FILE || (env.DEPLOYMENT?.endsWith(".json") ? env.DEPLOYMENT : undefined);
  const source = name === "elysium-mainnet" && file ? resolve(file) : new URL(`../deployments/${name}.json`, import.meta.url);
  const p = structuredClone(input ?? JSON.parse(readFileSync(source, "utf8"))) as Profile;
  if (name === "elysium-mainnet") {
    p.network.baseTokens ??= [p.network.external.usdc, p.network.external.whype];
    p.network.perpmeQuotes ??= [];
  }
  const overrides: Record<string, string> = { ELYSIUM_RPC: "network.publicRpc", EXPLORER_WEB: "network.explorerUrl", EXPLORER_API: "network.explorerApi", ARCHIVE_RPC: "network.archiveRpc", REGISTRY_ADDRESS: "passportRegistry", LAUNCHPAD: "launchpad" };
  for (const [key, path] of Object.entries(overrides)) {
    if (!env[key]) continue;
    const keys = path.split(".");
    let target = p as unknown as Record<string, unknown>;
    for (const part of keys.slice(0, -1)) target = target[part] as Record<string, unknown>;
    target[keys.at(-1)!] = env[key];
  }
  if (env.FROM_BLOCK && service) {
    if (!/^\d+$/.test(env.FROM_BLOCK)) throw new Error(`Network profile ${name}: invalid FROM_BLOCK`);
    if (service === "delphi" || service === "x") p.network.ascendFromBlock = Number(env.FROM_BLOCK);
    else p.network.deployedFrom = Number(env.FROM_BLOCK);
  }
  const needed = service ? required[service].flatMap(key => {
    if (name !== "elysium-mainnet") return [key];
    if (key === "pnthRouter") return ["creatorSeat", "creatorEscrow"];
    if (key === "network.external.kalos" && !p.network.external.kalos.factory) return [];
    if (key === "network.external.perpme" && !p.network.external.perpme.launchFactory) return [];
    return [key];
  }) : [];
  if (name === "elysium-mainnet" && service === "delphi") needed.push(...["poolManager", "stateView", "escrowFactory", "seatFactory", "v4Quoter", "permit2"].map(key => `network.external.ascend.${key}`));
  const fields = ["chainId", "network.chainId", "network.name", "network.testnet", "network.publicRpc", "network.explorerUrl", "network.external.multicall3", ...needed];
  const leaves = (key: string, v: unknown): string[] => v && typeof v === "object" && !Array.isArray(v) ? Object.entries(v).flatMap(([child, item]) => leaves(`${key}.${child}`, item)) : [key];
  const optional = new Set(["network.external.perpme.oldLaunchFactory", "network.external.perpme.oldLocker"]);
  const expanded = fields.flatMap(key => leaves(key, valueAt(p, key))).filter(key => !optional.has(key) || valueAt(p, key) != null);
  const missing = expanded.filter(key => { const v = valueAt(p, key); return v === null || v === undefined || v === ""; });
  if (missing.length) throw new Error(`Network profile ${name}: missing required fields: ${missing.join(", ")}`);
  const invalid = expanded.filter(key => {
    const value = valueAt(p, key);
    if (/chainId$|Block$|deployedFrom$/.test(key)) return !Number.isSafeInteger(value) || Number(value) < 0;
    if (/Rpc$|explorerUrl$|explorerApi$|creationExplorer$|\.api$|\.indexer$/.test(key)) {
      try { return !["http:", "https:"].includes(new URL(String(value)).protocol); } catch { return true; }
    }
    if (key === "network.name") return typeof value !== "string";
    if (key === "network.testnet") return typeof value !== "boolean";
    const addresses = Array.isArray(value) ? value : [value];
    return addresses.some(v => typeof v !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(v) || /^0x0{40}$/.test(v));
  });
  if (invalid.length) throw new Error(`Network profile ${name}: invalid fields: ${invalid.map(path => `${path}${Object.entries(overrides).some(([, field]) => field === path) ? ` (${Object.entries(overrides).find(([, field]) => field === path)![0]})` : ""}`).join(", ")}`);
  if (p.chainId <= 0 || p.chainId !== p.network.chainId || p.network.testnet !== (name === "elysium-testnet")) throw new Error(`Network profile ${name}: invalid chainId/testnet`);
  if (env.CHAIN_ID && Number(env.CHAIN_ID) !== p.chainId) throw new Error(`Network profile ${name}: CHAIN_ID mismatch`);
  return p;
}

export function statePath(path: string, env: Environment = process.env, directory = false): string {
  const name = deploymentName(env);
  const parts = resolve(path).split(/[\\/]/);
  const other = name === "elysium-mainnet" ? "elysium-testnet" : "elysium-mainnet";
  if (parts.includes(other)) throw new Error(`Network profile ${name}: state path belongs to another network`);
  if (name === "elysium-testnet" || parts.includes(name)) return path;
  return directory ? join(path, name) : join(dirname(path), name, basename(path));
}

export function backendEnv(env: Environment, service: Service, input?: unknown): Environment {
  const p = profile(env, service, input);
  const name = deploymentName(env);
  const defaults: Environment = {
    ELYSIUM_RPC: p.network.publicRpc, EXPLORER_WEB: p.network.explorerUrl,
    EXPLORER_API: p.network.explorerApi, ARCHIVE_RPC: p.network.archiveRpc,
    CHAIN_ID: String(p.chainId), LAUNCHPAD: p.launchpad,
    FROM_BLOCK: String(service === "delphi" || service === "x" ? p.network.ascendFromBlock : p.network.deployedFrom),
    DEPLOYMENT_FILE: new URL(`../deployments/${name}.json`, import.meta.url).pathname,
  };
  if (service === "passport" && name === "elysium-mainnet") defaults.REGISTRY_ADDRESS = p.passportRegistry;
  const clean = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ""));
  const result = { ...defaults, ...clean };
  if (service === "trials" && !env.DEPLOYMENT?.endsWith(".json")) result.DEPLOYMENT = defaults.DEPLOYMENT_FILE;
  {
    for (const key of ["INDEXER_URL", "TRIALS_URL", "PASSPORT_API"]) {
      if (name === "elysium-mainnet" && (service === "uploaded" && ["INDEXER_URL", "TRIALS_URL"].includes(key) || service === "keeper" && key === "PASSPORT_API") && !env[key]) throw new Error(`Network profile ${name}: missing required fields: ${key} (explicit mainnet upstream required)`);
    }
    const paths: Record<string, [string, boolean]> = {
      STATE_FILE: [service === "indexer" ? "data/index.json" : service === "keeper" ? "data/state.json" : "data/ballots.json", false],
      DB_PATH: [service === "passport" ? "/var/lib/passport/passport.db" : "data/delphi.db", false],
      OUT_DIR: ["out", true], SCAN_FILE: ["../delphi/out/scan.json", false], GUARD_FILE: ["data/guard.json", false],
      ROUNDS_DIR: ["../../deployments/trials", true], FEED_DB: ["data/feed.db", false], DISPUTE_LOG: ["out/disputes.log", false],
      X_STATE: ["data/x.db", false], X_DRAFTS: ["out/x/drafts.jsonl", false],
    };
    for (const [key, [fallback, directory]] of Object.entries(paths)) {
      if (name === "elysium-mainnet" || result[key]) result[key] = statePath(result[key] || fallback, env, directory);
    }
  }
  result.NETWORK = p.network.testnet ? "testnet" : "mainnet";
  return result;
}

export function assertDeploymentChain(env: Environment, deployment: unknown): void {
  const id = valueAt(deployment, "chainId");
  if (id === undefined && deploymentName(env) === "elysium-testnet") return;
  if (id !== profile(env).chainId) throw new Error(`Network profile ${deploymentName(env)}: deployment chainId mismatch`);
}

const reported = new Set<string>();
export function configured<T extends object>(env: Environment, service: Service, config: T): Readonly<T> {
  const name = deploymentName(env);
  const key = `${name}:${service}`;
  if (!reported.has(key)) {
    console.error(`[network] ${service} ${name} chainId=${profile(env).chainId} config accepted`);
    const p = profile(env);
    if (name === "elysium-mainnet" && ["delphi", "uploaded", "x"].includes(service) && (!p.network.knownContracts || !p.network.knownHubs || !p.network.knownAddresses)) console.error("[network] missing optional trusted labels/faucet hubs are disabled; no testnet identities are used");
    if (["delphi", "x"].includes(service) && (!p.network.external.perpme.oldLaunchFactory || !p.network.external.perpme.oldLocker)) console.error("[network] absent legacy PerpMe contracts are excluded from infrastructure labels");
    reported.add(key);
  }
  return Object.freeze(config);
}

export async function assertRpcChain(client: { getChainId(): Promise<number> }, p: Profile = profile()): Promise<void> {
  if (p.network.testnet) return;
  const prefix = "Network profile elysium-mainnet";
  let id: number;
  try { id = await client.getChainId(); } catch { throw new Error(`${prefix}: RPC chainId verification failed`); }
  if (id !== p.chainId) throw new Error(`${prefix}: RPC chainId mismatch`);
}
