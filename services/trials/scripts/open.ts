import { backendEnv, statePath, assertDeploymentChain } from "../../network.mts";
// Opens a Trials vote: writes deployments/trials/round-N.vote.json from DELPHI's latest data. Commit the
// file and the vote is live (the service re-reads the folder on every request).
//   node scripts/open.ts --round 6 --hours 46 [--opens 2026-10-15T12:00:00Z] [--seats 3] [--coins 10]
//                        [--min-stake 1] [--min-hold-days 3]
// A coin can be voted for if it traded with someone other than its creator, DELPHI never flagged it,
// it's priced in USDC (DELPHI's round data only holds those), it isn't PNTH, and it will be at least 72
// hours old (the basket list's MIN_AGE) when the vote closes, so the winners can enter the basket.
// The basket list will hold --coins coins. All but --seats of them are in by trading before anyone votes
// (the best ranks), so whenever there are more candidates than --coins, the vote decides --seats coins of
// its own. A stake gives its vote only if it holds --min-stake PNTH and started --min-hold-days before the
// vote opens, so a stake can't vote, move to a new wallet during the vote and vote again.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getAddress } from "viem";
import { RoundDef } from "../src/round.ts";

const args = process.argv.slice(2);
const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const DELPHI_OUT = resolve(statePath(opt("--delphi") ?? "../delphi/out", process.env, true));
const OUT_DIR = resolve(statePath(opt("--out") ?? "../../deployments/trials", process.env, true));
mkdirSync(OUT_DIR, { recursive: true });
const deployment = JSON.parse(readFileSync(resolve(opt("--deployment") ?? backendEnv(process.env, "trials").DEPLOYMENT_FILE!), "utf8")) as {
  chainId: number;
  pnth: string;
};

assertDeploymentChain(process.env, deployment);
const round = Number(opt("--round"));
const hours = Number(opt("--hours") ?? 46);
const seats = Number(opt("--seats") ?? 3);
const coins = Number(opt("--coins") ?? 10);
const minStake = Number(opt("--min-stake") ?? 1);
const minHoldDays = Number(opt("--min-hold-days") ?? 3);
const opensAt = Math.floor((opt("--opens") ? Date.parse(opt("--opens")!) : Date.now()) / 1000);
const closesAt = opensAt + Math.round(hours * 3600);
const MIN_AGE_SEC = 72 * 3600;
if (!Number.isInteger(round) || round < 1) throw new Error("--round N is required");
if (!Number.isInteger(coins) || coins < 1) throw new Error("--coins must be a whole number, 1 or more");
if (!Number.isInteger(minStake) || minStake < 1) throw new Error("--min-stake is whole PNTH, 1 or more");
if (!Number.isFinite(minHoldDays) || minHoldDays < 0) throw new Error("--min-hold-days must be 0 or more");
const minHoldSec = Math.round(minHoldDays * 86_400);

// DELPHI's newest round data: one leaf per coin it considered (token, pool, verdict, volumes, rank, …).
const latest = readdirSync(join(DELPHI_OUT, "trials"))
  .map((n) => /^round-(\d+)\.tree\.json$/.exec(n))
  .filter((m): m is RegExpExecArray => m !== null)
  .sort((a, b) => Number(b[1]) - Number(a[1]))[0];
if (!latest) throw new Error(`no DELPHI round data in ${DELPHI_OUT}/trials: run scripts/trials.ts in services/delphi first`);
const delphiRound = Number(latest[1]);
const tree = JSON.parse(readFileSync(join(DELPHI_OUT, "trials", latest[0]), "utf8")) as { values: Array<{ value: unknown[] }> };
const delphiFile = JSON.parse(readFileSync(join(DELPHI_OUT, "trials", `round-${delphiRound}.json`), "utf8")) as { scannedAt: string };
const site = JSON.parse(readFileSync(join(DELPHI_OUT, "site.json"), "utf8")) as {
  coins: Array<{ token: string; symbol: string | null; verdict: string; launched: string; headline?: string }>;
};
const coinInfo = new Map(site.coins.map((c) => [c.token.toLowerCase(), c]));

const VERDICT = ["", "CLEAN", "WATCH", "NOT_ENOUGH_DATA", "FLAG"] as const;
const pnth = deployment.pnth.toLowerCase();
const candidates = tree.values
  .map(({ value: v }) => ({ token: String(v[0]), poolId: String(v[1]), verdict: VERDICT[Number(v[2])] ?? "", realUsdc: BigInt(String(v[6])) }))
  .filter((c) => c.realUsdc > 0n && c.verdict !== "FLAG" && c.verdict !== "" && c.token.toLowerCase() !== pnth)
  .map((c) => ({ ...c, info: coinInfo.get(c.token.toLowerCase()) }))
  .filter((c) => c.info && Date.parse(c.info.launched) / 1000 + MIN_AGE_SEC <= closesAt)
  .sort((a, b) => (b.realUsdc > a.realUsdc ? 1 : b.realUsdc < a.realUsdc ? -1 : a.token.toLowerCase() < b.token.toLowerCase() ? -1 : 1))
  .map((c, i) => ({
    token: getAddress(c.token),
    poolId: c.poolId,
    symbol: c.info!.symbol,
    verdict: c.verdict as "CLEAN" | "WATCH" | "NOT_ENOUGH_DATA",
    ...(c.info!.headline ? { headline: c.info!.headline } : {}),
    realUsdc: c.realUsdc.toString(),
    launchedAt: Math.floor(Date.parse(c.info!.launched) / 1000),
    rank: i + 1,
  }));

// The list holds `coins` coins, or every candidate if there are fewer. The vote decides the last `seats`.
const tradingSeats = Math.max(0, Math.min(coins, candidates.length) - seats);

// The method, in words, for the round file and the site.
const count = (n: number, one: string, many: string) => (n === 1 ? one : `${n} ${many}`);
const held = minHoldSec === 0 ? "staked by the time the vote opened" : `staked ${count(minHoldDays, "a day", "days")} or more before the vote opened`;
const data = `by DELPHI's count (round ${delphiRound} data)`;
const votes =
  `each pick counts 1 vote for a stake of at least ${minStake} PNTH ${held} (by the staking contract's start date, which adding ` +
  "PNTH moves later and unstaking restarts), plus 1, 2 or 3 more for a HYPE Passport (by tier; a Passport alone also votes)";
const top = `The ${count(seats, "coin", "coins")} with the most votes ${seats === 1 ? "takes" : "take"}`;
const ties = "equal votes go to the coin with more independent trading";
const method =
  tradingSeats > 0
    ? `The ${count(tradingSeats, "coin", "coins")} with the most independent trading, ${data}, ${tradingSeats === 1 ? "is" : "are"} in round ${round}'s ` +
      `basket already. Wallets with PNTH staked pick up to ${count(seats, "1 coin", "coins")} from the rest; ${votes}. ${top} the next ` +
      `${count(seats, "seat", "seats")}; ${ties}. A seat the vote leaves empty goes to the coin with the most independent trading among the rest.`
    : `Wallets with PNTH staked pick up to ${count(seats, "1 coin", "coins")}; ${votes}. ${top} ${count(seats, "a seat", "seats")} in round ` +
      `${round}'s basket; ${ties}. A seat the vote leaves empty goes to the coin with the most independent trading, ${data}.`;

const def = RoundDef.parse({
  round,
  chainId: deployment.chainId,
  opensAt,
  closesAt,
  seats,
  tradingSeats,
  minStake,
  minHoldSec,
  method,
  source: { delphiRound, scannedAt: delphiFile.scannedAt },
  candidates,
});
const file = join(OUT_DIR, `round-${round}.vote.json`);
writeFileSync(file, `${JSON.stringify(def, null, 2)}\n`);
console.log(`round ${round}: ${candidates.length} candidates, open ${new Date(opensAt * 1000).toISOString()} to ${new Date(closesAt * 1000).toISOString()}`);
console.log(
  tradingSeats > 0
    ? `in by trading: the top ${tradingSeats}. The vote picks ${seats} from the other ${candidates.length - tradingSeats}.`
    : `none in by trading: the vote picks ${seats} from all ${candidates.length}.`,
);
if (candidates.length <= coins) console.log(`note: with no more candidates than --coins ${coins}, every candidate gets a seat whatever the vote`);
console.log(`a stake votes with at least ${minStake} PNTH, staked by ${new Date((opensAt - minHoldSec) * 1000).toISOString()}`);
for (const c of candidates) {
  const tag = c.rank <= tradingSeats ? "  in by trading" : "";
  console.log(`  ${String(c.rank).padStart(2)} ${(c.symbol ?? "?").padEnd(10)} ${c.verdict.padEnd(16)} ${(Number(c.realUsdc) / 1e6).toFixed(2)} USDC${tag}`);
}
console.log(`wrote ${file}`);
