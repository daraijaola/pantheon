// Disputes about DELPHI's feed records, for the person who answers them. Every dispute gets a written answer.
//   node scripts/disputes.ts                                       the open disputes, oldest first
//   node scripts/disputes.ts all                                   every dispute, with its answer
//   node scripts/disputes.ts answer <id> <changed|upheld|answered> "<text>"
//     changed:  DELPHI was wrong and the rule or label is fixed (for every coin, not just this one)
//     upheld:   the record stands, and the text says why, with the evidence
//     answered: a reply that is neither (a question, a duplicate, spam)
// FEED_DB is the feed's database (default data/feed.db). Text people sent is printed escaped, so nothing in
// a dispute can move the cursor, recolour the terminal or hide characters.
import { existsSync } from "node:fs";
import type { StoredDispute } from "../src/live/store.ts";
import { FeedStore } from "../src/live/store.ts";

/** Text from outside, made safe to print: control characters, escapes and direction overrides shown as codes. */
function safe(s: string): string {
// eslint-disable-next-line no-control-regex -- finding control characters is the point
  return s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

const STATUSES = ["changed", "upheld", "answered"] as const;

export function runDisputes(args: string[], dbPath: string, io: Pick<Console, "log" | "error"> = console): number {
  if (!existsSync(dbPath)) {
    io.error(`no feed database at ${dbPath} (set FEED_DB)`);
    return 2;
  }
  const [cmd, ...rest] = args;
  const store = new FeedStore(dbPath);
  function show(d: StoredDispute): void {
    io.log(`#${d.id}  ${new Date(d.atMs).toISOString()}  ${d.status}  ${d.token}`);
    io.log(`   from:    ${safe(d.contact) || "(no contact)"}`);
    if (d.wallet) io.log(`   signed:  by ${d.wallet}, signature checked (never published)`);
    io.log(`   message: ${safe(d.message).replace(/\r?\n/g, "\n            ")}`);
    if (d.answer !== null) io.log(`   answer:  ${safe(d.answer)}`);
    const rec = store.get(d.token);
    if (rec) io.log(`   record:  ${rec.verdict} (${rec.rules}), checked ${new Date(rec.checkedAtMs).toISOString()}: ${rec.reportUrl}`);
  }
  try {
    if (cmd === undefined || cmd === "all") {
      const list = store.disputes(cmd === "all" ? undefined : "open");
      if (!list.length) io.log(cmd === "all" ? "no disputes yet" : "no open disputes");
      for (const d of list) show(d);
    } else if (cmd === "answer") {
      const [idArg, status, text] = rest;
      const id = Number(idArg);
      const d = store.disputes().find((x) => x.id === id);
      if (!/^\d+$/.test(idArg ?? "") || !d) {
        io.error(`no dispute #${idArg ?? "?"}`);
        return 1;
      }
      if (!STATUSES.includes(status as (typeof STATUSES)[number])) {
        io.error(`status must be one of: ${STATUSES.join(", ")}`);
        return 2;
      }
      if (!text?.trim()) {
        io.error('add the answer text, in quotes: answer <id> <status> "<text>"');
        return 2;
      }
      if (text.length > 1200) {
        io.error(`the answer is ${text.length} characters; keep it to 1,200`);
        return 2;
      }
      if (d.status !== "open") io.log(`note: #${id} was already ${d.status}; replacing its answer`);
      store.answerDispute(id, status as (typeof STATUSES)[number], text.trim());
      show(store.disputes().find((x) => x.id === id)!);
      io.log("\nNow reply to them at the contact above, and if the verdict changes, re-run the checks so the history shows why.");
    } else {
      io.error('usage: node scripts/disputes.ts [all | answer <id> <changed|upheld|answered> "<text>"]');
      return 2;
    }
    return 0;
  } finally {
    store.close();
  }
}

if (import.meta.main) process.exitCode = runDisputes(process.argv.slice(2), process.env.FEED_DB || "data/feed.db");
