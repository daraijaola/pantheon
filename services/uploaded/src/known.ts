// Contracts we can name for sure, so an approval reads "Ascend's router", not an address. Anything else
// stays unnamed: a name here is a claim, so nothing goes in unless it's checked.
type Deployment = { staking: string; indexVault?: string | undefined; covenantFactory?: string | undefined };

/** Testnet addresses from the project notes and DELPHI's settings, each with code on the chain. They change on mainnet. */
const ASCEND: Readonly<Record<string, string>> = {
  "0x90332b0ecbb2c9517f405627b0dd5d5265246563": "Ascend's router",
  "0xe2f6254508deb93da081837f545e0baf7b00d8e9": "Ascend's launchpad",
  "0x000000000022d473030f116ddee9f6b43ac78ba3": "Permit2",
  "0xa6e7103abfb06f8231ed9c84e7dc2a7f8570a9a6": "Ascend's ListingDesk",
  "0xd218817cfcca3ae397de3a6e66889d4fb4b9e2d1": "PerpMe's router",
  "0x296a8d32ac9315cd9aaa33b1e624eb206d35638c": "PerpMe's launch factory",
  "0xd85fc505093a6b4a2afe6ce5069ce6e4e0c9ea83": "PerpMe's position manager",
  "0x31a67d054d34ec18cb23a43b0e3ad1f756aa1500": "PANTHEON's swap helper",
};

export function knownContracts(d: Deployment): Record<string, string> {
  const named: Record<string, string> = { ...ASCEND, [d.staking.toLowerCase()]: "PANTHEON staking" };
  if (d.indexVault) named[d.indexVault.toLowerCase()] = "PANTHEON's basket vault";
  if (d.covenantFactory) named[d.covenantFactory.toLowerCase()] = "the Covenant factory";
  return named;
}
