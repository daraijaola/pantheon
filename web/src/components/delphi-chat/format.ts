// DELPHI's answers are plain text with a few marks (see src/lib/delphi-chat.ts). This turns the part
// written so far into blocks the page can draw, and keeps a running count of words, so the word being
// written is always the last one drawn.

export type Verdict = "FLAG" | "WATCH" | "CLEAN" | "NOT_ENOUGH_DATA";

export type Piece =
  | { kind: "word"; text: string; n: number }
  | { kind: "verdict"; verdict: Verdict; n: number }
  | { kind: "tx"; hash: string; n: number }
  | { kind: "address"; address: string; n: number };

export type Block = { kind: "head" | "text" | "label" | "point" | "note"; pieces: Piece[]; proof: Piece[] };

const VERDICT = /^\[(FLAG|WATCH|CLEAN|NOT ENOUGH DATA)\]/;
const HASH = /^0x[0-9a-fA-F]{64}[.,;:)]?$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}[.,;:)]?$/;

/** Blocks for `text`, which is cut at a word boundary. */
export function blocks(text: string): Block[] {
  const out: Block[] = [];
  let n = 0;
  let para: Block | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) {
      para = null;
      continue;
    }
    let kind: Block["kind"] = "text";
    let body = line;
    const v = VERDICT.exec(line);
    if (v) {
      kind = "head";
      body = line.slice(v[0].length).trim();
    } else if (line.startsWith("## ") || line === "##") {
      kind = "label";
      body = line.slice(2).trim();
      n++; // the mark itself was a word
    } else if (/^[-•*] /.test(line) || line === "-") {
      kind = "point";
      body = line.slice(1).trim();
      n++;
    } else if (line.startsWith("> ") || line === ">") {
      kind = "note";
      body = line.slice(1).trim();
      n++;
    }
    // Plain lines next to each other are one paragraph.
    if (kind === "text" && para) {
      para.pieces.push(...words(body, () => n++));
      continue;
    }
    const block: Block = { kind, pieces: [], proof: [] };
    if (v) block.pieces.push({ kind: "verdict", verdict: v[1].replace(/ /g, "_") as Verdict, n: n++ });
    for (const p of words(body, () => n++)) (p.kind === "tx" ? block.proof : block.pieces).push(p);
    out.push(block);
    para = kind === "text" ? block : null;
  }
  return out;
}

function words(body: string, next: () => number): Piece[] {
  if (!body) return [];
  // Markdown emphasis isn't drawn: drop the marks rather than show them.
  return body.replace(/\*\*|__|`/g, "").split(/\s+/).filter(Boolean).map((w): Piece => {
    if (HASH.test(w)) return { kind: "tx", hash: w.slice(0, 66), n: next() };
    if (ADDRESS.test(w)) return { kind: "address", address: w.slice(0, 42), n: next() };
    return { kind: "word", text: w, n: next() };
  });
}

/** The answer as plain text, for copying. The head line says the verdict in words, so the pill goes. */
export function plain(text: string): string {
  return text
    .replace(/^\[(FLAG|WATCH|CLEAN|NOT ENOUGH DATA)\]\s*/gm, "")
    .replace(/^## /gm, "")
    .replace(/^[-*] /gm, "• ")
    .replace(/^> /gm, "")
    .trim();
}

export const LABEL: Record<Verdict, string> = { FLAG: "Flagged", WATCH: "Watch", CLEAN: "Clean", NOT_ENOUGH_DATA: "Not enough data" };

export const shortHash = (h: string) => `${h.slice(0, 6)}…${h.slice(-4)}`;

/**
 * Where the next word ends, from `from` (a word boundary). Null if the text so far has no whole word
 * after it; `final` says the stream is over, so the last word counts even without a space after it.
 */
export function nextWord(text: string, from: number, final: boolean): { end: number; word: string; breaks: boolean } | null {
  let i = from;
  let breaks = false;
  while (i < text.length && /\s/.test(text[i])) {
    if (text[i] === "\n") breaks = true;
    i++;
  }
  if (i >= text.length) return null;
  let j = i;
  // A verdict with spaces in it is one mark: it turns into a pill, so it's written in one go.
  const tag = /^\[NOT ENOUGH DATA\]/.exec(text.slice(i, i + 17));
  if (tag) j = i + tag[0].length;
  else if ("[NOT ENOUGH DATA]".startsWith(text.slice(i, i + 17)) && text.length - i < 17 && !final) return null;
  while (j < text.length && !/\s/.test(text[j])) j++;
  if (j >= text.length && !final) return null; // the word may still be arriving
  return { end: j, word: text.slice(i, j), breaks };
}
