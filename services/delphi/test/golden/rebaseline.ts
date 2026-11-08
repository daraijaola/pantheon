import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { current, digest, fixture, inputHash, version } from "./baseline.ts";

export function acceptRules(accepted: string | undefined, reason: string | undefined, existing: boolean): void {
  if (accepted !== version() || !reason?.trim()) throw new Error("Pass --accept-rules matching RULES.version and a nonempty --reason after reviewing changed coins.");
  if (existing) throw new Error(`Refusing to overwrite ${version()}: bump RULES.version before re-baselining. Approved version files are immutable.`);
}
if (import.meta.main) {
  const args = process.argv.slice(2);
  const value = (name: string) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  const target = new URL(`${version()}.json`, fixture);
  const reason = value("--reason");
  acceptRules(value("--accept-rules"), reason, existsSync(target));
  const ledgerFile = new URL("ledger.json", fixture);
  const ledger = existsSync(ledgerFile) ? JSON.parse(readFileSync(ledgerFile, "utf8")) as Record<string, string> : {};
  if (ledger[version()]) throw new Error("This rules version is already approved in the ledger; bump it.");
  const text = JSON.stringify({ rules: version(), reason, inputHash: inputHash(), coins: current() }, null, 2) + "\n";
  writeFileSync(target, text, { flag: "wx" });
  ledger[version()] = digest(text);
  writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2) + "\n");
  console.log(`Recorded ${Object.keys(JSON.parse(text).coins as object).length} cases for ${version()}; retain all older versions.`);
}
