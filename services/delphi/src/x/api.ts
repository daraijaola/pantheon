// The few X API v2 calls DELPHI needs, signed as @heydelph: her mentions, one post (the coin post a
// question was asked under), and her reply. Every answer is checked with zod before use; a rate limit
// says when to come back, and nothing here ever retries a post on its own.
import { z } from "zod";
import { authHeader, type OAuthCreds } from "./oauth.ts";

const API = "https://api.x.com/2";

const Url = z.object({ expanded_url: z.string().optional(), url: z.string().optional() });
const Tag = z.object({ tag: z.string() });
const Ref = z.object({ type: z.enum(["replied_to", "quoted", "retweeted"]), id: z.string() });

export const Post = z.object({
  id: z.string(),
  text: z.string(),
  author_id: z.string().optional(),
  conversation_id: z.string().optional(),
  in_reply_to_user_id: z.string().optional(),
  created_at: z.string().optional(),
  referenced_tweets: z.array(Ref).optional(),
  entities: z
    .object({ urls: z.array(Url).optional(), cashtags: z.array(Tag).optional(), mentions: z.array(z.object({ username: z.string() })).optional() })
    .optional(),
  note_tweet: z.object({ text: z.string() }).optional(),
  /** Where the person's own words start and end: leading @tags X added for a reply come before it. */
  display_text_range: z.tuple([z.number(), z.number()]).optional(),
});
export type Post = z.infer<typeof Post>;

const User = z.object({ id: z.string(), username: z.string(), name: z.string().optional() });
export type User = z.infer<typeof User>;

const Includes = z.object({ tweets: z.array(Post).optional(), users: z.array(User).optional() }).optional();

const MentionsPage = z.object({
  data: z.array(Post).optional(),
  includes: Includes,
  meta: z.object({ newest_id: z.string().optional(), result_count: z.number().optional(), next_token: z.string().optional() }).optional(),
});
const OnePost = z.object({ data: Post.optional(), includes: Includes, errors: z.array(z.unknown()).optional() });
const Created = z.object({ data: z.object({ id: z.string(), text: z.string() }) });
const Me = z.object({ data: User });

export const POST_FIELDS = "author_id,conversation_id,in_reply_to_user_id,created_at,referenced_tweets,entities,note_tweet,display_text_range";
const EXPANSIONS = "author_id,referenced_tweets.id,referenced_tweets.id.author_id";

export class XError extends Error {
  override name = "XError";
  readonly status: number;
  /** Unix seconds when a rate-limited endpoint opens again. */
  readonly resetAt: number | null;
  constructor(message: string, status: number, resetAt: number | null = null) {
    super(message);
    this.status = status;
    this.resetAt = resetAt;
  }
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export type Mentions = { posts: Post[]; byId: Map<string, Post>; users: Map<string, User>; newestId: string | null };

export class XApi {
  private readonly fetch: Fetch;
  private readonly creds: OAuthCreds;
  constructor(creds: OAuthCreds, opts: { fetch?: Fetch } = {}) {
    this.creds = creds;
    this.fetch = opts.fetch ?? globalThis.fetch;
  }

  private async call<T>(method: "GET" | "POST", url: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
    const res = await this.fetch(url, {
      method,
      signal: AbortSignal.timeout(20_000),
      headers: {
        authorization: authHeader(this.creds, method, url),
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    if (!res.ok) {
      const reset = Number(res.headers.get("x-rate-limit-reset"));
      // X's error bodies can echo request data; keep the message short and never include headers.
      throw new XError(`X ${res.status} on ${method} ${new URL(url).pathname}: ${text.slice(0, 300)}`, res.status, Number.isFinite(reset) && reset > 0 ? reset : null);
    }
    const parsed = schema.safeParse(JSON.parse(text));
    if (!parsed.success) throw new XError(`unexpected X answer on ${new URL(url).pathname}: ${parsed.error.issues[0]?.message}`, res.status);
    return parsed.data;
  }

  /** Who these keys post as (checked once at start, so a wrong key fails loudly, not silently). */
  async me(): Promise<User> {
    return (await this.call("GET", `${API}/users/me`, Me)).data;
  }

  /** Posts that mention the account, newer than `sinceId`, oldest first, with the posts they reply to or quote. */
  async mentions(userId: string, sinceId: string | null): Promise<Mentions> {
    const q = new URLSearchParams({ max_results: "100", "tweet.fields": POST_FIELDS, expansions: EXPANSIONS, "user.fields": "username" });
    if (sinceId) q.set("since_id", sinceId);
    const page = await this.call("GET", `${API}/users/${userId}/mentions?${q}`, MentionsPage);
    const byId = new Map((page.includes?.tweets ?? []).map((p) => [p.id, p]));
    const users = new Map((page.includes?.users ?? []).map((u) => [u.id, u]));
    const posts = [...(page.data ?? [])].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    return { posts, byId, users, newestId: page.meta?.newest_id ?? null };
  }

  /** One post with the posts it replies to or quotes; null if it is gone or hidden. */
  async post(id: string): Promise<{ post: Post; byId: Map<string, Post>; users: Map<string, User> } | null> {
    if (!/^\d{1,25}$/.test(id)) throw new XError(`not a post id: ${id}`, 400);
    const q = new URLSearchParams({ "tweet.fields": POST_FIELDS, expansions: EXPANSIONS, "user.fields": "username" });
    const got = await this.call("GET", `${API}/tweets/${id}?${q}`, OnePost);
    if (!got.data) return null;
    return {
      post: got.data,
      byId: new Map((got.includes?.tweets ?? []).map((p) => [p.id, p])),
      users: new Map((got.includes?.users ?? []).map((u) => [u.id, u])),
    };
  }

  /** Replies to one post. Returns the new post's id. */
  async reply(inReplyTo: string, text: string): Promise<string> {
    const made = await this.call("POST", `${API}/tweets`, Created, { text, reply: { in_reply_to_tweet_id: inReplyTo } });
    return made.data.id;
  }
}

/** The full text of a post (long posts keep it in note_tweet). */
export const fullText = (p: Post) => p.note_tweet?.text ?? p.text;
