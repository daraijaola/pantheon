import { profile } from "../../network.mts";
// Contracts we can name for sure, so an approval reads "Ascend's router", not an address. Anything else
// stays unnamed: a name here is a claim, so nothing goes in unless it's checked.
type Deployment = { staking: string; indexVault?: string | undefined; covenantFactory?: string | undefined };

const ASCEND: Readonly<Record<string, string>> = profile(process.env, "uploaded").network.knownContracts ?? {};

export function knownContracts(d: Deployment): Record<string, string> {
  const named: Record<string, string> = { ...ASCEND, [d.staking.toLowerCase()]: "PANTHEON staking" };
  if (d.indexVault) named[d.indexVault.toLowerCase()] = "PANTHEON's basket vault";
  if (d.covenantFactory) named[d.covenantFactory.toLowerCase()] = "the Covenant factory";
  return named;
}
