// DELPHI safety: what a trader wants to know about a coin's contract before buying it. Is it really a
// contract, can its code be swapped, is its source published, who controls it, what can they do to
// holders (mint, blacklist, tax, pause…), can it be moved and sold and what does it keep on the way,
// and is it pretending to be a well-known token? Every check says ok, risk or unknown in one plain
// sentence, with the address, transaction, function or storage slot behind it and the raw facts.
// Read-only: chain reads and dry runs (eth_call, eth_simulateV1) pinned to one block; nothing is signed.
import {
  decodeEventLog,
  encodeFunctionData,
  getAddress,
  keccak256,
  pad,
  parseAbi,
  parseAbiItem,
  toEventSelector,
  toFunctionSelector,
  toFunctionSignature,
  toHex,
  type AbiFunction,
  type Address,
  type Hex,
} from "viem";
import { profile } from "../../network.mts";
import { ascendEvents, ESCROW_LAUNCHED } from "./chain.ts";
import { cloneTarget, codeSize, delegationTarget, dispatchSelectors, hasDelegatecall } from "./bytecode.ts";
import { ContractsApi, ExplorerApi, type AbiItem, type Verification } from "./conduit.ts";
import {
  balanceAt,
  buySize,
  capProbe,
  holderSell,
  kalosPools,
  launchProtection,
  PERPME_VENUE,
  perpmeLaunchOf,
  pickHolder,
  roundTrip,
  saleSize,
  TEST_WALLETS,
  transferTest,
  type HolderPick,
  type KalosPool,
  type LaunchProtection,
  type PerpmeLaunchFacts,
  type PerpmeVenue,
  type Setup,
  type TradeLeg,
  type TransferTest,
} from "./honeypot.ts";
import type { Fetch } from "./http.ts";
import { KALOS_CONTRACTS, KalosApi, type KalosContracts } from "./kalos-api.ts";
import { lookalikes, looksDisguised, skeleton, visible, type KnownToken, type LookalikeMatch } from "./lookalike.ts";
import { NOT_POWERS, POWER_KINDS, POWER_SELECTORS, powerKind, STANDARD_SELECTORS, type PowerId } from "./powers.ts";
import { answerData, balanceOfData, decodeText, ethCall, getCode, getSlot, isRenounced, outcome, pctText, RENOUNCED, short, wordAddress, wordUint, ZERO } from "./pinned.ts";
import type { BatchRpc } from "./rpc.ts";

export type { KnownToken } from "./lookalike.ts";

/**
 * The rules, versioned into every report so a result can always be re-derived. Plain thresholds on
 * purpose: each must be explainable in one sentence.
 */
export const SAFETY_RULES = {
  version: "safety-v0.1",
  /** Owners nobody holds a key for: control was given up ("renounced"). */
  renounced: RENOUNCED,
  /** Losing less than this (in basis points, 1 = 0.01%) to a transfer or sale is rounding, not a tax. */
  taxToleranceBps: 1,
  /** The test amount when the caller gives none: this share of the holder's balance (basis points). */
  testShareBps: 100,
  /** The fresh-wallet round trip buys this much HYPE's worth, but never more than this share of the pool's WHYPE. */
  roundTrip: { buyWei: 10n ** 16n, maxPoolShareBps: 100 },
  /**
   * Holder search: walk back from the head in rounds of ten windows (2,000 blocks, about 6 minutes, then
   * 5 times bigger each round up to 2M) until 300 transfers are seen or 40M blocks (all of testnet's
   * history so far, about 3 months) are covered. A busy coin stops in the first round; a quiet one
   * costs a handful of batched requests. The biggest wallet among the latest 100 recipients is the
   * test holder.
   */
  holder: { windowBlocks: 2_000, growth: 5, maxWindowBlocks: 2_000_000, maxLookbackBlocks: 40_000_000, enoughTransfers: 300, candidates: 100 },
  /** The holder's test sale on Kalos is scaled down to be worth at most this share of the pool's WHYPE. */
  saleMaxPoolShareBps: 100,
  /** Kalos fee tiers tried when looking for a coin's pools (the factory has 100, 500, 3000, 10000 and 20000). */
  kalosFeeTiers: [100, 500, 3_000, 10_000, 20_000] as readonly number[],
  /**
   * PerpMe: the fresh wallet's test buy is worth at most this share of the coins in the pool (PerpMe pools
   * open holding only the coin, so their HYPE says nothing about depth), and while launch protection is
   * on, at most this share of the wallet cap. The cap probe may spend up to `capProbeWei`.
   */
  perpme: { maxPoolShareBps: 100, maxCapShareBps: 5_000, capProbeWei: 10_000n * 10n ** 18n },
} as const;

const eip1967 = (label: string) => toHex(BigInt(keccak256(toHex(label))) - 1n, { size: 32 });
/** Where proxies keep the address of the code they run, and of who may change it. */
export const PROXY_SLOTS = {
  implementation: eip1967("eip1967.proxy.implementation"),
  admin: eip1967("eip1967.proxy.admin"),
  beacon: eip1967("eip1967.proxy.beacon"),
  /** EIP-1822 (UUPS before EIP-1967): keccak256("PROXIABLE"). */
  eip1822: keccak256(toHex("PROXIABLE")),
  /** OpenZeppelin's pre-EIP-1967 proxies. */
  zosImplementation: keccak256(toHex("org.zeppelinos.proxy.implementation")),
  zosAdmin: keccak256(toHex("org.zeppelinos.proxy.admin")),
} as const satisfies Record<string, Hex>;

/** Ascend's launchpad (configurable in config.ts as LAUNCHPAD; Ascend redeploys). */
export const DEFAULT_LAUNCHPAD: Address = profile().launchpad;
const LAUNCHED = toEventSelector(ascendEvents().launched);

/** Tokens whose real address DELPHI knows first-hand, read from their own contracts. Checked live 2026-10-31. */
export const OFFICIAL_TOKENS: ReadonlyArray<{ address: Address; source: string }> = profile().chainId === 99901 ? [
  { address: profile().usdc, source: "Ascend's published USDC" },
  { address: profile().network.external.whype, source: "Elysium's published WHYPE" },
  ...[profile().pnth, profile().network.external.ascend?.kntq].filter((a): a is Address => !!a).map(address => ({ address, source: "published mainnet deployment" })),
] : [
  { address: "0x8a2201953AF29e8BE7700bcB53dA3ce5caD18726", source: "KALOS's own contract" },
  { address: "0xa7531D7bE19f29B991d97eaA17b034715a835e35", source: "Kalos's staked-KALOS vault" },
  { address: KALOS_CONTRACTS.whype, source: "Kalos's wrapped HYPE" },
  { address: "0x048aCeb334cb1835dc897a749C5985e169EAb1C5", source: "PANTHEON's own coin on Ascend" },
  { address: "0x4b4fb5C5794F0c821464956374cC5872D5F0f140", source: "the USDC Ascend prices its coins in" },
];
/**
 * Addresses worth naming in a sentence. Each was checked live (2026-10-31) by what its code answers to.
 */
export const ADDRESS_LABELS: Readonly<Record<string, string>> = {
  // Arbitrum Orbit's UpgradeExecutor (execute, executeCall, EXECUTOR_ROLE): the chain owner's contract.
  "0xfa78c1a82455a6ce83aa82cf464d74e88b384600": "Elysium's UpgradeExecutor (the chain owner)",
  [DEFAULT_LAUNCHPAD.toLowerCase()]: "Ascend's launchpad",
  ...(PERPME_VENUE.launchFactory ? {
    [PERPME_VENUE.launchFactory.toLowerCase()]: "PerpMe's launch factory",
    [PERPME_VENUE.coinDeployer.toLowerCase()]: "PerpMe's coin deployer",
  } : {}),
};
/** An address for a sentence: its label when DELPHI knows one, else the short form. */
const who = (a: string) => (ADDRESS_LABELS[a.toLowerCase()] ? `${ADDRESS_LABELS[a.toLowerCase()]} ${short(a)}` : short(a));

/** Names with no token contract that is real on Elysium: any coin using them is not the real thing. */
export const RESERVED_NAMES: readonly KnownToken[] = [
  { address: null, symbol: "HYPE", name: "Hype", source: "Elysium's own coin, which is not a token contract" },
  ...(profile().network.testnet ? [{ address: null, symbol: "KNTQ", name: "Kinetiq", source: "Kinetiq's token, which has no contract on Elysium testnet (checked 2026-10-31)" }] : []),
];

// ─── Report types ────────────────────────────────────────────────────────────────────────────────

export type CheckState = "ok" | "risk" | "unknown";
export type CheckId = "code" | "verified" | "owner" | "powers" | "transfer" | "sell" | "impersonation";
/** What backs a claim: an address, a transaction, a function or a storage slot anyone can look up. */
export type Evidence = { what: string; address?: Address; tx?: Hex; signature?: string; selector?: Hex; slot?: Hex };
export type Check<F> = { state: CheckState; summary: string; evidence: Evidence[]; facts: F };

export type ProxyKind = "eip1967" | "eip1967-beacon" | "eip1822" | "zeppelinos" | "eip1167";
export type Upgrade = { possible: boolean | null; by: Address[]; how: string };
export type CodeFacts = {
  isContract: boolean;
  size: number;
  codeHash: Hex | null;
  /** A wallet with an EIP-7702 delegation: it has code, but it is a wallet, not a token. */
  delegatesTo: Address | null;
  proxy: { kind: ProxyKind; implementation: Address; beacon: Address | null; admin: Address | null; adminOwner: Address | null; implementationSize: number } | null;
  upgrade: Upgrade;
  /** The contract whose code the other checks read: the implementation behind a proxy. */
  logic: Address;
  /** It hands calls to other code (DELEGATECALL) but uses no standard proxy slot. */
  unknownProxy: boolean;
};
export type VerifiedEntry = { address: Address; verified: boolean; match: string | null; name: string | null; compiler: string | null; verifiedAt: string | null; codeMatches: boolean };
export type VerifiedFacts = { source: "conduit-sourcify"; logic: VerifiedEntry | null; proxy: VerifiedEntry | null; error?: string };
export type Role = { role: string; id: Hex; members: Address[] | null; deployerHas: boolean | null };
export type Deployment = { tx: Hex | null; sender: Address | null; factory: Address | null; block: string | null };
export type OwnerFacts = {
  owner: Address | null;
  ownerFunction: string | null;
  renounced: boolean;
  pendingOwner: Address | null;
  minter: Address | null;
  /** Other addresses the contract names about itself (creator(), launcher(), deployer()). */
  named: Record<string, Address>;
  deployment: Deployment | null;
  roles: { enumerable: boolean; list: Role[] } | null;
  /** Everyone DELPHI found who can still act on the contract. */
  controllers: Array<{ address: Address; as: string }>;
};
export type PowerFinding = {
  power: PowerId;
  does: string;
  signature: string;
  selector: Hex;
  normal: boolean;
  usable: "yes" | "no" | "unknown";
  /** Who can use it: addresses, or "anyone". */
  by: string[];
  /** Dry-run calls of the function from each candidate (`from`), with harmless arguments. */
  probes: Array<{ from: string; ok: boolean }>;
  note?: string;
};
export type PowerFacts = {
  source: "verified-abi" | "bytecode" | null;
  scanned: Address;
  readable: boolean;
  found: PowerFinding[];
  /** Functions that are neither standard ERC-20 nor in DELPHI's powers table. */
  otherFunctions: Hex[];
};
/** The holder the dry runs used: given by the caller, or found among recent recipients (and how far back DELPHI looked). */
export type HolderFacts = { holder: Address; balance: string; given: boolean; transfersSeen?: number; fromBlock?: string; toBlock?: string };
export type TransferFacts = { holder: HolderFacts | null; test: TransferTest | null; error?: string };
export type SellFacts = {
  pool: KalosPool | null;
  holderSell: TradeLeg | null;
  roundTrip: { buy: TradeLeg; sell: TradeLeg | null } | null;
  ascend: AscendLaunch | null;
  /** Set for a coin launched on PerpMe: the tests ran in its PerpMe pool, through PerpMe's router. */
  perpme?: PerpmeSale;
  error?: string;
};
/**
 * A PerpMe coin's sale test: its launch, its launch protection at the pinned block, and while that is on,
 * a buy of just over the wallet cap (refused by design).
 */
export type PerpmeSale = { launch: PerpmeLaunchFacts; protection: LaunchProtection | null; capProbe: TradeLeg | null };
export type ImpersonationFacts = { symbol: string | null; name: string | null; skeleton: { symbol: string; name: string }; disguised: boolean; matches: LookalikeMatch[]; isKnown: KnownToken | null };
export type AscendLaunch = { launchpad: Address; creator: Address; quote: Address; poolId: Hex; tx: Hex; block: string };

export type SafetyReport = {
  rules: string;
  token: Address;
  chainId: number;
  /** Every read and dry run used this block. */
  block: string;
  checkedAt: string;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  totalSupply: string | null;
  checks: {
    code: Check<CodeFacts>;
    verified: Check<VerifiedFacts>;
    owner: Check<OwnerFacts>;
    powers: Check<PowerFacts>;
    transfer: Check<TransferFacts>;
    sell: Check<SellFacts>;
    impersonation: Check<ImpersonationFacts>;
  };
  risks: CheckId[];
  unknowns: CheckId[];
  notes: string[];
};

export type SafetyDeps = {
  rpc: BatchRpc;
  /** For the HTTP services (verifier, explorer, Kalos); defaults to the global fetch. */
  fetch?: Fetch;
  contracts?: ContractsApi;
  explorer?: ExplorerApi;
  kalosApi?: KalosApi;
};

export type SafetyOptions = {
  /** A real holder to test transfers and sales from; found from recent transfers when not given. */
  holder?: Address;
  /** Test amount in the token's smallest unit; by default 1% of the holder's balance. */
  amount?: bigint;
  /** Pin every read to this block (default: the latest). */
  block?: bigint;
  now?: Date;
  /** Well-known tokens for the fake-ticker check (default: defaultKnownTokens()). */
  known?: readonly KnownToken[];
  launchpad?: Address;
  kalos?: KalosContracts;
  /** PerpMe's contracts (default PERPME_VENUE); false: don't look for a PerpMe launch. */
  perpme?: PerpmeVenue | false;
  /** Look for a holder when none is given (default true). */
  findHolder?: boolean;
};

// ─── Small helpers ───────────────────────────────────────────────────────────────────────────────

const sel = (signature: string) => toFunctionSelector(signature);
const GETTERS = ["owner()", "getOwner()", "admin()", "pendingOwner()", "minter()", "creator()", "launcher()", "deployer()"] as const;
type Getter = (typeof GETTERS)[number];
const META = parseAbi(["function name() view returns (string)", "function symbol() view returns (string)", "function decimals() view returns (uint8)", "function totalSupply() view returns (uint256)"]);
const OWNED = parseAbi(["function owner() view returns (address)", "function implementation() view returns (address)"]);
const ROLES_ABI = parseAbi([
  "function hasRole(bytes32, address) view returns (bool)",
  "function getRoleMemberCount(bytes32) view returns (uint256)",
  "function getRoleMember(bytes32, uint256) view returns (address)",
]);
const ROLE_NAMES = ["DEFAULT_ADMIN_ROLE", "MINTER_ROLE", "PAUSER_ROLE", "BURNER_ROLE", "UPGRADER_ROLE", "BLACKLISTER_ROLE"] as const;
const roleId = (name: string): Hex => (name === "DEFAULT_ADMIN_ROLE" ? pad("0x00", { size: 32 }) : keccak256(toHex(name)));
const TRANSFER_SELECTOR = sel("transfer(address,uint256)");
const HAS_ROLE = sel("hasRole(bytes32,address)");
const ROLE_COUNT = sel("getRoleMemberCount(bytes32)");
const UPGRADE_SELECTORS = new Set([sel("upgradeTo(address)"), sel("upgradeToAndCall(address,bytes)")]);
/** Powers worth a dry-run call: their arguments can be made harmless, and success means "this caller may". */
const PROBED: ReadonlySet<PowerId> = new Set(["mint", "take", "blacklist", "pause", "fees", "limits", "trading", "exempt", "router"]);
const STRANGER = getAddress(`0x${keccak256(toHex("delphi-safety:stranger")).slice(26)}`);

const check = <F>(state: CheckState, summary: string, facts: F, evidence: Evidence[] = []): Check<F> => ({ state, summary, evidence, facts });
const listText = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300);

/** Harmless arguments for a dry-run call of a power, or null when its arguments are too complex. */
function probeArgs(signature: string, power: PowerId, target: Address, big: bigint): { abi: AbiFunction; args: unknown[] } | null {
  const abi = parseAbiItem(`function ${signature}`) as AbiFunction;
  const args: unknown[] = [];
  for (const p of abi.inputs) {
    if (p.type === "address") args.push(target);
    else if (p.type === "address[]") args.push([target]);
    else if (/^u?int\d*$/.test(p.type)) args.push(power === "limits" ? big : 1n);
    else if (p.type === "bool") args.push(true);
    else if (p.type === "bytes" || p.type === "string") args.push(p.type === "bytes" ? "0x" : "");
    else if (p.type === "bytes32") args.push(pad("0x00", { size: 32 }));
    else return null;
  }
  return { abi, args };
}

// ─── The known-token list ────────────────────────────────────────────────────────────────────────

/**
 * Well-known tokens for the fake-ticker check: KALOS, stKALOS, WHYPE, PNTH and Ascend's USDC read from
 * their own contracts, Kalos's approved list from its API, and HYPE and KNTQ, which no token contract
 * on Elysium may claim. If Kalos's API is down, the rest is still returned (and `notes` says so).
 */
export async function defaultKnownTokens(deps: { rpc: BatchRpc; fetch?: Fetch; kalosApi?: KalosApi }, block: Hex | "latest" = "latest", notes: string[] = []): Promise<KnownToken[]> {
  const metaOf = (a: Address) => [ethCall(a, encodeFunctionData({ abi: META, functionName: "symbol" }), block), ethCall(a, encodeFunctionData({ abi: META, functionName: "name" }), block)];
  const answers = await deps.rpc.many(OFFICIAL_TOKENS.flatMap((t) => metaOf(t.address)));
  const out: KnownToken[] = [];
  OFFICIAL_TOKENS.forEach((t, i) => {
    const symbol = decodeText(answerData(answers[2 * i]));
    const name = decodeText(answerData(answers[2 * i + 1]));
    if (symbol || name) out.push({ address: t.address, symbol: symbol ?? "", name: name ?? "", source: t.source });
  });
  try {
    const kalos = deps.kalosApi ?? new KalosApi({ fetch: deps.fetch });
    for (const t of await kalos.tokens()) {
      if ((!t.approved && !t.wrappedNative) || t.symbol === null) continue;
      if (out.some((k) => k.address === t.address)) continue;
      out.push({ address: t.address, symbol: t.symbol, name: t.name ?? t.symbol, source: t.wrappedNative ? "Kalos's wrapped HYPE" : "Kalos's approved list" });
    }
  } catch (err) {
    notes.push(`Kalos's token list could not be read (${errText(err)}); the fake-ticker check used the rest.`);
  }
  return [...out, ...RESERVED_NAMES];
}

// ─── The checks ──────────────────────────────────────────────────────────────────────────────────

/** Contract facts read at `block`: code, proxy slots, name and supply, and who it says controls it. */
async function readBasics(rpc: BatchRpc, token: Address, block: Hex) {
  const slots = Object.values(PROXY_SLOTS);
  const meta = META.map((f) => f.name);
  const a = await rpc.many([
    getCode(token, block),
    ...slots.map((s) => getSlot(token, s, block)),
    ...meta.map((m) => ethCall(token, encodeFunctionData({ abi: META, functionName: m }), block)),
    ...GETTERS.map((g) => ethCall(token, sel(g), block)),
  ]);
  const code = (a[0]!.result ?? "0x") as Hex;
  const slotValues = Object.fromEntries(Object.keys(PROXY_SLOTS).map((k, i) => [k, wordAddress(a[1 + i]!.result as Hex)])) as Record<keyof typeof PROXY_SLOTS, Address | null>;
  const m = (i: number) => answerData(a[1 + slots.length + i]);
  const decimals = wordUint(m(2));
  const getters = Object.fromEntries(GETTERS.map((g, i) => [g, wordAddress(m(meta.length + i))])) as Record<Getter, Address | null>;
  const exists = Object.fromEntries(GETTERS.map((g, i) => [g, m(meta.length + i) !== null])) as Record<Getter, boolean>;
  return {
    code,
    slots: slotValues,
    name: decodeText(m(0)),
    symbol: decodeText(m(1)),
    decimals: decimals !== null && decimals < 256n ? Number(decimals) : null,
    totalSupply: wordUint(m(3)),
    getters,
    exists,
  };
}

/** Is it a proxy, of which kind, which code does it run, and who can change that code. */
async function resolveProxy(rpc: BatchRpc, token: Address, code: Hex, slots: Record<keyof typeof PROXY_SLOTS, Address | null>, block: Hex) {
  const live = (a: Address | null) => (a && a !== ZERO ? a : null);
  const clone = cloneTarget(code);
  const beacon = live(slots.beacon);
  let kind: ProxyKind | null = null;
  let implementation: Address | null = null;
  let admin: Address | null = null;
  const evidence: Evidence[] = [];
  if (clone) {
    kind = "eip1167";
    implementation = clone;
    evidence.push({ what: "minimal proxy (EIP-1167): the address it forwards to is part of its code", address: clone });
  } else if (live(slots.implementation)) {
    kind = "eip1967";
    implementation = slots.implementation;
    admin = live(slots.admin);
    evidence.push({ what: "implementation, in the EIP-1967 slot", address: implementation!, slot: PROXY_SLOTS.implementation });
    if (admin) evidence.push({ what: "proxy admin, in the EIP-1967 admin slot", address: admin, slot: PROXY_SLOTS.admin });
  } else if (beacon) {
    kind = "eip1967-beacon";
    admin = beacon;
    evidence.push({ what: "beacon, in the EIP-1967 beacon slot", address: beacon, slot: PROXY_SLOTS.beacon });
  } else if (live(slots.eip1822)) {
    kind = "eip1822";
    implementation = slots.eip1822;
    evidence.push({ what: "implementation, in the EIP-1822 PROXIABLE slot", address: implementation!, slot: PROXY_SLOTS.eip1822 });
  } else if (live(slots.zosImplementation)) {
    kind = "zeppelinos";
    implementation = slots.zosImplementation;
    admin = live(slots.zosAdmin);
    evidence.push({ what: "implementation, in OpenZeppelin's old proxy slot", address: implementation!, slot: PROXY_SLOTS.zosImplementation });
    if (admin) evidence.push({ what: "proxy admin, in OpenZeppelin's old admin slot", address: admin, slot: PROXY_SLOTS.zosAdmin });
  }
  if (!kind) return { proxy: null, logic: token, logicCode: code, upgrade: { possible: false, by: [], how: "not a proxy: its code is fixed" } as Upgrade, evidence };

  // The beacon names the implementation; the admin (or beacon) is usually a contract with an owner.
  const reads = await rpc.many([
    ...(kind === "eip1967-beacon" ? [ethCall(beacon!, encodeFunctionData({ abi: OWNED, functionName: "implementation" }), block)] : []),
    ...(admin ? [getCode(admin, block), ethCall(admin, encodeFunctionData({ abi: OWNED, functionName: "owner" }), block)] : []),
  ]);
  const at = kind === "eip1967-beacon" ? 1 : 0;
  if (kind === "eip1967-beacon") {
    implementation = wordAddress(answerData(reads[0]));
    if (!implementation) throw new Error(`beacon ${beacon} did not name an implementation`);
    evidence.push({ what: "implementation, named by the beacon", address: implementation, signature: "implementation()" });
  }
  let adminOwner: Address | null = null;
  let adminIsContract = false;
  if (admin) {
    adminIsContract = ((reads[at]!.result ?? "0x") as Hex) !== "0x";
    adminOwner = adminIsContract ? wordAddress(answerData(reads[at + 1])) : null;
    if (adminOwner) evidence.push({ what: `owner of the ${kind === "eip1967-beacon" ? "beacon" : "proxy admin"}`, address: adminOwner, signature: "owner()" });
  }
  const [implCode] = await rpc.many<Hex>([getCode(implementation!, block)]);
  const logicCode = (implCode!.result ?? "0x") as Hex;

  let upgrade: Upgrade;
  if (kind === "eip1167") upgrade = { possible: false, by: [], how: "a minimal proxy always runs the same code" };
  else if (admin) {
    const who = kind === "eip1967-beacon" ? "beacon" : "proxy admin";
    if (adminOwner && isRenounced(adminOwner)) upgrade = { possible: false, by: [], how: `the ${who}'s owner gave up control` };
    else if (adminOwner) upgrade = { possible: true, by: [adminOwner], how: `the owner of its ${who} (${admin})` };
    else upgrade = { possible: true, by: [admin], how: adminIsContract ? `its ${who}, a contract DELPHI could not read an owner from` : `its ${who}, a wallet` };
  } else {
    // UUPS: the implementation upgrades itself, guarded by its own owner or roles (settled once those are known).
    const can = [...dispatchSelectors(logicCode)].some((s) => UPGRADE_SELECTORS.has(s));
    upgrade = can ? { possible: null, by: [], how: "its implementation has an upgrade function (UUPS)" } : { possible: false, by: [], how: "its implementation has no upgrade function" };
  }
  const proxy = { kind, implementation: implementation!, beacon: kind === "eip1967-beacon" ? beacon : null, admin, adminOwner, implementationSize: codeSize(logicCode) };
  return { proxy, logic: implementation!, logicCode, upgrade, evidence };
}

/** The verifier's answer for one address, counted only if the source it holds matches the code on chain. */
function verifiedEntry(address: Address, v: Verification, code: Hex): VerifiedEntry {
  const codeMatches = !!v.onchainBytecode && v.onchainBytecode.toLowerCase() === code.toLowerCase();
  return { address, verified: v.matched && codeMatches && v.abi.length > 0, match: v.runtimeMatch, name: v.name, compiler: v.compiler, verifiedAt: v.verifiedAt, codeMatches };
}

/** The function selectors to judge by: the verified ABI's when there is one, else the bytecode's dispatcher. */
function functionsOf(logicCode: Hex, abi: AbiItem[] | null) {
  if (abi) {
    const fns = abi.filter((i) => i.type === "function" && i.name) as unknown as AbiFunction[];
    const signatures = fns.map((f) => toFunctionSignature(f));
    const writes = fns.filter((f) => f.stateMutability !== "view" && f.stateMutability !== "pure").map((f) => ({ name: f.name, signature: toFunctionSignature(f) }));
    return { source: "verified-abi" as const, selectors: new Set(signatures.map((s) => sel(s))), writes };
  }
  return { source: "bytecode" as const, selectors: dispatchSelectors(logicCode), writes: null };
}

/** Powers present: by exact selector, and (verified ABI only) by name for variants with other arguments. */
function powersPresent(fns: ReturnType<typeof functionsOf>) {
  const found = new Map<Hex, { power: PowerId; signature: string; selector: Hex }>();
  for (const s of fns.selectors) {
    const p = POWER_SELECTORS.get(s);
    if (p) found.set(s, p);
  }
  for (const w of fns.writes ?? []) {
    const selector = sel(w.signature);
    if (found.has(selector) || NOT_POWERS.has(w.signature)) continue;
    const kind = POWER_KINDS.find((k) => k.names?.test(w.name));
    if (kind) found.set(selector, { power: kind.id, signature: w.signature, selector });
  }
  return [...found.values()];
}

/** The block a contract was created in, by whom, and through which factory (from the explorer, then a trace). */
async function deploymentOf(rpc: BatchRpc, explorer: ExplorerApi, token: Address, notes: string[]): Promise<Deployment | null> {
  try {
    const c = await explorer.creation(token);
    if (!c) return null;
    if (c.tx) return { tx: c.tx, sender: c.sender, factory: null, block: c.block.toString() };
    type Frame = { from: string; to?: string; type?: string; calls?: Frame[] };
    const traces = await rpc.call<Array<{ txHash: Hex; result: Frame }>>("debug_traceBlockByNumber", [toHex(c.block), { tracer: "callTracer" }]);
    const find = (f: Frame): Frame | null => {
      if ((f.type === "CREATE" || f.type === "CREATE2") && f.to?.toLowerCase() === token.toLowerCase()) return f;
      for (const sub of f.calls ?? []) {
        const hit = find(sub);
        if (hit) return hit;
      }
      return null;
    };
    for (const t of traces) {
      const frame = find(t.result);
      if (frame) return { tx: t.txHash, sender: getAddress(t.result.from), factory: getAddress(frame.from), block: c.block.toString() };
    }
    return { tx: null, sender: null, factory: null, block: c.block.toString() };
  } catch (err) {
    notes.push(`Who deployed it could not be read (${errText(err)}).`);
    return null;
  }
}

/** The coin's launch on Ascend's launchpad, if it was launched there. */
export async function ascendLaunch(rpc: BatchRpc, launchpad: Address, token: Address, block: Hex): Promise<AscendLaunch | null> {
  type Log = { topics: Hex[]; data: Hex; transactionHash: Hex; blockNumber: Hex };
  const logs = await rpc.call<Log[]>("eth_getLogs", [{ address: launchpad, topics: [LAUNCHED, null, pad(token)], fromBlock: "0x0", toBlock: block }]);
  const l = logs[0];
  if (!l) return null;
  let creator = getAddress(`0x${l.topics[3]!.slice(26)}`);
  if (profile().chainId === 99901) {
    const routes = await rpc.call<Log[]>("eth_getLogs", [{ address: profile().network.external.ascend!.escrowFactory, topics: [toEventSelector(ESCROW_LAUNCHED), l.topics[1]], fromBlock: l.blockNumber, toBlock: l.blockNumber }]);
    for (const route of routes) {
      if (route.transactionHash.toLowerCase() !== l.transactionHash.toLowerCase()) continue;
      const { args } = decodeEventLog({ abi: [ESCROW_LAUNCHED], topics: route.topics as [Hex, ...Hex[]], data: route.data });
      if (args.escrow.toLowerCase() === creator.toLowerCase()) { creator = args.dev; break; }
    }
  }
  return {
    launchpad,
    creator,
    quote: getAddress(`0x${l.data.slice(26, 66)}`),
    poolId: l.topics[1]!,
    tx: l.transactionHash,
    block: BigInt(l.blockNumber).toString(),
  };
}

/** AccessControl roles: listed when the contract can enumerate them, else asked about the deployer. */
async function readRoles(rpc: BatchRpc, token: Address, selectors: ReadonlySet<Hex>, ask: Address[], block: Hex): Promise<OwnerFacts["roles"]> {
  if (!selectors.has(HAS_ROLE)) return null;
  const enumerable = selectors.has(ROLE_COUNT);
  const roles = ROLE_NAMES.map((role) => ({ role, id: roleId(role) }));
  if (enumerable) {
    const counts = await rpc.many(roles.map((r) => ethCall(token, encodeFunctionData({ abi: ROLES_ABI, functionName: "getRoleMemberCount", args: [r.id] }), block)));
    const n = counts.map((c) => Number(wordUint(answerData(c)) ?? 0n));
    const calls = roles.flatMap((r, i) => Array.from({ length: Math.min(n[i]!, 5) }, (_, j) => ({ r, call: ethCall(token, encodeFunctionData({ abi: ROLES_ABI, functionName: "getRoleMember", args: [r.id, BigInt(j)] }), block) })));
    const got = await rpc.many(calls.map((c) => c.call));
    return {
      enumerable,
      list: roles.map((r) => ({ ...r, members: calls.flatMap((c, k) => (c.r === r ? [wordAddress(answerData(got[k]))].filter((a): a is Address => !!a) : [])), deployerHas: null })),
    };
  }
  const who = ask.filter((a, i) => ask.indexOf(a) === i);
  const calls = roles.flatMap((r) => who.map((w) => ({ r, w, call: ethCall(token, encodeFunctionData({ abi: ROLES_ABI, functionName: "hasRole", args: [r.id, w] }), block) })));
  const got = await rpc.many(calls.map((c) => c.call));
  return {
    enumerable,
    list: roles.map((r) => {
      const holders = calls.flatMap((c, k) => (c.r === r && wordUint(answerData(got[k])) === 1n ? [c.w] : []));
      return { ...r, members: null, deployerHas: holders.length > 0 ? true : who.length ? false : null, ...(holders.length ? { members: holders } : {}) };
    }),
  };
}

/** Dry-run calls of each power from each candidate, with harmless arguments. */
async function probePowers(rpc: BatchRpc, token: Address, block: Hex, powers: Array<{ power: PowerId; signature: string }>, senders: Address[], target: Address, big: bigint) {
  const jobs = powers.flatMap((p) => {
    if (!PROBED.has(p.power)) return [];
    const built = probeArgs(p.signature, p.power, p.power === "take" ? target : TEST_WALLETS.receiver, big);
    if (!built) return [];
    const data = encodeFunctionData({ abi: [built.abi], args: built.args as never });
    return [STRANGER, ...senders].map((from) => ({ signature: p.signature, from, call: ethCall(token, data, block, from) }));
  });
  const answers = await rpc.many(jobs.map((j) => j.call));
  const out = new Map<string, Array<{ from: string; ok: boolean }>>();
  jobs.forEach((j, i) => {
    const o = outcome(answers[i]!);
    const list = out.get(j.signature) ?? [];
    list.push({ from: j.from === STRANGER ? "anyone" : j.from, ok: o.ok });
    out.set(j.signature, list);
  });
  return out;
}

/** Runs every check on `token` and returns the report. */
export async function checkSafety(deps: SafetyDeps, tokenIn: Address, opts: SafetyOptions = {}): Promise<SafetyReport> {
  const { rpc } = deps;
  const token = getAddress(tokenIn);
  const fetch = deps.fetch ?? globalThis.fetch;
  const contracts = deps.contracts ?? new ContractsApi({ fetch });
  const explorer = deps.explorer ?? new ExplorerApi({ fetch });
  const kalos = opts.kalos ?? KALOS_CONTRACTS;
  const notes: string[] = [];

  const [chainAnswer, headAnswer] = await rpc.many<Hex>([
    { method: "eth_chainId", params: [] },
    { method: "eth_blockNumber", params: [] },
  ]);
  const chainId = Number(chainAnswer!.result);
  const blockNumber = opts.block ?? BigInt(headAnswer!.result!);
  const block = toHex(blockNumber);
  const basics = await readBasics(rpc, token, block);
  const meta = { name: basics.name, symbol: basics.symbol };
  const knownP = opts.known ? Promise.resolve(opts.known) : defaultKnownTokens({ rpc, fetch, kalosApi: deps.kalosApi }, block, notes);
  const report = (checks: SafetyReport["checks"]): SafetyReport => {
    const ids = Object.keys(checks) as CheckId[];
    return {
      rules: SAFETY_RULES.version,
      token,
      chainId,
      block: blockNumber.toString(),
      checkedAt: (opts.now ?? new Date()).toISOString(),
      ...meta,
      decimals: basics.decimals,
      totalSupply: basics.totalSupply?.toString() ?? null,
      checks,
      risks: ids.filter((id) => checks[id].state === "risk"),
      unknowns: ids.filter((id) => checks[id].state === "unknown"),
      notes,
    };
  };

  // 1. Code.
  const delegatesTo = delegationTarget(basics.code);
  const isContract = basics.code !== "0x" && !delegatesTo;
  const fakeTicker = impersonation(token, meta, await knownP);
  if (!isContract) {
    const why = delegatesTo ? "This address is a wallet (with an EIP-7702 delegation), not a token contract." : "There is no contract at this address, so it is not a token.";
    const none = <F>(facts: F) => check("unknown", "Not checked: there is no token contract here.", facts);
    const codeFacts: CodeFacts = { isContract: false, size: codeSize(basics.code), codeHash: null, delegatesTo, proxy: null, upgrade: { possible: false, by: [], how: "no code" }, logic: token, unknownProxy: false };
    return report({
      code: check("risk", why, codeFacts, [{ what: delegatesTo ? "delegates to" : "address with no code", address: delegatesTo ?? token }]),
      verified: none<VerifiedFacts>({ source: "conduit-sourcify", logic: null, proxy: null }),
      owner: none<OwnerFacts>({ owner: null, ownerFunction: null, renounced: false, pendingOwner: null, minter: null, named: {}, deployment: null, roles: null, controllers: [] }),
      powers: none<PowerFacts>({ source: null, scanned: token, readable: false, found: [], otherFunctions: [] }),
      transfer: none<TransferFacts>({ holder: null, test: null }),
      sell: none<SellFacts>({ pool: null, holderSell: null, roundTrip: null, ascend: null }),
      impersonation: fakeTicker,
    });
  }
  const resolved = await resolveProxy(rpc, token, basics.code, basics.slots, block);
  const { proxy, logic, logicCode } = resolved;

  // 2. Verified source (the logic contract's, and the proxy's own when there is one), deployment, launch.
  const [verifiedLogic, verifiedProxy, deployment, ascend] = await Promise.all([
    contracts.verification(chainId, logic).then((v) => verifiedEntryWithAbi(logic, v, logicCode)).catch((err: unknown) => ({ error: errText(err) })),
    proxy ? contracts.verification(chainId, token).then((v) => verifiedEntry(token, v, basics.code)).catch(() => null) : Promise.resolve(null),
    deploymentOf(rpc, explorer, token, notes),
    ascendLaunch(rpc, opts.launchpad ?? DEFAULT_LAUNCHPAD, token, block).catch((err: unknown) => {
      notes.push(`Ascend's launch records could not be read (${errText(err)}).`);
      return null;
    }),
  ]);
  // A coin PerpMe's coin deployer made: its launch names the pool to test sales in.
  const perpmeVenue = opts.perpme === false ? null : (opts.perpme ?? (PERPME_VENUE.launchFactory ? PERPME_VENUE : null));
  const perpme =
    perpmeVenue && deployment?.factory && deployment.block && deployment.factory.toLowerCase() === perpmeVenue.coinDeployer.toLowerCase()
      ? await perpmeLaunchOf(rpc, token, BigInt(deployment.block), perpmeVenue).catch((err: unknown) => {
          notes.push(`PerpMe's launch records could not be read (${errText(err)}).`);
          return null;
        })
      : null;
  const logicEntry = "error" in verifiedLogic ? null : verifiedLogic.entry;
  const verified = verifiedCheck(logicEntry, verifiedProxy, proxy !== null, "error" in verifiedLogic ? verifiedLogic.error : undefined);

  // 3. Functions, owner and roles.
  const fns = functionsOf(logicCode, logicEntry?.verified ? ("abi" in verifiedLogic ? verifiedLogic.abi : null) : null);
  const readable = fns.selectors.has(TRANSFER_SELECTOR);
  const g = basics.getters;
  const ownerFunction = (["owner()", "getOwner()", "admin()"] as const).find((f) => basics.exists[f] && g[f]) ?? null;
  const owner = ownerFunction ? g[ownerFunction] : null;
  const renounced = !!owner && isRenounced(owner);
  const pendingOwner = g["pendingOwner()"] && g["pendingOwner()"] !== ZERO ? g["pendingOwner()"] : null;
  const minter = g["minter()"] && !isRenounced(g["minter()"]) ? g["minter()"] : null;
  const named = Object.fromEntries((["creator()", "launcher()", "deployer()"] as const).flatMap((k) => (g[k] && g[k] !== ZERO ? [[k, g[k]!]] : [])));
  const deployers = [deployment?.sender, deployment?.factory, ascend?.creator].filter((a): a is Address => !!a);
  const roles = await readRoles(rpc, token, fns.selectors, [...deployers, ...(owner && !renounced ? [owner] : [])], block);

  const controllers: OwnerFacts["controllers"] = [];
  const add = (address: Address | null | undefined, as: string) => {
    if (address && !isRenounced(address) && !controllers.some((c) => c.address === address && c.as === as)) controllers.push({ address, as });
  };
  if (!renounced) add(owner, `owner (${ownerFunction})`);
  add(pendingOwner, "pending owner (can accept ownership)");
  add(minter, "minter (minter())");
  for (const r of roles?.list ?? []) for (const m of r.members ?? []) add(m, `holder of ${r.role}`);
  // A UUPS proxy upgrades through its own code, so whoever controls that code controls upgrades.
  const upgrade: Upgrade =
    resolved.upgrade.possible === null
      ? controllers.length
        ? { possible: true, by: controllers.map((c) => c.address), how: `${resolved.upgrade.how}, guarded by its owner or roles` }
        : renounced
          ? { possible: false, by: [], how: `${resolved.upgrade.how}, but its owner gave up control` }
          : { possible: null, by: [], how: `${resolved.upgrade.how}; DELPHI could not tell who may call it` }
      : resolved.upgrade;
  for (const u of upgrade.possible ? upgrade.by : []) add(u, "can replace the code");

  // 4. A holder to test with, then the powers and who can still use them (dry-run calls from every candidate).
  const holding = await findHolder(rpc, token, block, blockNumber, opts, kalos, notes);
  const present = powersPresent(fns);
  const senders = [...deployers, ...controllers.map((c) => c.address), ...Object.values(named)].filter((a, i, all) => all.indexOf(a) === i);
  const probes = await probePowers(rpc, token, block, present, senders, holding.address ?? TEST_WALLETS.receiver, basics.totalSupply ?? 10n ** 30n);
  const rolesUnknown = rolesHidden(roles);
  const found: PowerFinding[] = present.map((p) => {
    const kind = powerKind(p.power);
    const tried = probes.get(p.signature) ?? [];
    const passed = tried.filter((t) => t.ok).map((t) => t.from);
    let usable: PowerFinding["usable"];
    let by: string[];
    if (kind.id === "bridge") [usable, by] = ["yes", ["the token bridge"]];
    else if (kind.id === "ownership") [usable, by] = controllers.length ? ["yes", controllers.map((c) => c.address)] : ["no", []];
    else if (passed.includes("anyone")) [usable, by] = ["yes", ["anyone"]];
    else if (passed.length) [usable, by] = ["yes", passed];
    else if (controllers.length && refusedToAll(p.signature, tried, controllers)) {
      // No arguments to get wrong: when every controller is refused, it cannot be used now.
      const note = "every controller's dry run was refused, and it takes no arguments: it has most likely been used already (trading already on, say)";
      return { power: p.power, does: kind.does, signature: p.signature, selector: p.selector, normal: !!kind.normal, usable: "no" as const, by: [], probes: tried, note };
    } else if (controllers.length) [usable, by] = ["yes", controllers.map((c) => c.address)];
    else if (rolesUnknown || !renounced) [usable, by] = ["unknown", []];
    else [usable, by] = ["no", []];
    return { power: p.power, does: kind.does, signature: p.signature, selector: p.selector, normal: !!kind.normal, usable, by, probes: tried };
  });
  const otherFunctions = [...fns.selectors].filter((s) => !POWER_SELECTORS.has(s) && !STANDARD_SELECTORS.has(s) && !found.some((f) => f.selector === s)).sort();
  const powers = powersCheck({ source: fns.source, scanned: logic, readable, found, otherFunctions }, logicEntry?.verified ?? false);

  const code = codeCheck(token, basics.code, proxy, upgrade, logic, readable, resolved.evidence);
  const ownerFacts: OwnerFacts = { owner, ownerFunction, renounced, pendingOwner, minter, named, deployment, roles, controllers };
  const ownerC = ownerCheck(ownerFacts, found, upgrade);

  // 5. Transfer and sale dry runs.
  const [transfer, sell] = await tradeChecks(rpc, token, block, holding, opts, kalos, ascend, perpme && perpmeVenue ? { launch: perpme, venue: perpmeVenue } : null);

  return report({ code, verified, owner: ownerC, powers, transfer, sell, impersonation: fakeTicker });
}

/** The verifier's entry plus its ABI when (and only when) it counts as verified. */
function verifiedEntryWithAbi(address: Address, v: Verification, code: Hex) {
  const entry = verifiedEntry(address, v, code);
  return { entry, abi: entry.verified ? v.abi : null };
}

function codeCheck(token: Address, code: Hex, proxy: CodeFacts["proxy"], upgrade: Upgrade, logic: Address, readable: boolean, evidence: Evidence[]): Check<CodeFacts> {
  const unknownProxy = !proxy && hasDelegatecall(code) && !readable;
  const facts: CodeFacts = { isContract: true, size: codeSize(code), codeHash: keccak256(code), delegatesTo: null, proxy, upgrade, logic, unknownProxy };
  const size = `${codeSize(code).toLocaleString("en-US")} bytes`;
  if (unknownProxy) return check("unknown", `It is a contract (${size}) that hands its calls to other code in a way DELPHI does not recognise, so its real code could not be read.`, facts, [{ what: "contract", address: token }]);
  if (!proxy) return check("ok", `It is a contract (${size}) and its code cannot be changed.`, facts, [{ what: "contract", address: token }]);
  const runs = `It is a proxy (${proxy.kind}) running the code at ${short(proxy.implementation)}`;
  if (upgrade.possible === true) return check("risk", `${runs}, and that code can be replaced at any time by ${listText(upgrade.by.map(who))}: ${upgrade.how}.`, facts, [...evidence, ...upgrade.by.map((a) => ({ what: "can replace the code", address: a }))]);
  if (upgrade.possible === null) return check("unknown", `${runs}; ${upgrade.how}.`, facts, evidence);
  return check("ok", `${runs}, and that code cannot be replaced: ${upgrade.how}.`, facts, evidence);
}

function verifiedCheck(logic: VerifiedEntry | null, proxyEntry: VerifiedEntry | null, isProxy: boolean, error?: string): Check<VerifiedFacts> {
  const facts: VerifiedFacts = { source: "conduit-sourcify", logic, proxy: proxyEntry, ...(error ? { error } : {}) };
  if (!logic) return check("unknown", `DELPHI could not ask Conduit's verifier whether its source is published (${error ?? "no answer"}).`, facts);
  const what = isProxy ? "The code behind this proxy" : "Its source code";
  const evidence: Evidence[] = [{ what: "looked up on Conduit's verifier (contracts.conduit.xyz)", address: logic.address }];
  if (isProxy && proxyEntry?.verified && !logic.verified) {
    evidence.push({ what: `the proxy's own source is published (${proxyEntry.name ?? "verified"})`, address: proxyEntry.address });
    return check("risk", `The proxy's own source is published (${proxyEntry.name ?? "verified"}), but the code it runs is not, so nobody can read what the token does; DELPHI read the raw code instead.`, facts, evidence);
  }
  if (logic.verified) {
    const about = [logic.name, logic.compiler ? `solc ${logic.compiler.replace(/\+.*/, "")}` : null].filter(Boolean).join(", ");
    return check("ok", `${what} is published and matches the code on chain${about ? ` (${about})` : ""}.`, facts, evidence);
  }
  if (logic.match && !logic.codeMatches) return check("risk", `${isProxy ? "The code behind this proxy" : "It"} has a published source, but not for the code on chain now, so it does not count.`, facts, evidence);
  return check("risk", `${what} is not published, so nobody can read what it does; DELPHI read the raw code instead.`, facts, evidence);
}

function powersCheck(facts: PowerFacts, verified: boolean): Check<PowerFacts> {
  const harmful = facts.found.filter((f) => !f.normal);
  const live = harmful.filter((f) => f.usable !== "no");
  const evidence: Evidence[] = harmful.map((f) => ({
    what: `can ${f.does}${f.usable === "yes" ? ` (usable by ${f.by.map((b) => (b === "anyone" ? b : short(b))).join(", ")})` : f.usable === "no" ? ` (nobody can use it${f.note ? `: ${f.note}` : ""})` : " (who can use it is unknown)"}`,
    address: facts.scanned,
    signature: f.signature,
    selector: f.selector,
  }));
  const unnamed = !verified && facts.otherFunctions.length ? ` It also has ${facts.otherFunctions.length} function${facts.otherFunctions.length > 1 ? "s" : ""} DELPHI cannot name, as its source is not published.` : "";
  if (!facts.readable && !verified) return check("unknown", "DELPHI could not read its list of functions from the raw code, so it cannot say what its controller can do.", facts, evidence);
  if (!harmful.length) return check("ok", `It has none of the powers that can hurt holders (minting, blacklists, taxes, pausing, trade limits…).${unnamed}`, facts, evidence);
  const kinds = (xs: PowerFinding[]) => listText([...new Set(xs.map((f) => f.does))]);
  if (!live.length) return check("ok", `Its code can ${kinds(harmful)}, but nobody can use that any more.${unnamed}`, facts, evidence);
  const anyone = live.filter((f) => f.by.includes("anyone"));
  if (anyone.length) return check("risk", `Anyone can ${kinds(anyone)}: DELPHI's dry run of it from a random wallet went through.${unnamed}`, facts, evidence);
  const yes = live.filter((f) => f.usable === "yes");
  if (yes.length) return check("risk", `Its controller can still ${kinds(yes)}.${unnamed}`, facts, evidence);
  return check("risk", `Its code can ${kinds(live)}, and DELPHI could not tell who is allowed to.${unnamed}`, facts, evidence);
}

function ownerCheck(facts: OwnerFacts, found: PowerFinding[], upgrade: Upgrade): Check<OwnerFacts> {
  const evidence: Evidence[] = [];
  if (facts.owner) evidence.push({ what: facts.renounced ? "owner (renounced)" : "owner", address: facts.owner, signature: facts.ownerFunction ?? undefined });
  for (const c of facts.controllers) if (c.address !== facts.owner) evidence.push({ what: c.as, address: c.address });
  if (facts.deployment?.sender) evidence.push({ what: "deployed by", address: facts.deployment.sender, ...(facts.deployment.tx ? { tx: facts.deployment.tx } : {}) });
  if (facts.deployment?.factory) evidence.push({ what: "created through the factory", address: facts.deployment.factory });
  const harmful = found.filter((f) => !f.normal);
  const hidden = harmful.filter((f) => f.usable === "yes" && !f.by.includes("anyone") && f.by.some((b) => !facts.controllers.some((c) => c.address === b)));
  const rolesUnknown = rolesHidden(facts.roles);
  if (hidden.length) {
    const people = [...new Set(hidden.flatMap((f) => f.by))];
    return check("risk", `${listText(people.map(who))} can still ${listText([...new Set(hidden.map((f) => f.does))])}${facts.renounced ? ", even though ownership was renounced" : ""}: DELPHI's dry run of it went through.`, facts, [...evidence, ...people.map((w) => ({ what: "dry run of a power went through from", address: w as Address }))]);
  }
  if (facts.controllers.length) {
    const them = listText([...new Set(facts.controllers.map((c) => who(c.address)))]);
    const can = [...new Set(harmful.filter((f) => f.usable === "yes").map((f) => f.does)), ...(upgrade.possible ? ["replace the token's code"] : [])];
    if (can.length) return check("risk", `${them} still controls it and can ${listText(can)}.`, facts, evidence);
    return check("ok", `${them} still controls it, but the code gives it no power over holders beyond handing over control.`, facts, evidence);
  }
  const open = harmful.filter((f) => f.by.includes("anyone"));
  if (open.length) return check("risk", `It has no owner, but nobody needs to be one: any wallet can ${listText([...new Set(open.map((f) => f.does))])}.`, facts, evidence);
  if (rolesUnknown) return check("unknown", "It hands out powers by roles (AccessControl), and DELPHI cannot list who holds them without an indexer; its deployer holds none of the common ones.", facts, evidence);
  if (facts.renounced) return check("ok", `Its owner gave up control: ownership belongs to ${facts.owner === ZERO ? "the zero address" : "the dead address 0x…dEaD"}.`, facts, evidence);
  if (harmful.some((f) => f.usable === "unknown")) return check("unknown", "It names no owner, but its code has powers someone may hold; DELPHI could not tell who.", facts, evidence);
  return check("ok", "It has no owner: nobody controls it.", facts, evidence);
}

export function impersonation(token: Address, meta: { symbol: string | null; name: string | null }, known: readonly KnownToken[]): Check<ImpersonationFacts> {
  const matches = lookalikes(token, meta, known);
  const isKnown = known.find((k) => k.address?.toLowerCase() === token.toLowerCase()) ?? null;
  const facts: ImpersonationFacts = {
    ...meta,
    skeleton: { symbol: skeleton(meta.symbol ?? ""), name: skeleton(meta.name ?? "") },
    disguised: looksDisguised(`${meta.symbol ?? ""}${meta.name ?? ""}`),
    matches,
    isKnown,
  };
  if (!meta.symbol && !meta.name) return check("unknown", "It has no name or symbol to compare.", facts);
  if (isKnown) {
    // Two real tokens may share a name (Kalos's USDC and the USDC Ascend uses): that is not a copy.
    const also = [...new Set(matches.map((m) => (m.known.address ? `${m.known.source} (${short(m.known.address)})` : m.known.source)))];
    const shared = also.length ? `; ${listText(also)} has the same name and is real too` : "";
    return check("ok", `This is the real ${isKnown.symbol || isKnown.name} (${isKnown.source})${shared}.`, facts, [{ what: isKnown.source, address: token }]);
  }
  if (matches.length) {
    const m = matches[0]!;
    const own = visible(meta[m.field] ?? "");
    const real = m.known.address ? `the real one is ${short(m.known.address)}, ${m.known.source}` : m.known.source;
    const trick = m.how === "lookalike" ? " using look-alike letters" : "";
    return check(
      "risk",
      `Its ${m.field} "${own}" copies ${m.known.symbol || m.known.name}${trick} (${real}), but this is a different contract.`,
      facts,
      matches.map((x) => ({ what: `the real ${x.known.symbol || x.known.name} (${x.known.source})`, ...(x.known.address ? { address: x.known.address } : {}) })),
    );
  }
  return check("ok", `Its name and symbol do not copy any well-known token${facts.disguised ? ", though they use invisible or mixed-alphabet characters" : ""}.`, facts);
}

/** A power with no arguments that every controller was refused in a dry run. */
const refusedToAll = (signature: string, tried: PowerFinding["probes"], controllers: OwnerFacts["controllers"]) =>
  signature.endsWith("()") && controllers.every((c) => tried.some((t) => t.from === c.address && !t.ok));

/** Roles exist, but DELPHI could neither list them nor find a known address holding one. */
const rolesHidden = (roles: OwnerFacts["roles"]) => !!roles && !roles.enumerable && roles.list.every((r) => !r.members?.length);

type Holding = { facts: TransferFacts["holder"]; address: Address | null; balance: bigint };

/** The caller's holder (with its balance), or the biggest wallet among recent recipients. */
async function findHolder(rpc: BatchRpc, token: Address, block: Hex, blockNumber: bigint, opts: SafetyOptions, kalos: KalosContracts, notes: string[]): Promise<Holding> {
  try {
    if (opts.holder) {
      const address = getAddress(opts.holder);
      const balance = await balanceAt(rpc, block, token, address);
      return { facts: { holder: address, balance: balance.toString(), given: true }, address, balance };
    }
    if (opts.findHolder === false) return { facts: null, address: null, balance: 0n };
    const pick: HolderPick | null = await pickHolder(rpc, token, blockNumber, SAFETY_RULES.holder, [kalos.swapRouter, kalos.positionManager]);
    if (!pick) return { facts: null, address: null, balance: 0n };
    const facts: HolderFacts = { holder: pick.holder, balance: pick.balance.toString(), given: false, transfersSeen: pick.transfersSeen, fromBlock: pick.fromBlock.toString(), toBlock: pick.toBlock.toString() };
    return { facts, address: pick.holder, balance: pick.balance };
  } catch (err) {
    notes.push(`No holder could be found (${errText(err)}).`);
    return { facts: null, address: null, balance: 0n };
  }
}

/** The transfer and the sale dry runs, sharing one holder (or a fresh buyer when no wallet holds it). */
async function tradeChecks(
  rpc: BatchRpc,
  token: Address,
  block: Hex,
  holding: Holding,
  opts: SafetyOptions,
  kalos: KalosContracts,
  ascend: AscendLaunch | null,
  perpme: { launch: PerpmeLaunchFacts; venue: PerpmeVenue } | null,
): Promise<[Check<TransferFacts>, Check<SellFacts>]> {
  const taxed = (p: number | null) => p !== null && p * 100 >= SAFETY_RULES.taxToleranceBps;
  const { address: holderAddr, balance } = holding;
  const amount = opts.amount ?? (balance * BigInt(SAFETY_RULES.testShareBps)) / 10_000n;
  const testAmount = amount > 0n ? (amount > balance ? balance : amount) : balance;

  // Sale on Kalos: the holder's sale and a fresh wallet's buy and sell.
  const sellFacts: SellFacts = { pool: null, holderSell: null, roundTrip: null, ascend };
  let sell: Check<SellFacts>;
  let buyer: { setup: Setup; bought: bigint } | null = null;
  if (perpme) {
    // Sale on PerpMe: in the coin's PerpMe pool, through PerpMe's router.
    ({ sell, buyer } = await perpmeSale(rpc, token, block, holderAddr, testAmount, perpme.launch, perpme.venue, sellFacts, taxed));
  } else {
    try {
      const pools = await kalosPools(rpc, block, token, kalos, SAFETY_RULES.kalosFeeTiers);
      const pool = pools[0] ?? null;
      sellFacts.pool = pool;
      if (!pool) {
        const why = ascend
          ? "It trades in its Ascend pool (liquidity the launchpad seeded and locked) and has no Kalos pool; DELPHI tested a transfer, not a sale through Ascend's router."
          : token === kalos.whype
            ? "It is Kalos's wrapped HYPE, the currency other coins are sold for."
            : "It has no Kalos pool against WHYPE with liquidity, so DELPHI could not test a sale.";
        sell = check("unknown", why, sellFacts, ascend ? [{ what: "launched on Ascend", tx: ascend.tx, address: ascend.launchpad }] : []);
      } else {
        const poolShare = (BigInt(pool.whypeInPool) * BigInt(SAFETY_RULES.roundTrip.maxPoolShareBps)) / 10_000n;
        const buyWei = SAFETY_RULES.roundTrip.buyWei < poolShare ? SAFETY_RULES.roundTrip.buyWei : poolShare;
        const sale = holderAddr && testAmount > 0n ? await saleSize(rpc, block, token, testAmount, pool, kalos, SAFETY_RULES.saleMaxPoolShareBps) : 0n;
        const [h, rt] = await Promise.all([
          holderAddr && sale > 0n ? holderSell(rpc, block, token, holderAddr, sale, pool, kalos) : Promise.resolve(null),
          buyWei > 0n ? roundTrip(rpc, block, token, buyWei, pool, kalos) : Promise.resolve(null),
        ]);
        sellFacts.holderSell = h;
        sellFacts.roundTrip = rt ? { buy: rt.buy, sell: rt.sell } : null;
        if (rt?.setup && rt.buy.received) buyer = { setup: rt.setup, bought: BigInt(rt.buy.received) };
        sell = sellCheck(sellFacts, pool, holderAddr, taxed);
      }
    } catch (err) {
      sellFacts.error = errText(err);
      sell = check("unknown", `The sale dry run failed to run (${errText(err)}).`, sellFacts);
    }
  }

  // Transfer: from the real holder, or else from the fresh wallet right after its test buy.
  let holder = holding.facts;
  let from = holderAddr && testAmount > 0n ? { address: holderAddr, amount: testAmount, setup: undefined as Setup | undefined, what: "test sender (a real holder)" } : null;
  if (!from && buyer) {
    from = { address: TEST_WALLETS.buyer, amount: buyer.bought, setup: buyer.setup, what: `test sender (a fresh wallet, right after its test buy on ${perpme ? "PerpMe" : "Kalos"})` };
    holder = { holder: TEST_WALLETS.buyer, balance: buyer.bought.toString(), given: false };
  }
  let transfer: Check<TransferFacts>;
  if (!from) {
    transfer = check("unknown", holderAddr ? "The holder DELPHI tested with holds none of it, so no transfer was tried." : "DELPHI found no wallet holding it to test a transfer with.", { holder, test: null });
  } else {
    try {
      const t = await transferTest(rpc, block, token, from.address, from.amount, from.setup);
      const ev: Evidence[] = [{ what: from.what, address: from.address }];
      for (const s of t.sideTransfers) ev.push({ what: "part of the transfer went to", address: s.to });
      const facts = { holder, test: t };
      const sender = from.setup ? "a fresh wallet that had just bought it" : "a real holder";
      if (t.blocked) transfer = check("risk", `A test transfer from ${sender} was refused${t.revert?.reason ? `: "${visible(t.revert.reason, 80)}"` : t.revert?.data && t.revert.data !== "0x" ? ` (revert data ${t.revert.data.slice(0, 10)})` : ""}.`, facts, ev);
      else if (taxed(t.taxPct)) transfer = check("risk", `A test transfer lost ${pctText(t.taxPct!)} on the way: the coin keeps part of every transfer.`, facts, ev);
      else if (t.onward?.blocked) transfer = check("risk", `A wallet that had just received it could not pass it on${t.onward.revert?.reason ? `: "${visible(t.onward.revert.reason, 80)}"` : ""}. New holders may be stuck.`, facts, ev);
      else transfer = check("ok", `A test transfer from ${sender} arrived in full, and the new wallet could pass it on: no transfer tax.`, facts, ev);
    } catch (err) {
      transfer = check("unknown", `The transfer dry run failed to run (${errText(err)}).`, { holder, test: null, error: errText(err) });
    }
  }
  return [transfer, sell];
}

function sellCheck(f: SellFacts, pool: KalosPool, holder: Address | null, taxed: (p: number | null) => boolean): Check<SellFacts> {
  const ev: Evidence[] = [{ what: `Kalos pool against WHYPE (fee ${pool.fee / 10_000}%)`, address: pool.pool }];
  if (holder && f.holderSell) ev.push({ what: "test seller (a real holder)", address: holder });
  if (f.roundTrip) ev.push({ what: "test buyer (a fresh wallet)", address: TEST_WALLETS.buyer });
  const why = (l: TradeLeg) => (l.revert?.reason ? `: "${visible(l.revert.reason, 80)}"` : l.revert?.data && l.revert.data !== "0x" ? ` (revert data ${l.revert.data.slice(0, 10)})` : "");
  const failed = [f.holderSell && !f.holderSell.ok ? (["a real holder", f.holderSell] as const) : null, f.roundTrip?.sell && !f.roundTrip.sell.ok ? (["a new buyer", f.roundTrip.sell] as const) : null].filter((x) => x !== null);
  if (failed.length) {
    const [who, l] = failed[0]!;
    const iia = l.revert?.reason === "IIA" ? " The pool got fewer coins than it was sent, which is what happens when a coin keeps part of every transfer." : "";
    return check("risk", `A test sale on Kalos by ${who} failed${why(l)}.${iia}`, f, ev);
  }
  if (f.roundTrip && !f.roundTrip.buy.ok) return check("risk", `A test buy on Kalos failed${why(f.roundTrip.buy)}.`, f, ev);
  const taxes = [
    ["sale by a real holder", f.holderSell?.taxPct ?? null],
    ["buy", f.roundTrip?.buy.taxPct ?? null],
    ["sale by a new buyer", f.roundTrip?.sell?.taxPct ?? null],
  ] as const;
  const hit = taxes.filter(([, p]) => taxed(p));
  if (hit.length) return check("risk", `Kalos test trades came up short of Kalos's own quote: ${listText(hit.map(([what, p]) => `the ${what} by ${pctText(p!)}`))}. The coin takes a tax.`, f, ev);
  const tested = [f.holderSell?.ok ? "a real holder" : null, f.roundTrip?.sell?.ok ? "a fresh wallet that had just bought" : null].filter(Boolean) as string[];
  if (!tested.length) return check("unknown", "The Kalos pool had too little at this price for a test trade to say anything.", f, ev);
  return check("ok", `Test sales on Kalos by ${listText(tested)} went through and paid exactly what Kalos quoted: no buy or sell tax.`, f, ev);
}

const fmtPct = (fee: number) => `${fee / 10_000}%`;
const LIQUIDITY = parseAbi(["function liquidity() view returns (uint128)"]);

/**
 * The sale test for a PerpMe coin, in its own PerpMe pool through PerpMe's router and QuoterV2 (the same
 * code as Kalos's): a real holder sells for the pool's quote currency, and when that is PerpMe's WHYPE, a
 * fresh wallet buys with HYPE and sells it all back. The buy stays small next to the coins in the pool and,
 * while launch protection is on, under half the wallet cap; a second fresh wallet then asks for just over
 * the cap, which PerpMe refuses by design.
 */
async function perpmeSale(
  rpc: BatchRpc,
  token: Address,
  block: Hex,
  holder: Address | null,
  amount: bigint,
  launch: PerpmeLaunchFacts,
  venue: PerpmeVenue,
  facts: SellFacts,
  taxed: (p: number | null) => boolean,
): Promise<{ sell: Check<SellFacts>; buyer: { setup: Setup; bought: bigint } | null }> {
  const perpme: PerpmeSale = { launch, protection: null, capProbe: null };
  facts.perpme = perpme;
  try {
    const [[quoteIn, coinsIn, liquidity], protection] = await Promise.all([
      rpc.many([ethCall(launch.pairToken, balanceOfData(launch.pool), block), ethCall(token, balanceOfData(launch.pool), block), ethCall(launch.pool, encodeFunctionData({ abi: LIQUIDITY, functionName: "liquidity" }), block)]),
      launchProtection(rpc, block, token, venue),
    ]);
    const inPool = wordUint(answerData(quoteIn)) ?? 0n;
    const coins = wordUint(answerData(coinsIn)) ?? 0n;
    const pool: KalosPool = { pool: launch.pool, fee: launch.fee, whypeInPool: inPool.toString(), liquidity: (wordUint(answerData(liquidity)) ?? 0n).toString(), quote: launch.pairToken };
    facts.pool = pool;
    perpme.protection = protection;
    const hype = launch.pairToken.toLowerCase() === venue.whype.toLowerCase();
    const cap = protection.active && protection.maxWallet ? BigInt(protection.maxWallet) : null;
    const rules = SAFETY_RULES.perpme;
    const byPool = (coins * BigInt(rules.maxPoolShareBps)) / 10_000n;
    const maxTokens = cap !== null && (cap * BigInt(rules.maxCapShareBps)) / 10_000n < byPool ? (cap * BigInt(rules.maxCapShareBps)) / 10_000n : byPool;
    const sale = holder && amount > 0n && inPool > 0n ? await saleSize(rpc, block, token, amount, pool, venue, SAFETY_RULES.saleMaxPoolShareBps) : 0n;
    const buyWei = hype && maxTokens > 0n ? await buySize(rpc, block, token, SAFETY_RULES.roundTrip.buyWei, pool, venue, maxTokens) : 0n;
    const [h, rt, probe] = await Promise.all([
      holder && sale > 0n ? holderSell(rpc, block, token, holder, sale, pool, venue) : Promise.resolve(null),
      buyWei > 0n ? roundTrip(rpc, block, token, buyWei, pool, venue) : Promise.resolve(null),
      cap !== null && hype ? capProbe(rpc, block, token, cap, pool, venue, rules.capProbeWei) : Promise.resolve(null),
    ]);
    facts.holderSell = h;
    facts.roundTrip = rt ? { buy: rt.buy, sell: rt.sell } : null;
    perpme.capProbe = probe;
    const buyer = rt?.setup && rt.buy.received ? { setup: rt.setup, bought: BigInt(rt.buy.received) } : null;
    return { sell: perpmeSellCheck(facts, perpme, holder, venue, taxed), buyer };
  } catch (err) {
    facts.error = errText(err);
    return { sell: check("unknown", `The sale dry run on PerpMe failed to run (${errText(err)}).`, facts, [{ what: "launched on PerpMe", tx: launch.tx, address: launch.factory }]), buyer: null };
  }
}

/** Launch protection in one sentence: until when, and what it caps. */
function protectionText(p: LaunchProtection | null): string {
  if (!p?.active) return "";
  const left = p.endBlock && p.parentBlock ? BigInt(p.endBlock) - BigInt(p.parentBlock) : null;
  const when = p.endBlock ? `until parent-chain block ${p.endBlock}${left !== null && left > 0n ? ` (${left} blocks, about ${Math.max(1, Math.ceil(Number(left) / 60))} min)` : ""}` : "for now";
  return `Buying is restricted by design ${when}: PerpMe's launch protection lets no wallet hold more than 2% of the supply.`;
}

function perpmeSellCheck(f: SellFacts, p: PerpmeSale, holder: Address | null, venue: PerpmeVenue, taxed: (pct: number | null) => boolean): Check<SellFacts> {
  const pool = f.pool!;
  const quote = !pool.quote || pool.quote.toLowerCase() === venue.whype.toLowerCase() ? "HYPE" : pool.quote;
  const ev: Evidence[] = [
    { what: `PerpMe pool against ${quote === "HYPE" ? "PerpMe's WHYPE" : short(quote)} (fee ${fmtPct(pool.fee)})`, address: pool.pool },
    { what: "launched on PerpMe", tx: p.launch.tx, address: p.launch.factory },
  ];
  if (holder && f.holderSell) ev.push({ what: "test seller (a real holder)", address: holder });
  if (f.roundTrip) ev.push({ what: "test buyer (a fresh wallet)", address: TEST_WALLETS.buyer });
  if (p.capProbe) ev.push({ what: "cap test buyer (a fresh wallet asking for just over 2% of the supply)", address: TEST_WALLETS.probe });
  const restricted = !!p.protection?.active;
  const window = protectionText(p.protection);
  const why = (l: TradeLeg) => (l.revert?.reason ? `: "${visible(l.revert.reason, 80)}"` : l.revert?.data && l.revert.data !== "0x" ? ` (revert data ${l.revert.data.slice(0, 10)})` : "");
  const failed = [
    f.holderSell && !f.holderSell.ok ? (["sale by a real holder", f.holderSell] as const) : null,
    f.roundTrip && !f.roundTrip.buy.ok ? (["buy by a fresh wallet", f.roundTrip.buy] as const) : null,
    f.roundTrip?.sell && !f.roundTrip.sell.ok ? (["sale by a new buyer", f.roundTrip.sell] as const) : null,
  ].filter((x) => x !== null);
  if (failed.length) {
    const [what, l] = failed[0]!;
    // Inside the window a refusal may be the cap at work: restricted, not a honeypot. Ask again once it ends.
    if (restricted) return check("unknown", `${window} A small test ${what} on PerpMe was refused${why(l)}; DELPHI calls that restricted, not a honeypot, and can tell once the window ends.`, f, ev);
    const iia = l.revert?.reason === "IIA" ? " The pool got fewer coins than it was sent, which is what happens when a coin keeps part of every transfer." : "";
    return check("risk", `A test ${what} on PerpMe failed${why(l)}.${iia}`, f, ev);
  }
  const taxes = [
    ["sale by a real holder", f.holderSell?.taxPct ?? null],
    ["buy", f.roundTrip?.buy.taxPct ?? null],
    ["sale by a new buyer", f.roundTrip?.sell?.taxPct ?? null],
  ] as const;
  const hit = taxes.filter(([, pct]) => taxed(pct));
  if (hit.length) return check("risk", `PerpMe test trades came up short of PerpMe's own quote: ${listText(hit.map(([what, pct]) => `the ${what} by ${pctText(pct!)}`))}. The coin takes a tax.`, f, ev);
  const tested = [f.holderSell?.ok ? "a real holder" : null, f.roundTrip?.sell?.ok ? "a fresh wallet that had just bought" : null].filter(Boolean) as string[];
  const cap = p.capProbe ? (p.capProbe.ok ? " A test buy of just over 2% went through, so the cap did not hold." : " A test buy of just over 2% was refused, as designed.") : "";
  if (!tested.length) {
    const none =
      quote !== "HYPE"
        ? `It is priced in ${short(quote)}, not HYPE, and DELPHI found no holder to sell with, so no sale was tested (a fresh wallet's round trip needs a HYPE-priced pool).`
        : "The PerpMe pool had too little at this price for a test trade to say anything.";
    return check("unknown", `${restricted ? `${window} ` : ""}${none}${cap}`, f, ev);
  }
  const ok = `Test sales on PerpMe by ${listText(tested)} went through and paid exactly what PerpMe's quoter said: no buy or sell tax.`;
  return check("ok", restricted ? `${ok} ${window}${cap}` : ok, f, ev);
}
