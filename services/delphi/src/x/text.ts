// Checks on every reply before it can be posted: X's length rule, no links or tags, no words that
// accuse or advise, and every number traceable to what DELPHI's tools returned. A draft that fails
// goes back to Claude with the reasons; it is never posted.

/** X's weighted length: most characters count 1; emoji, CJK and other wide characters count 2. */
export function xLength(s: string): number {
  let n = 0;
  for (const ch of s.normalize("NFC")) {
    const c = ch.codePointAt(0)!;
    if ((c >= 0xfe00 && c <= 0xfe0f) || c === 0x200d) continue; // emoji modifiers: part of the emoji before
    const light = (c >= 0 && c <= 0x10ff) || (c >= 0x2000 && c <= 0x200d) || (c >= 0x2010 && c <= 0x201f) || (c >= 0x2032 && c <= 0x2037);
    n += light ? 1 : 2;
  }
  return n;
}

/** Text written by strangers (posts, coin names): control and bidi characters removed, length capped. */
export const untrusted = (s: string, max = 600) => [...s.replace(/[\p{Cc}\p{Cf}]/gu, " ")].slice(0, max).join("");

const LINK = /https?:\/\/|www\.|\b[a-z0-9-]{2,}\.(?:com|xyz|io|fun|app|org|net|gg|co|ai|finance|exchange|trade|money|lol|me|to|sh)\b/i;
const ACCUSE = /\b(?:scam|scams|scammer|scammers|scammy|fraud|fraudulent|fraudster|ponzi|honeypot|rug\s?pull(?:s|er|ers|ed)?|rugger|criminal|thief|thieves|stole|steal)\b/i;
const ADVISE =
  /\b(?:you should|i(?:'d| would) (?:buy|sell|ape|avoid|stay away)|(?:buy|sell|ape|avoid|dump) (?:it|this|now|here)\b|stay away|safe to (?:buy|ape|hold|invest)|not financial advice|nfa\b|dyor\b|guaranteed|to the moon|moon(?:ing)?\b|100x|1000x|gem\b|send it\b|lfg\b)/i;
const FULL_ADDRESS = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;
const SHORT_ADDRESS = /0x([0-9a-fA-F]{3,8})(?:…|\.\.\.)([0-9a-fA-F]{3,8})/g;
const HASH = /0x[0-9a-fA-F]{64}/g;

/** The numbers a text states, as values ("15.4M" → 15,400,000; "72%" → 72; "1,177" → 1177). */
export function numbersIn(s: string): number[] {
  const clean = s.replace(HASH, " ").replace(FULL_ADDRESS, " ").replace(SHORT_ADDRESS, " ").replace(/[$@][A-Za-z0-9_]+/g, " ");
  const out: number[] = [];
  for (const m of clean.matchAll(/(?<![\w.])(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s?(%|[kKmMbB](?![a-zA-Z]))?/g)) {
    let v = Number(m[1]!.replaceAll(",", "") + (m[2] ?? ""));
    const unit = m[3]?.toLowerCase();
    if (unit === "k") v *= 1e3;
    else if (unit === "m") v *= 1e6;
    else if (unit === "b") v *= 1e9;
    out.push(v);
  }
  return out;
}

/** True if `n` is one of `known`, allowing the rounding a reply does ("72.04" → "72", "15,440,000" → "15.4M"). */
export function grounded(n: number, known: readonly number[]): boolean {
  if (Number.isInteger(n) && n >= 0 && n <= 10) return true;
  return known.some((k) => Math.abs(n - k) <= Math.max(Math.abs(k) * 0.006, 0.051));
}

export type Check = {
  /** Every number the tools returned in this conversation, plus the asker's own words. */
  known: readonly number[];
  /** Lowercase full addresses the reply may name (the coin's own data, or every coin's). */
  addresses: ReadonlySet<string>;
  maxLength: number;
};

/** Why a draft reply can't be posted (empty when it can). */
export function replyProblems(text: string, c: Check): string[] {
  const errors: string[] = [];
  const t = text.trim();
  if (!t) return ["the reply is empty"];
  const len = xLength(t);
  if (len > c.maxLength) errors.push(`too long: ${len} characters, the limit is ${c.maxLength}. Cut words, keep the facts.`);
  if (LINK.test(t)) errors.push("no links or website names in a reply (links cost 13x more to post and look like spam)");
  if (/@\w/.test(t)) errors.push("no @tags in a reply: X already shows who she is answering");
  if (/#\w/.test(t)) errors.push("no hashtags");
  const accuse = t.match(ACCUSE);
  if (accuse) errors.push(`"${accuse[0]}" accuses someone; say what the wallets did instead`);
  const advise = t.match(ADVISE);
  if (advise) errors.push(`"${advise[0]}" is advice or hype; DELPHI states facts and never tells anyone to buy or sell`);
  if (HASH.test(t)) errors.push("no transaction hashes in a reply; they don't fit and nobody can click them");
  for (const a of t.match(FULL_ADDRESS) ?? []) if (!c.addresses.has(a.toLowerCase())) errors.push(`${a} is not in the data the tools returned`);
  for (const m of t.matchAll(SHORT_ADDRESS)) {
    const [, head, tail] = m;
    const hit = [...c.addresses].some((a) => a.slice(2).startsWith(head!.toLowerCase()) && a.endsWith(tail!.toLowerCase()));
    if (!hit) errors.push(`${m[0]} does not match any address the tools returned`);
  }
  const loose = numbersIn(t).filter((n) => !grounded(n, c.known));
  if (loose.length) errors.push(`these numbers are not in any tool result: ${[...new Set(loose)].join(", ")}. Use the tools' numbers (rounding is fine) or leave them out.`);
  return [...new Set(errors)];
}

/** Every number that appears in some text (tool results, the question), for grounding. */
export function knownNumbers(texts: Iterable<string>): number[] {
  const out = new Set<number>();
  for (const s of texts) {
    for (const m of s.replace(HASH, " ").replace(FULL_ADDRESS, " ").matchAll(/(?<![\d.,])(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?/g)) {
      out.add(Number(m[1]!.replaceAll(",", "") + (m[2] ?? "")));
    }
  }
  return [...out];
}
