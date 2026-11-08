// What the Passport page draws: one wallet's passport, read from the registry on Elysium.
// The stamps come from the passport's on-chain bitmap (services/passport, STAMP in src/config.ts).

export type PassportView = {
  /** Elysium wallet, lower case. */
  wallet: string;
  /** 1 Holder, 2 Staker, 3 Pillar. */
  tier: number;
  issued: Date;
  valid: Date;
  linked: Date;
  /** Stamp names this wallet holds, e.g. ["STAKER", "GENESIS"]. */
  stamps: string[];
  /** The staking multiplier, as the registry gives it: "1.20×". */
  boost: string;
  /** True when there's no passport to show and this is the sample. */
  example: boolean;
  status?: "Valid" | "Expired" | "Inactive";
};

export const TIER_NAMES = ["No tier", "Holder", "Staker", "Pillar"] as const;

export function registryView(wallet: string, p: { tier: number; stamps: number; issuedAt: bigint | number; expiry: bigint | number; linkedAt: bigint | number }, valid: boolean, multiplier: bigint, now = Date.now()): PassportView | null {
  if (!p.issuedAt || !p.linkedAt) return null;
  return {
    wallet: wallet.toLowerCase(), tier: p.tier,
    issued: new Date(Number(p.issuedAt) * 1000), valid: new Date(Number(p.expiry) * 1000), linked: new Date(Number(p.linkedAt) * 1000),
    stamps: stampNames(p.stamps), boost: `${(Number(multiplier) / 1e18).toFixed(2)}×`, example: false,
    status: valid ? "Valid" : Number(p.expiry) * 1000 <= now ? "Expired" : "Inactive",
  };
}

export const extraVotes = (v: PassportView) => v.example || v.status === "Valid" ? v.tier : 0;

/** Bit order of the stamp bitmap (services/passport/src/config.ts → STAMP). */
export const STAMP_BITS = ["STAKER", "KHYPE", "GENESIS", "VETERAN", "TRADER", "HYPURR", "KNTQ", "SEASONED"] as const;

export function stampNames(bits: number): string[] {
  return STAMP_BITS.filter((_, i) => (bits & (1 << i)) !== 0);
}

/** A sample holder, shown when the wallet has no passport yet (always labelled as an example). */
export const EXAMPLE: PassportView = {
  wallet: "0x7f3ab2c90d4e61f8a35b0c2e9d17f4a6b8c3e41e",
  tier: 2,
  issued: new Date(Date.UTC(2026, 10, 1)),
  valid: new Date(Date.UTC(2026, 10, 8)),
  linked: new Date(Date.UTC(2026, 9, 12)),
  stamps: ["STAKER", "GENESIS", "VETERAN", "TRADER", "SEASONED"],
  boost: "1.20×",
  example: true,
};

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
export const dmy = (d: Date) => `${String(d.getUTCDate()).padStart(2, "0")} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
const yymmdd = (d: Date) => `${String(d.getUTCFullYear()).slice(2)}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;

export const passportNo = (v: PassportView) => v.wallet.slice(-8).toUpperCase();
export const shortWallet = (v: PassportView) => `${v.wallet.slice(0, 6)}…${v.wallet.slice(-4)}`;

/** ICAO 9303 check digit: weights 7, 3, 1; "<" is 0, A–Z are 10–35. */
function check(s: string): string {
  const w = [7, 3, 1];
  let sum = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const v = c === "<" ? 0 : c >= "0" && c <= "9" ? c.charCodeAt(0) - 48 : c.charCodeAt(0) - 55;
    sum += v * w[i % 3];
  }
  return String(sum % 10);
}
const fill = (s: string, n: number) => (s + "<".repeat(n)).slice(0, n);

/** The machine-readable zone, as on a real passport (TD3): two lines of 44 with real check digits. */
export function mrzLines(v: PassportView): [string, string] {
  const l1 = fill(`P<PNTHOLDER<<${v.wallet.slice(2, 10).toUpperCase()}<${v.wallet.slice(-4).toUpperCase()}`, 44);
  const doc = fill(passportNo(v), 9);
  const birth = yymmdd(v.linked);
  const exp = yymmdd(v.valid);
  const opt = fill(`TIER${v.tier}<${(TIER_NAMES[v.tier] ?? "").toUpperCase()}`, 14);
  const docC = check(doc), birthC = check(birth), expC = check(exp), optC = check(opt);
  const composite = check(doc + docC + birth + birthC + exp + expC + opt + optC);
  return [l1, `${doc}${docC}HYP${birth}${birthC}<${exp}${expC}${opt}${optC}${composite}`];
}
