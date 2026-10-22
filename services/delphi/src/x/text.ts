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
const FILLER = /\b(?:not intent|can'?t call|cannot call|can'?t say (?:it'?s|if)|unverified by me|i read (?:wallet )?patterns|just what (?:the )?wallets did|likely|probably|seems to be|appears to be)\b/i;
const FULL_ADDRESS = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;
const SHORT_ADDRESS = /0x([0-9a-fA-F]{3,8})(?:…|\.\.\.)([0-9a-fA-F]{3,8})/g;
const HASH = /0x[0-9a-fA-F]{64}/g;

/** A number a reply states, and how much rounding its precision allows ("27%" ± 0.5, "15.4M" ± 50k). */
export type Stated = { value: number; tol: number; text: string; decimals: number };

/** The numbers a text states, as values ("15.4M" → 15,400,000; "72%" → 72; "1,177" → 1177). */
export function statedNumbers(s: string): Stated[] {
  const clean = s.replace(HASH, " ").replace(FULL_ADDRESS, " ").replace(SHORT_ADDRESS, " ").replace(/[$@][A-Za-z0-9_]+/g, " ");
  const out: Stated[] = [];
  for (const m of clean.matchAll(/(?<![\w.])(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s?(%|[kKmMbB](?![a-zA-Z]))?/g)) {
    const decimals = m[2] ? m[2].length - 1 : 0;
    const unit = m[3]?.toLowerCase();
    const scale = unit === "k" ? 1e3 : unit === "m" ? 1e6 : unit === "b" ? 1e9 : 1;
    const value = Number(m[1]!.replaceAll(",", "") + (m[2] ?? "")) * scale;
    out.push({ value, tol: 0.5 * 10 ** -decimals * scale, text: m[0].trim(), decimals });
  }
  return out;
}

export const numbersIn = (s: string) => statedNumbers(s).map((n) => n.value);

/** True if a stated number is one of `known`, rounded to the precision it was written with. */
export function grounded(n: number | Stated, known: readonly number[]): boolean {
  const { value, tol } = typeof n === "number" ? { value: n, tol: Math.max(Math.abs(n) * 0.006, 0.051) } : n;
  if (Number.isInteger(value) && value >= 0 && value <= 10) return true;
  return known.some((k) => Math.abs(value - k) <= tol + 1e-9);
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
  if (t.includes(";")) errors.push("no semicolons: use a new line or a full stop");
  const cashtags = t.match(/(?<![\w$])\$[A-Za-z][A-Za-z0-9]{0,11}\b/g) ?? [];
  if (cashtags.length > 1) errors.push(`X allows one $ticker per post: keep the $ on one (${cashtags[0]}) and write the others without it (PNTH, not $PNTH)`);
  const filler = t.match(FILLER);
  if (filler) errors.push(`"${filler[0]}": no disclaimers or guesses. State what DELPHI knows, or leave it out (name contracts with what_is_address).`);
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
  const stated = statedNumbers(t);
  const loose = stated.filter((n) => !grounded(n, c.known)).map((n) => n.text);
  if (loose.length) errors.push(`these numbers are not in any tool result: ${[...new Set(loose)].join(", ")}. Use the tools' numbers (rounded) or leave them out.`);
  const fussy = stated.filter((n) => n.decimals >= 2 || (n.decimals === 1 && n.value >= 10 && n.text.endsWith("%"))).map((n) => n.text);
  if (fussy.length) errors.push(`round these the way people write them: ${[...new Set(fussy)].join(", ")} (51%, not 50.78%; 15.4M, not 15,440,000)`);
  return [...new Set(errors)];
}

/** One of a coin's biggest holders, as the holders tool returns them (biggest first). */
export type TopHolder = { wallet: string; pctOfHeld: number; pctOfSupply: number; isCreator?: boolean; /** set when the wallet is in a linked group */ cluster?: string };

const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, ten: 10, dos: 2, tres: 3, cinco: 5, diez: 10, deux: 2, trois: 3, cinq: 5, dix: 10 };
const ORDINAL: Record<string, number> = { second: 2, "2nd": 2, segundo: 2, segunda: 2, deuxième: 2, third: 3, "3rd": 3, tercer: 3, tercero: 3, tercera: 3, troisième: 3 };
const N = `\\d{1,2}|${Object.keys(WORDS).join("|")}`;
const BIG = "biggest|largest|top|mayor(?:es)?|más grandes?|plus gros(?:ses?)?";
const ORD = Object.keys(ORDINAL).join("|");
// "the biggest", "the second largest", "the top 3", "the 3 biggest", "los 3 mayores", "le plus gros"
const RANKED = new RegExp(`(?:\\b(${ORD})\\s+)?(?<![\\w-])(?:(${N})\\s+)?(?:${BIG})(?![\\w-])(?:\\s+(${N})(?![\\d%.,]))?`, "giu");
// what follows the rank: "biggest [single] [linked] wallet(s)", or straight into the claim ("the biggest holds", "top holder:")
const HEAD = /^\s*(?:(?:single|individual|one)\s+)?((?:linked|connected|clustered|vinculad[oa]s?)\s+)?(?:(holders|wallets|addresses|accounts|billeteras|tenedores|portefeuilles|détenteurs)|(holder|wallet|address|account|share|stake|bag|billetera|tenedor|portefeuille|détenteur))?/iu;
const STRAIGHT = /^\s*(?:holds?|has|have|owns?|is|are|was|tiene|tienen|posee[n]?|es|son|détien(?:t|nent)|est|sont)\b|^\s*[:—–]|^\s*,?\s*with\b|^\s*\d[\d.,]*\s?%(?!\s+(?:of|de|des)\s+(?:the\s+|los\s+|las\s+)?(?:wallets|holders|addresses|billeteras)\b)/iu;
/** "the biggest wallet in the linked group": ranked among the linked wallets only. */
const IN_GROUP = /\bin (?:the|that|this|one|its) (?:linked |same )?(?:group|cluster)\b|\bdel grupo\b|\bdu groupe\b/i;
const TRADED = /\b(?:bought|buys?|sold|sells?|dumped|traded|got|received|compr[óo]|vendi[óo]|achet[ée]|vendu)\b/i;
const HOLDING_VERB = /\b(?:holds?|has|have|tiene|tienen|posee|détient|with)\b/i;
/** Words between two percentages that mean the second is about someone else ("42%, the next 27%"). */
const OTHER_SUBJECT = /\d|\b(?:and|y|et|while|next|then|followed|after|second|2nd|third|others?|rest|linked|group|cluster|hold|holds|has|have|tiene|tienen|siguiente|luego|suivant)\b/i;
// contracts and pools aren't in the holders list: a ranked line about one is checked elsewhere (grounding)
const NOT_A_WALLET = /\b(?:contracts?|staking|pools?|vaults?|contrato|contrat|bundles?)\b/i;
const TOGETHER = /\b(?:together|combined|between them|in total|altogether|juntos|juntas|entre (?:ellos|ellas|los|las)|en total|ensemble|à eux)\b/i;
const CREATOR = /\b(?:creator|dev|deployer|creador|créateur)\b/i;
const NEGATED = /\b(?:not|isn'?t|no es|n'est pas)\b/i;
const ADDRESS = /0x([0-9a-fA-F]{3,40})(?:(?:…|\.\.\.)([0-9a-fA-F]{3,8}))?/;

const near = (v: number, s: Stated, slack = 0) => Math.abs(v - s.value) <= s.tol + slack + 1e-9;
const fits = (h: TopHolder, s: Stated) => near(h.pctOfHeld, s) || near(h.pctOfSupply, s);

/**
 * A line that ranks holders ("the biggest holds 27%", "the top 3 hold 87%", "the second largest has
 * 11% of supply", "biggest wallet: 0x79a3…f23a") must match the holders tool, biggest first: the numbers
 * alone pass the grounding check even when they belong to someone else (seen in review: PACT's
 * "biggest holds 27%" was its second holder; the creator had 42%). A percentage may be of wallet-held
 * tokens or of supply. `top` is the holders tool's list, biggest first (ten is plenty).
 */
export function biggestProblems(text: string, top: readonly TopHolder[]): string[] {
  if (top.length === 0) return [];
  const errors: string[] = [];
  const describe = (list: readonly TopHolder[]) =>
    list
      .slice(0, 3)
      .map((h, i) => `#${i + 1} ${h.wallet.slice(0, 6)}…${h.wallet.slice(-4)}${h.isCreator ? " (the creator)" : ""}${h.cluster ? " (linked)" : ""}: ${Math.round(h.pctOfHeld)}% of wallet-held tokens, ${Math.round(h.pctOfSupply)}% of supply`)
      .join("; ");
  const real = describe(top);
  for (const line of text.split("\n")) {
    const found = [...line.matchAll(RANKED)];
    for (const [i, m] of found.entries()) {
      const end = m.index + m[0].length;
      const segment = line.slice(end, found[i + 1]?.index ?? line.length);
      const head = HEAD.exec(segment)!;
      const [, linkedWord, plural, single] = head;
      const rest = segment.slice(head[0].length);
      if (!(plural || single || ((linkedWord || !head[0].trim()) && STRAIGHT.test(rest)) || STRAIGHT.test(segment)) || NOT_A_WALLET.test(segment)) continue;
      const pcts = statedNumbers(segment).filter((s) => s.text.endsWith("%"));
      const count = m[2] ?? m[3];
      let n = count ? (WORDS[count.toLowerCase()] ?? Number(count)) : 1;
      // "the biggest linked wallets hold 33% and 24%": as many as it names; "top holders hold 80%": a group, unchecked
      if (!count && plural) {
        if (pcts.length < 2) continue;
        n = Math.min(pcts.length, 3);
      }
      const linked = !!linkedWord || IN_GROUP.test(segment.slice(0, pcts[0] ? segment.indexOf(pcts[0].text) : segment.length));
      const pool = linked ? top.filter((h) => h.cluster) : top;
      const at = (m[1] ? ORDINAL[m[1].toLowerCase()]! : 1) - 1;
      if (!(n >= 1) || (n > 1 && at > 0) || at + n > pool.length) continue;
      const holders = pool.slice(at, at + n);
      const wrong: string[] = [];
      if (n === 1) {
        const h = holders[0]!;
        // "the biggest wallet bought 5% at launch and still holds 42%": the share it holds, not what it bought
        let first = pcts[0];
        if (first && TRADED.test(segment.slice(0, segment.indexOf(first.text)))) {
          const verb = HOLDING_VERB.exec(segment.slice(segment.indexOf(first.text)));
          first = verb ? pcts.find((p) => segment.indexOf(p.text) > segment.indexOf(first!.text) + verb.index) : undefined;
          if (!first) continue;
        }
        if (first && !fits(h, first)) wrong.push(first.text);
        const firstEnd = first ? segment.indexOf(first.text) + first.text.length : segment.length;
        // "42% of wallet-held tokens (17% of supply)": the other base, said right after
        const second = first ? pcts[pcts.indexOf(first) + 1] : undefined;
        if (first && second) {
          const gap = segment.slice(firstEnd, segment.indexOf(second.text, firstEnd));
          if (gap.length <= 45 && !OTHER_SUBJECT.test(gap) && !fits(h, second)) wrong.push(second.text);
        }
        // the wallet it names, before its percentage or just after it ("biggest wallet: 0x79a3…f23a with 11%")
        const addr = ADDRESS.exec(segment);
        if (addr && (addr.index < firstEnd || (addr.index <= firstEnd + 25 && !OTHER_SUBJECT.test(segment.slice(firstEnd, addr.index))))) {
          const [whole, head, tail] = addr;
          const same = tail ? h.wallet.slice(2).startsWith(head!.toLowerCase()) && h.wallet.endsWith(tail.toLowerCase()) : whole.length === 42 && h.wallet === whole.toLowerCase();
          if (!same) wrong.push(whole);
        }
        const before = line.slice(0, m.index);
        const creatorBefore = /\b(?:creator|dev|deployer|creador|créateur)\s+(?:is|remains|es|est|sigue siendo)\s+(?:still\s+|todavía\s+|toujours\s+)?(?:the\s+|el\s+|la\s+|le\s+)?$/i.test(before);
        const creatorAfter = CREATOR.exec(segment);
        if (creatorBefore || (creatorAfter && !(first && segment.indexOf(first.text) < creatorAfter.index))) {
          const says = !NEGATED.test(creatorBefore ? before : segment.slice(0, creatorAfter!.index));
          if (says !== !!h.isCreator) wrong.push(says ? "the creator" : "not the creator");
        }
      } else if (pcts.length === 1 || (TOGETHER.test(segment) && pcts.length >= 1)) {
        const sum = { held: holders.reduce((a, h) => a + h.pctOfHeld, 0), supply: holders.reduce((a, h) => a + h.pctOfSupply, 0) };
        if (!near(sum.held, pcts[0]!, 0.05) && !near(sum.supply, pcts[0]!, 0.05)) wrong.push(`${pcts[0]!.text} together (the top ${n} hold ${Math.round(sum.held)}% of wallet-held tokens, ${Math.round(sum.supply)}% of supply)`);
      } else {
        pcts.slice(0, n).forEach((s, k) => !fits(holders[k]!, s) && wrong.push(s.text));
      }
      if (wrong.length) {
        const which = linked ? `The biggest linked wallets, from the holders tool: ${describe(pool)}` : `The holders tool, biggest first: ${real}`;
        errors.push(`"${line.trim()}": ${wrong.join(", ")} doesn't match the ${linked ? "biggest linked wallets" : "biggest holders"}. ${which}. Fix the line or drop it.`);
      }
    }
  }
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
