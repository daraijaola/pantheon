// Closes a Trials vote and prepares the round file the curator proposes. Run after the vote closes:
//   node scripts/close.ts --round 3 [--coins 10]
//       counts the ballots, picks the list (the vote's winners, then the most independent trading) and
//       prints the DELPHI command that builds the proposal for exactly that list
//   node scripts/close.ts --round 3 --merge ../delphi/out/trials/round-3.json
//       checks DELPHI's file holds exactly that list, adds the vote to it (every signed ballot, the count,
//       the winners) and writes deployments/trials/round-3.json. Proposing it (script/Testnet.s.sol
//       propose) stores keccak256 of that file on-chain, so the ballots are part of what was proposed.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Ballot } from "../src/ballot.ts";
import { loadRounds } from "../src/round.ts";
import { tally, winners } from "../src/tally.ts";

const args = process.argv.slice(2);
const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const API = opt("--api") ?? "http://127.0.0.1:8790";
const ROUNDS = resolve(opt("--rounds") ?? "../../deployments/trials");
const n = Number(opt("--round"));
const coins = Number(opt("--coins") ?? 10);

const def = loadRounds(ROUNDS).find((r) => r.round === n);
if (!def) throw new Error(`no round-${n}.vote.json in ${ROUNDS}`);
if (Date.now() / 1000 < def.closesAt) throw new Error(`round ${n} is still open until ${new Date(def.closesAt * 1000).toISOString()}`);

const res = await fetch(`${API}/trials/rounds/${n}`);
if (!res.ok) throw new Error(`the vote service answered ${res.status}`);
const ballots = ((await res.json()) as { ballotList: Ballot[] }).ballotList.filter((b) => b.receivedAt < def.closesAt);

const won = winners(def, ballots);
const wonSet = new Set(won.map((t) => t.toLowerCase()));
const rest = def.candidates.filter((c) => !wonSet.has(c.token.toLowerCase())).slice(0, Math.max(0, coins - won.length));
const pick = [...won, ...rest.map((c) => c.token)];
const pickSet = new Set(pick.map((t) => t.toLowerCase()));
const sym = (t: string) => def.candidates.find((c) => c.token.toLowerCase() === t.toLowerCase())?.symbol ?? t;

const merge = opt("--merge");
if (!merge) {
  console.log(`round ${n}: ${ballots.length} ballots`);
  for (const c of tally(def, ballots).filter((c) => c.votes > 0)) console.log(`  ${sym(c.token).padEnd(10)} ${c.votes} votes from ${c.voters} voters`);
  console.log(`voted in: ${won.map(sym).join(", ") || "nobody voted: every seat goes by trading"}`);
  console.log(`by trading: ${rest.map((c) => sym(c.token)).join(", ")}`);
  const leaveOut = def.candidates.filter((c) => !pickSet.has(c.token.toLowerCase()));
  console.log("\nBuild the proposal in services/delphi (as ayinde), then run this script again with --merge:");
  console.log(
    `  node scripts/trials.ts --round ${n} --coins ${pick.length} ` +
      leaveOut.map((c) => `--exclude '${c.token}:not picked in round ${n}'s vote or by trading'`).join(" "),
  );
  console.log("If DELPHI's file then holds a coin outside this list, add an --exclude for it too: --merge checks.");
} else {
  const file = JSON.parse(readFileSync(resolve(merge), "utf8")) as { round: number; tokens: string[] } & Record<string, unknown>;
  if (file.round !== n) throw new Error(`${merge} is round ${file.round}, not ${n}`);
  const got = new Set(file.tokens.map((t) => t.toLowerCase()));
  const missing = pick.filter((t) => !got.has(t.toLowerCase()));
  const extra = file.tokens.filter((t) => !pickSet.has(t.toLowerCase()));
  if (missing.length || extra.length) {
    throw new Error(
      `DELPHI's list differs from the vote's: missing ${missing.map(sym).join(", ") || "none"}, extra ${extra.join(", ") || "none"}. ` +
        "Exclude the extras (or check the missing coins are still eligible) and build it again.",
    );
  }
  const out = {
    ...file,
    vote: {
      round: n,
      method: def.method,
      opensAt: def.opensAt,
      closesAt: def.closesAt,
      seats: def.seats,
      winners: won,
      tally: tally(def, ballots),
      ballots,
      candidatesFile: `round-${n}.vote.json`,
    },
  };
  const path = resolve(ROUNDS, `round-${n}.json`);
  writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`wrote ${path}: ${file.tokens.length} coins, ${won.length} voted in, ${ballots.length} ballots. Propose it with:`);
  console.log(`  forge script script/Testnet.s.sol --sig "propose(string)" deployments/trials/round-${n}.json --rpc-url elysium`);
}
