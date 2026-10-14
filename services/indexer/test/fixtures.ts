// Shared test data: the live deployment's addresses, the real logs of four Oct 14 transactions, and a
// builder for the current-values part of a view.
import { readFileSync } from "node:fs";
import type { Address, Hex } from "viem";
import { toRec, type Contracts, type Rec } from "../src/chain.ts";
import type { Ctx, Live } from "../src/views.ts";

export const DEP = {
  pnth: "0x048aCeb334cb1835dc897a749C5985e169EAb1C5",
  pnthRouter: "0xE0Fb49DBDC3406cF1f175EeCABDFb282a7a98b66",
  indexVault: "0xE636003Feb05D0FB8f6016733C3d723446C9f221",
  constituentRegistry: "0xD8cEA0015E2C876ab5fa6D9178b46B57d65c6087",
  staking: "0x30c88fce1fAD545Df0fC603287f93F0f94076224",
  usdc: "0x4b4fb5C5794F0c821464956374cC5872D5F0f140",
  burnSink: "0xC889ac2f59A88afb3B2FB3f2C452DBa336fE5f0F",
} as const satisfies Record<string, Address>;
export const CONTRACTS: Contracts = { router: DEP.pnthRouter, vault: DEP.indexVault, registry: DEP.constituentRegistry, staking: DEP.staking };
export const EXPLORER = "https://elysium.kinetiq.xyz/testnet-explorer";

type FxLog = { address: Address; topics: Hex[]; data: Hex; transactionHash: Hex; blockNumber: number; logIndex: number };
export const LIVE_LOGS = (JSON.parse(readFileSync(new URL("./fixtures/live-logs.json", import.meta.url), "utf8")) as { logs: FxLog[] }).logs.map((l) => ({
  ...l,
  blockNumber: BigInt(l.blockNumber),
}));
export const liveRecords = (): Rec[] =>
  LIVE_LOGS.map((l) => toRec(l, CONTRACTS))
    .filter((r): r is Rec => r !== null)
    .sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);

export const COIN: Address = "0x862714532eD4Ef288aAf1EB6543F474fC7A7a225"; // FGK, in basket proposal 0

export function live(over: Partial<Live> = {}): Live {
  return {
    block: "9176314",
    readAt: 1_792_014_857,
    pnthSupply: (10n ** 27n).toString(),
    burnSink: "49999999999999999999999",
    vaultUsdc: "0",
    totalStaked: "81989932272684358569548796",
    totalWorking: "81989932272684358569548796",
    rewardTokens: [DEP.usdc],
    activeId: 0,
    proposals: [],
    tokens: {
      [DEP.pnth.toLowerCase()]: { symbol: "PNTH", decimals: 18 },
      [DEP.usdc.toLowerCase()]: { symbol: "USDC", decimals: 6 },
      [COIN.toLowerCase()]: { symbol: "FGK", decimals: 18 },
    },
    ...over,
  };
}

export const ctx = (records: Rec[], over: Partial<Live> = {}, nowSec = 1_792_014_857): Ctx => ({
  records,
  live: live(over),
  explorer: EXPLORER,
  usdc: DEP.usdc,
  pnth: DEP.pnth,
  nowSec,
});
