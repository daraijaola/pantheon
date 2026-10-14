// The Trials, run by hand: DELPHI's scan → the next basket proposal (live chain, read-only, sends nothing).
//   node scripts/trials.ts [--coins 5] [--cap-usdc 100] [--round N] [--no-explorer] [--compare file.json] [--count-creator]
//                          [--exclude 0xTOKEN[:reason]]...   (one per coin the curator leaves out; recorded in the file)
// Writes out/trials/round-N.json (the file Micheal's propose script reads; the registry stores the
// keccak256 of its exact bytes) and round-N.tree.json (the Merkle tree, to prove any coin's row).
// Before writing, it dry-runs ConstituentRegistry.propose as the curator, so the list is known to pass
// the contract's own checks before anyone sends it.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BaseError, ContractFunctionRevertedError, getAddress, keccak256, parseAbi, toBytes, type Address } from "viem";
import { makeClient } from "../src/chain.ts";
import { loadConfig, RULES } from "../src/config.ts";
import { Explorer } from "../src/explorer.ts";
import { collect, decodeLaunch } from "../src/ingest.ts";
import { analyze } from "../src/report.ts";
import { Store } from "../src/store.ts";
import { buildRound, priceVsAverage, roundBytes, volumes, type Candidate, type RegistryRules } from "../src/trials.ts";

const args = process.argv.slice(2);
const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const coins = Number(opt("--coins") ?? 5);
const capUsdc = BigInt(opt("--cap-usdc") ?? 100) * 1_000_000n;
const countCreator = args.includes("--count-creator");
// One --exclude per coin, so a reason can contain anything (commas included).
const exclude = new Map(
  args
    .flatMap((a, i) => (a === "--exclude" && args[i + 1] ? [args[i + 1]!] : []))
    .map((x) => {
      const [token, ...why] = x.split(":");
      return [getAddress(token!.trim()).toLowerCase(), why.join(":").trim()] as const;
    }),
);

const cfg = loadConfig();
const deployment = JSON.parse(readFileSync(resolve(opt("--deployment") ?? "../../deployments/elysium-testnet.json"), "utf8")) as { constituentRegistry: Address; indexVault: Address; chainId: number };
const registry = getAddress(deployment.constituentRegistry);
const client = makeClient(cfg.elysiumRpc);
const store = new Store(cfg.dbPath);
const log = (m: string) => console.error(`[trials] ${m}`);

const registryAbi = parseAbi([
  "struct Constituent { bytes32 poolId; address token; uint16 weightBps; uint128 perRunCap; }",
  "function MAX_N() view returns (uint256)",
  "function MAX_WEIGHT_BPS() view returns (uint16)",
  "function MIN_AGE() view returns (uint64)",
  "function maxRunCap() view returns (uint128)",
  "function baseQuote() view returns (address)",
  "function pnth() view returns (address)",
  "function curator() view returns (address)",
  "function proposalCount() view returns (uint256)",
  "function DELAY() view returns (uint64)",
  "function propose(Constituent[] list, bytes32 scoreRoot, string methodologyURI) returns (uint256)",
  "error BadList(uint256 index)",
  "error NotCurator()",
]);
const lpAbi = parseAbi(["function emaUpdatedAt(bytes32 poolId) view returns (uint40)", "function emaSqrtPrice(bytes32 poolId) view returns (uint160)"]);
const vaultAbi = parseAbi(["function maxStale() view returns (uint256)", "function BAND_BPS() view returns (uint256)"]);
const pmAbi = parseAbi(["function getSlot0(bytes32 id) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)"]);
const read = <T>(functionName: string) => client.readContract({ address: registry, abi: registryAbi, functionName } as never) as Promise<T>;

try {
  const { coins: data, head } = await collect({ client, store, cfg, explorer: args.includes("--no-explorer") ? null : new Explorer(cfg.explorerApi), log });
  const headBlock = await client.getBlock({ blockNumber: head });
  const nowSec = Number(headBlock.timestamp); // the scan block's time, not the clock: same scan, same file
  const [maxN, maxW, minAge, maxRunCap, baseQuote, pnth, curator, count, delay] = await Promise.all([
    read<bigint>("MAX_N"), read<number>("MAX_WEIGHT_BPS"), read<bigint>("MIN_AGE"), read<bigint>("maxRunCap"),
    read<Address>("baseQuote"), read<Address>("pnth"), read<Address>("curator"), read<bigint>("proposalCount"), read<bigint>("DELAY"),
  ]);
  const [maxStale, band] = await Promise.all([
    client.readContract({ address: deployment.indexVault, abi: vaultAbi, functionName: "maxStale" }),
    client.readContract({ address: deployment.indexVault, abi: vaultAbi, functionName: "BAND_BPS" }),
  ]);
  const rules: RegistryRules = {
    maxCoins: Number(maxN), maxWeightBps: Number(maxW), minAgeSec: Number(minAge), maxRunCap, baseQuote, pnth,
    delaySec: Number(delay), maxStaleSec: Number(maxStale), bandBps: Number(band), // 500 = 5% in price (the vault halves it for square-root prices)
  };
  const poolManager = (await client.readContract({ address: cfg.launchpad, abi: parseAbi(["function poolManager() view returns (address)"]), functionName: "poolManager" })) as Address;

  // What each coin is quoted in, from its launch event; AI headlines, if DELPHI's site file has them.
  const quoteOf = new Map(store.logs(`launched:${cfg.launchpad.toLowerCase()}`).map(decodeLaunch).map((l) => [l.token.toLowerCase(), l.quote]));
  let headlines = new Map<string, string>();
  try {
    const site = JSON.parse(readFileSync(join(cfg.outDir, "site.json"), "utf8")) as { coins: Array<{ token: string; headline?: string }> };
    headlines = new Map(site.coins.filter((c) => c.headline).map((c) => [c.token.toLowerCase(), c.headline!]));
  } catch {
    log("no site.json yet: rounds go out without AI headlines");
  }

  const candidates: Candidate[] = [];
  for (const d of data) {
    const v = volumes(d, { countCreator });
    if (v.usdcVolume === 0n) continue;
    const r = analyze(d, { explorerWeb: cfg.explorerWeb, now: new Date(nowSec * 1000) });
    const flag = r.findings.find((f) => f.severity === "flag");
    const at = Number(await client.readContract({ address: cfg.launchpad, abi: lpAbi, functionName: "emaUpdatedAt", args: [d.coin.poolId] }));
    const ema = await client.readContract({ address: cfg.launchpad, abi: lpAbi, functionName: "emaSqrtPrice", args: [d.coin.poolId] });
    const [spot] = await client.readContract({ address: poolManager, abi: pmAbi, functionName: "getSlot0", args: [d.coin.poolId] });
    candidates.push({
      token: d.coin.token,
      poolId: d.coin.poolId,
      symbol: d.coin.symbol,
      verdict: r.verdict,
      ...(flag ? { finding: flag.summary } : {}),
      quote: quoteOf.get(d.coin.token.toLowerCase()) ?? ("0x0000000000000000000000000000000000000000" as Address),
      launchedAt: d.coin.launchTime,
      ...v,
      priceAverageAt: at || null,
      priceVsAveragePct: priceVsAverage(spot, ema, d.coin.tokenIs0),
      ...(headlines.has(d.coin.token.toLowerCase()) ? { headline: headlines.get(d.coin.token.toLowerCase())! } : {}),
    });
  }
  const round = Number(opt("--round") ?? Number(count) + 1);
  const built = buildRound({
    round,
    chainId: deployment.chainId,
    scannedAt: new Date(nowSec * 1000).toISOString(),
    scanBlock: head.toString(),
    rulesVersion: RULES.version,
    candidates,
    rules,
    nowSec,
    coins,
    perRunCap: capUsdc,
    countCreator,
    exclude,
  });
  const bytes = roundBytes(built.file);
  const fingerprint = keccak256(toBytes(bytes));

  // Would the registry accept it? A dry run of propose, as the curator, on the live chain.
  const list = built.picked.map((c, i) => ({ poolId: c.poolId, token: c.token, weightBps: built.file.weightsBps[i]!, perRunCap: capUsdc }));
  let accepted = "yes";
  try {
    await client.simulateContract({ address: registry, abi: registryAbi, functionName: "propose", args: [list, fingerprint, "https://pantheonindex.com/trials"], account: curator });
  } catch (e) {
    const revert = e instanceof BaseError ? (e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null) : null;
    const idx = revert?.data?.errorName === "BadList" ? Number(revert.data.args?.[0]) : null;
    accepted = `NO: ${revert?.data?.errorName ?? (e as Error).message.split("\n")[0]}${idx !== null ? ` (coin ${built.file.symbols[idx] ?? idx})` : ""}`;
  }

  const dir = join(cfg.outDir, "trials");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `round-${round}.json`), bytes);
  writeFileSync(join(dir, `round-${round}.tree.json`), `${JSON.stringify(built.tree.dump(), null, 2)}\n`);

  console.log(`Round ${round} from DELPHI's scan at block ${head} (${built.file.scannedAt})`);
  console.log(`${candidates.length} coins traded in USDC; ${built.file.excluded.length} shown as excluded; basket:`);
  built.file.symbols.forEach((s, i) => console.log(`  ${(s ?? "?").padEnd(10)} ${(built.file.weightsBps[i]! / 100).toFixed(2).padStart(6)}%   real volume ${(built.file.ranking[i]!.realVolume / 1e6).toFixed(6)} USDC`));
  for (const x of built.file.excluded.slice(0, 5)) console.log(`  excluded ${x.symbol ?? x.token}: ${x.why}`);
  for (const w of built.warnings) console.log(`  warning: ${w}`);
  console.log(`Merkle root (per-coin rows): ${built.file.merkleRoot}`);
  console.log(`Fingerprint the registry will store (keccak256 of the file): ${fingerprint}`);
  console.log(`Registry dry run as the curator: ${accepted}`);
  console.log(`Wrote ${join(dir, `round-${round}.json`)} and the tree file`);

  const cmp = opt("--compare");
  if (cmp) {
    const old = JSON.parse(readFileSync(resolve(cmp), "utf8")) as { tokens: string[]; weightsBps: number[]; ranking: Array<{ symbol: string; realVolume: number }> };
    const same = JSON.stringify(old.tokens) === JSON.stringify(built.file.tokens) && JSON.stringify(old.weightsBps) === JSON.stringify(built.file.weightsBps);
    console.log(`\nCompared with ${cmp}: same coins and weights: ${same ? "YES" : "NO"}`);
    old.ranking.forEach((o, i) => {
      const n = built.file.ranking.find((x) => x.symbol === o.symbol);
      console.log(`  ${String(i + 1).padStart(2)}. ${o.symbol.padEnd(8)} then ${o.realVolume}  now ${n ? `#${built.file.ranking.indexOf(n) + 1} ${n.realVolume}` : "not ranked"}`);
    });
  }
} finally {
  store.close();
}

