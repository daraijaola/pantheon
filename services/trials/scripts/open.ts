// Opens a Trials vote: writes deployments/trials/round-N.vote.json from DELPHI's latest data. Commit the
// file and the vote is live (the service re-reads the folder on every request).
//   node scripts/open.ts --round 3 --hours 46 [--opens 2026-10-15T12:00:00Z] [--seats 3]
// A coin can be voted for if it traded with someone other than its creator, DELPHI never flagged it,
// it's priced in USDC (DELPHI's round data only holds those), it isn't PNTH, and it will be at least 72
// hours old (the basket list's MIN_AGE) when the vote closes, so the winners can enter the basket.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getAddress } from "viem";
import { RoundDef } from "../src/round.ts";

const args = process.argv.slice(2);
const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const DELPHI_OUT = resolve(opt("--delphi") ?? "../delphi/out");
const OUT_DIR = resolve(opt("--out") ?? "../../deployments/trials");
const deployment = JSON.parse(readFileSync(resolve(opt("--deployment") ?? "../../deployments/elysium-testnet.json"), "utf8")) as {
  chainId: number;
  pnth: string;
};

const round = Number(opt("--round"));
const hours = Number(opt("--hours") ?? 46);
const seats = Number(opt("--seats") ?? 3);
const opensAt = Math.floor((opt("--opens") ? Date.parse(opt("--opens")!) : Date.now()) / 1000);
const closesAt = opensAt + Math.round(hours * 3600);
const MIN_AGE_SEC = 72 * 3600;
if (!Number.isInteger(round) || round < 1) throw new Error("--round N is required");

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

const def = RoundDef.parse({
  round,
  chainId: deployment.chainId,
  opensAt,
  closesAt,
  seats,
  method:
    `Wallets with PNTH staked pick up to ${seats} coins; each pick counts 1 vote for the stake, plus 1, 2 or 3 more for a HYPE Passport ` +
    `(by tier; a Passport alone also votes). The ${seats} coins with the most votes ` +
    `take ${seats} seats in round ${round}'s basket; equal votes go to the coin with more independent trading. The other seats go to the ` +
    `coins with the most independent trading, by DELPHI's count (round ${delphiRound} data).`,
  source: { delphiRound, scannedAt: delphiFile.scannedAt },
  candidates,
});
const file = join(OUT_DIR, `round-${round}.vote.json`);
writeFileSync(file, `${JSON.stringify(def, null, 2)}\n`);
console.log(`round ${round}: ${candidates.length} candidates, open ${new Date(opensAt * 1000).toISOString()} to ${new Date(closesAt * 1000).toISOString()}`);
for (const c of candidates) console.log(`  ${String(c.rank).padStart(2)} ${(c.symbol ?? "?").padEnd(10)} ${c.verdict.padEnd(16)} ${(Number(c.realUsdc) / 1e6).toFixed(2)} USDC`);
console.log(`wrote ${file}`);
