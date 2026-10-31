// Fake tickers: a coin that takes the symbol or name of a well-known token (USDC, WHYPE, KALOS…) at a
// different address. Names are compared after undoing the usual tricks: case, spaces, a leading "$",
// invisible characters, accents, full-width and "math" letters, Cyrillic and Greek letters that look
// Latin, and 0/O and 1/l/I swaps. Coin names are chosen by whoever launched the coin, so they are
// hostile text: summaries show invisible characters as <U+XXXX> instead of passing them on.
import type { Address } from "viem";

/** A token people know, and where DELPHI learned it is the real one. `address: null`: no token contract is real (native HYPE). */
export type KnownToken = { address: Address | null; symbol: string; name: string; source: string };

/**
 * Characters that print as nothing: zero-width spaces and joiners, bidi controls, soft hyphen, BOM,
 * variation selectors, Hangul fillers, tag characters. Kept as code-point ranges, not a regex: a
 * regex character class of combining marks is easy to get wrong.
 */
const HIDDEN_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x061c, 0x061c],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180b, 0x180f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x206f],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xe0000, 0xe007f],
];
const isHidden = (c: string) => {
  const cp = c.codePointAt(0)!;
  return cp < 0x20 || (cp >= 0x7f && cp < 0xa0) || HIDDEN_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
};
const dropHidden = (s: string) => [...s].filter((c) => !isHidden(c)).join("");

/** Cyrillic and Greek letters that look like Latin ones (Unicode confusables, the common ones). */
const HOMOGLYPHS: Readonly<Record<string, string>> = {
  // Cyrillic
  А: "A", В: "B", Е: "E", К: "K", М: "M", Н: "H", О: "O", Р: "P", С: "C", Т: "T", Х: "X", У: "Y", Ү: "Y", Ѕ: "S", І: "I", Ї: "I", Ј: "J", Ԁ: "D", Ԛ: "Q", Ԝ: "W", Ӏ: "I",
  а: "a", в: "b", е: "e", к: "k", м: "m", н: "h", о: "o", р: "p", с: "c", т: "t", х: "x", у: "y", ү: "y", ѕ: "s", і: "i", ї: "i", ј: "j", ԁ: "d", ԛ: "q", ԝ: "w", һ: "h", ӏ: "l", ɡ: "g",
  // Greek
  Α: "A", Β: "B", Ε: "E", Ζ: "Z", Η: "H", Ι: "I", Κ: "K", Μ: "M", Ν: "N", Ο: "O", Ρ: "P", Τ: "T", Υ: "Y", Χ: "X",
  α: "a", β: "b", γ: "y", ε: "e", ι: "i", κ: "k", ν: "v", ο: "o", ρ: "p", τ: "t", υ: "u", χ: "x", ϲ: "c", ϳ: "j",
};

/** Characters that only separate words: "U.S.D.C", "W-HYPE", "Staked KALOS". */
const SEPARATORS = /[\s._\-·•‧∙/\\|]+/gu;

/** Case, spaces, separators and a leading "$" undone: what a reader would call "the same name". */
export function plain(s: string): string {
  return dropHidden(s.normalize("NFKC")).toLowerCase().replace(SEPARATORS, "").replace(/^\$+/, "");
}

/** Everything a careless reader cannot tell apart mapped to one form: homoglyphs, accents, 0/O, 1/l/I. */
export function skeleton(s: string): string {
  const latin = [...dropHidden(s.normalize("NFKC"))].map((c) => HOMOGLYPHS[c] ?? c).join("");
  const bare = [...latin.normalize("NFKD")].filter((c) => !/\p{M}/u.test(c)).join("");
  return plain(bare).replace(/0/g, "o").replace(/[1i]/g, "l");
}

/** The name uses characters that print as nothing, or mixes Latin with Cyrillic or Greek letters. */
export function looksDisguised(s: string): boolean {
  const hidden = [...s].some(isHidden);
  const latin = /\p{Script=Latin}/u.test(s);
  const other = /[\p{Script=Cyrillic}\p{Script=Greek}]/u.test(s);
  return hidden || (latin && other);
}

/** Hostile text made safe to quote: invisible characters shown as <U+XXXX>, length capped. */
export function visible(s: string, max = 40): string {
  const shown = [...s].map((c) => (isHidden(c) ? `<U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}>` : c)).join("");
  return shown.length > max ? `${shown.slice(0, max)}…` : shown;
}

export type LookalikeMatch = {
  /** Which of the coin's own fields copies which field of the known token. */
  field: "symbol" | "name";
  knownField: "symbol" | "name";
  /** "same": equal once case, spaces and "$" are ignored. "lookalike": only equal after undoing look-alike letters. */
  how: "same" | "lookalike";
  known: KnownToken;
};

/** Every known token (at another address) whose symbol or name the coin's symbol or name copies. */
export function lookalikes(token: Address, meta: { symbol: string | null; name: string | null }, known: readonly KnownToken[]): LookalikeMatch[] {
  const out: LookalikeMatch[] = [];
  const own = (["symbol", "name"] as const).flatMap((field) => {
    const v = meta[field];
    return v && skeleton(v) ? [{ field, v }] : [];
  });
  for (const k of known) {
    if (k.address && k.address.toLowerCase() === token.toLowerCase()) continue;
    for (const { field, v } of own) {
      for (const knownField of ["symbol", "name"] as const) {
        const kv = k[knownField];
        if (!kv || skeleton(kv) !== skeleton(v)) continue;
        // One match per known token and field is enough (its symbol and name are often the same word).
        if (out.some((m) => m.known === k && m.field === field)) continue;
        out.push({ field, knownField, how: plain(kv) === plain(v) && !looksDisguised(v) ? "same" : "lookalike", known: k });
      }
    }
  }
  return out;
}
