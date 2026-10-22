// One mention, start to finish: is it really talking to her, is she within her limits, which coin it
// is about, what she answers, and whether that answer is posted (live) or only saved as a draft
// (shadow). Every outcome is recorded, so no post is ever answered twice.
import type { Answer, Context } from "./agent.ts";
import { fullText, XError, type Post, type User } from "./api.ts";
import { findCoin, type Found } from "./find.ts";
import type { XState } from "./state.ts";
import type { Verdict } from "../types.ts";
import type { Snapshot } from "./xtools.ts";

export type BotConfig = Readonly<{
  selfId: string;
  handle: string;
  mode: "shadow" | "live";
  dailyCap: number;
  perUserHourly: number;
  /** Lowercase usernames she may answer while testing; null = everyone. */
  allow: ReadonlySet<string> | null;
}>;

export type BotDeps = {
  api: {
    post(id: string): Promise<{ post: Post; byId: Map<string, Post>; users: Map<string, User> } | null>;
    reply(inReplyTo: string, text: string): Promise<string>;
  };
  state: XState;
  snapshot: () => Snapshot;
  /** Fresher data for one coin when there is any (falls back to the current snapshot). */
  refreshCoin?: (token: string) => Promise<Snapshot>;
  answer: (c: Context, snap: Snapshot) => Promise<{ answer: Answer; cost: number }>;
  /** A plain answer from DELPHI's report, for when the model can't give one that passes the checks. */
  fallback?: (snap: Snapshot, token: string) => { text: string; verdict: Verdict } | null;
  onDraft?: (d: { mention: string; author: string; question: string; reply: string; token: string | null }) => void;
  now?: () => number;
  log?: (msg: string) => void;
};

export type Outcome = {
  id: string;
  status: "replied" | "drafted" | "silent" | "skipped" | "failed" | "unsure" | "ignored";
  reason?: string;
  text?: string;
  /** X rate-limited her before anything went out: stop, and come back to this mention at this time (unix s). */
  retryAt?: number;
};

/** When X says "too many requests", the time it opens again (or in 5 minutes). */
const rateLimited = (err: unknown, now: number) => (err instanceof XError && err.status === 429 ? (err.resetAt ?? Math.floor(now / 1000) + 300) : null);

const leadingTags = /^(?:\s*@\w{1,15})+\s*/;

/**
 * Is the post talking to her? Yes if it replies to her own post, or if her handle is in what the
 * person wrote. A reply's leading @tags are added by X for everyone in the thread, so a handle there
 * only counts when she wasn't already in the thread (the post above neither is hers nor tags her).
 */
export function addressed(p: Post, cfg: Pick<BotConfig, "selfId" | "handle">, parent: Post | null = null): boolean {
  if (p.in_reply_to_user_id === cfg.selfId) return true;
  const me = new RegExp(`@${cfg.handle}\\b`, "i");
  const text = fullText(p);
  if (p.display_text_range && !p.note_tweet) {
    // X marks where the person's own words start; code points, not UTF-16 units.
    const own = [...text].slice(p.display_text_range[0]).join("");
    if (me.test(own)) return true;
  }
  const prefix = text.match(leadingTags)?.[0] ?? "";
  if (me.test(text.slice(prefix.length))) return true;
  if (!me.test(prefix)) return false;
  const isReply = p.referenced_tweets?.some((r) => r.type === "replied_to") ?? false;
  if (!isReply) return true;
  const alreadyThere = parent ? parent.author_id === cfg.selfId || me.test(fullText(parent)) : true;
  return !alreadyThere && !p.display_text_range;
}

const refOf = (p: Post, type: "replied_to" | "quoted") => p.referenced_tweets?.find((r) => r.type === type)?.id ?? null;

export async function handleMention(
  m: Post,
  page: { byId: Map<string, Post>; users: Map<string, User> },
  cfg: BotConfig,
  deps: BotDeps,
): Promise<Outcome> {
  const now = deps.now?.() ?? Date.now();
  const log = deps.log ?? (() => {});
  const users = new Map(page.users);
  const name = (p: Post | null | undefined) => (p?.author_id ? (users.get(p.author_id)?.username ?? p.author_id) : "unknown");
  const author = name(m);

  if (m.author_id === cfg.selfId) return { id: m.id, status: "ignored", reason: "her own post" };
  if (m.referenced_tweets?.some((r) => r.type === "retweeted")) return { id: m.id, status: "ignored", reason: "a repost" };
  if (!deps.state.claim(m.id, author, fullText(m), now)) return { id: m.id, status: "ignored", reason: "already handled" };

  const skip = (reason: string): Outcome => {
    deps.state.finish(m.id, "skipped", { reason });
    return { id: m.id, status: "skipped", reason };
  };
  if (cfg.allow && !cfg.allow.has(author.toLowerCase())) return skip("not on the test list");
  if (deps.state.answeredSince(now - 86_400_000) >= cfg.dailyCap) return skip("daily cap reached");
  if (deps.state.answeredForSince(author, now - 3_600_000) >= cfg.perUserHourly) return skip("this person's hourly cap reached");

  try {
    // The posts around the question: what it replies to, what it quotes, and one level further up.
    const byId = new Map(page.byId);
    const load = async (id: string | null): Promise<Post | null> => {
      if (!id) return null;
      if (byId.has(id)) return byId.get(id)!;
      const got = await deps.api.post(id);
      if (!got) return null;
      for (const [k, v] of got.byId) byId.set(k, v);
      for (const [k, v] of got.users) users.set(k, v);
      byId.set(id, got.post);
      return got.post;
    };
    const parent = await load(refOf(m, "replied_to"));
    if (!addressed(m, cfg, parent)) return skip("not talking to her (only carried along in the thread's tags)");
    const quoted = await load(refOf(m, "quoted"));
    const earlierRow = parent?.author_id === cfg.selfId ? deps.state.reply(parent.id) : undefined;
    const earlier = parent?.author_id === cfg.selfId ? { text: earlierRow?.reply_text ?? fullText(parent), token: earlierRow?.token ?? null } : null;

    let snap = deps.snapshot();
    const posts = [
      { post: m, where: "the question" },
      ...(parent && parent.author_id !== cfg.selfId ? [{ post: parent, where: "the post it replies to" }] : []),
      ...(quoted ? [{ post: quoted, where: "the quoted post" }] : []),
    ];
    let found: Found = findCoin(snap.ws, posts);
    let grandparent: Post | null = null;
    if (found.kind === "none" && earlier?.token) found = { kind: "coin", token: earlier.token, how: "address", where: "her earlier reply" };
    if (found.kind === "none" && parent && parent.author_id !== cfg.selfId) {
      grandparent = await load(refOf(parent, "replied_to"));
      if (grandparent) found = findCoin(snap.ws, [{ post: grandparent, where: "the post above that" }]);
    }
    if (found.kind === "coin" && deps.refreshCoin) {
      snap = await deps.refreshCoin(found.token).catch((err: unknown) => {
        log(`fresh data for ${found.kind === "coin" ? found.token : ""} failed, using the last read: ${(err as Error).message}`);
        return snap;
      });
    }

    const view = (p: Post | null) => (p ? { author: name(p), text: fullText(p) } : null);
    let answer: Answer;
    let cost = 0;
    try {
      ({ answer, cost } = await deps.answer(
        { question: { author, text: fullText(m) }, parent: view(parent), quoted: view(quoted), grandparent: view(grandparent), found, earlier },
        snap,
      ));
    } catch (err) {
      // A coin question still gets an answer when the model fails: DELPHI's own report, in plain words.
      if (found.kind !== "coin") throw err;
      const plain = deps.fallback?.(snap, found.token);
      if (!plain) throw err;
      log(`answering ${m.id} from the report (${(err as Error).message.slice(0, 120)})`);
      answer = { kind: "reply", text: plain.text, token: found.token, verdict: plain.verdict };
    }

    if (answer.kind === "silent") {
      deps.state.finish(m.id, "silent", { reason: answer.reason, cost });
      return { id: m.id, status: "silent", reason: answer.reason };
    }
    if (cfg.mode === "shadow") {
      deps.state.finish(m.id, "drafted", { replyText: answer.text, token: answer.token, cost });
      deps.onDraft?.({ mention: m.id, author, question: fullText(m), reply: answer.text, token: answer.token });
      return { id: m.id, status: "drafted", text: answer.text };
    }
    // From here a reply may go out, so a crash leaves "posting" and the mention is never retried.
    deps.state.posting(m.id);
    let text = answer.text;
    let replyId: string;
    try {
      try {
        replyId = await deps.api.reply(m.id, text);
      } catch (err) {
        // X refuses a post identical to one she already made (two people asking about the same coin):
        // the same facts, stamped with the read time, are a different post.
        if (!(err instanceof XError && err.status === 403 && /duplicate/i.test(err.message))) throw err;
        const t = new Date(snap.readAt).toISOString().slice(11, 16);
        text = `${answer.text}\n\nas of ${t} UTC`;
        replyId = await deps.api.reply(m.id, text);
      }
    } catch (err) {
      // A 4xx is X saying no: nothing was posted. "Too many requests" is worth another go once X opens
      // again; any other no (a deleted post, a rule) would fail the same way. A timeout, a dropped
      // connection or an X server error may still have posted it: never again.
      const retryAt = rateLimited(err, now);
      if (retryAt) {
        const reason = `X rate limit while posting: ${(err as Error).message}`.slice(0, 300);
        deps.state.retryLater(m.id, { reason, cost });
        log(`mention ${m.id}: ${reason}`);
        return { id: m.id, status: "failed", reason, retryAt };
      }
      const refused = err instanceof XError && err.status >= 400 && err.status < 500;
      const reason = `${refused ? "" : "may have been posted, not retried: "}${(err as Error).message}`.slice(0, 300);
      deps.state.finish(m.id, refused ? "failed" : "unsure", { reason, replyText: text, token: answer.token, cost });
      log(`mention ${m.id}: ${reason}`);
      return { id: m.id, status: refused ? "failed" : "unsure", reason };
    }
    deps.state.finish(m.id, "replied", { replyId, replyText: text, token: answer.token, cost });
    return { id: m.id, status: "replied", text };
  } catch (err) {
    const reason = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    // rate-limited while reading the posts around it: nothing was posted, come back when X opens again
    const retryAt = rateLimited(err, now);
    if (retryAt) {
      deps.state.retryLater(m.id, { reason });
      log(`mention ${m.id}: X rate limit, back at ${new Date(retryAt * 1000).toISOString().slice(11, 19)}`);
      return { id: m.id, status: "failed", reason, retryAt };
    }
    deps.state.finish(m.id, "failed", { reason });
    log(`mention ${m.id} failed: ${reason}`);
    return { id: m.id, status: "failed", reason };
  }
}
