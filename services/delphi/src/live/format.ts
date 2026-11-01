// The feed's own description, served at GET /v1/format for Kalos's developers (and anyone else): every
// endpoint, the envelope around records, and every record field with its meaning. The record's types come
// from the zod schema itself (as JSON Schema), so they can never drift; the meanings are written here, and
// a test checks that every schema field has one and that docs/kalos-adapter.md lists them all.
import { z } from "zod";
import { Dispute, DisputeSignature, FeedRecord, SIGNATURE_WINDOW_SEC } from "./types.ts";

/** The feed format version: a field's meaning never changes within it. */
export const FEED_FORMAT = 1;
/** The feed server's own version (code, not format). */
export const FEED_SERVER_VERSION = "1.0.0";

export type FieldDoc = { path: string; type: string; meaning: string };

/** Every record field, in the order a record carries them. `[]` marks the items of a list. */
export const RECORD_FIELDS: FieldDoc[] = [
  { path: "v", type: "1", meaning: "Format version. Always 1 in /v1: no field changes meaning within it." },
  { path: "chainId", type: "integer", meaning: "Elysium chain id: 99801 on testnet, 99901 on mainnet." },
  { path: "token", type: "address", meaning: "The coin's contract address, lowercase." },
  { path: "venue", type: '"perpme" | "kalos" | "ascend"', meaning: "Where DELPHI first saw the coin: a PerpMe launch, a new pool on Kalos, or an Ascend launch." },
  { path: "pool", type: "address | bytes32", meaning: "The coin's main pool: a pool address (PerpMe, Kalos) or Ascend's 32-byte pool id." },
  { path: "symbol", type: "string (max 40) | null", meaning: "The ticker the token contract reports, or null if not read yet. Set by the coin's creator: show it as plain text." },
  { path: "name", type: "string (max 40) | null", meaning: "The name the token contract reports, or null if not read yet. Set by the coin's creator: show it as plain text." },
  { path: "state", type: '"pending" | "ready" | "thin"', meaning: '"pending": just launched, checks running. "ready": checked. "thin": checked, but there is too little trading to judge much yet.' },
  { path: "verdict", type: '"FLAG" | "WATCH" | "CLEAN" | "NOT_ENOUGH_DATA" | "CHECKING"', meaning: "DELPHI's overall answer. FLAG and WATCH are findings; CLEAN means the checks ran and found nothing; NOT_ENOUGH_DATA and CHECKING are not a judgement either way." },
  { path: "checks", type: "list (max 16)", meaning: "What DELPHI found or noted, one short line each: the worst finding first, context lines (result \"info\") last." },
  { path: "checks[].code", type: "string [a-z0-9-]{2,32}", meaning: 'Stable machine code for the check, e.g. "bundle", "wash", "whales", "one-wallet", "mint-power", "sell-blocked", "fake-ticker". New codes can appear; ignore ones you do not know.' },
  { path: "checks[].result", type: '"flag" | "watch" | "ok" | "info" | "pending" | "not-enough-data"', meaning: '"flag" and "watch" are findings; "ok" says the check ran and found nothing; "info" is context, never a warning; "pending" is still running; "not-enough-data" could not judge yet.' },
  { path: "checks[].text", type: "string (max 160)", meaning: "The finding in one plain sentence, written by DELPHI." },
  { path: "checks[].evidence", type: "list of tx hashes (max 8)", meaning: "The transactions behind the finding, so anyone can check it on the explorer." },
  { path: "holders", type: "object | null", meaning: "Who holds the coin, in the shape of Kalos's holders(t). Null until read." },
  { path: "holders.count", type: "integer", meaning: "How many addresses hold any of the coin." },
  { path: "holders.top10", type: "number 0–100", meaning: "The share of the supply the 10 biggest holders hold, as a percent (not a fraction)." },
  { path: "holders.rows", type: "list (max 20)", meaning: "The biggest holders, biggest first." },
  { path: "holders.rows[].address", type: "address", meaning: "The holder's address, lowercase." },
  { path: "holders.rows[].balance", type: "integer string", meaning: "What it holds, in the token's smallest unit (a raw integer, as a decimal string)." },
  { path: "holders.rows[].share", type: "number 0–1", meaning: "What it holds as a fraction of the supply (0.05 = 5%)." },
  { path: "holders.rows[].pool", type: "boolean", meaning: "True for a liquidity pool (Kalos labels these \"Liquidity pool\")." },
  { path: "holders.rows[].dev", type: "boolean", meaning: "True for the coin's creator." },
  { path: "holders.rows[].linkedTo", type: "address | null", meaning: "The wallet DELPHI links this holder to (the creator, or the wallet that funded both), with the proof in the report; null when none." },
  { path: "dev", type: "object | null", meaning: "The creator, in the shape of Kalos's dev(t). Null until read." },
  { path: "dev.address", type: "address", meaning: "The creator's wallet." },
  { path: "dev.share", type: "number 0–1", meaning: "What the creator holds now, as a fraction of the supply." },
  { path: "dev.sold", type: "boolean", meaning: "True once the creator has sold any of the coin (Kalos's \"Sold\" tag)." },
  { path: "people", type: "object | null", meaning: "How many separate people stand behind the wallets that traded or hold the coin. Null until read." },
  { path: "people.wallets", type: "integer", meaning: "Wallets that traded or hold the coin." },
  { path: "people.people", type: "integer", meaning: "The same wallets with linked ones counted once: DELPHI's estimate of separate people." },
  { path: "fakeTickerOf", type: "object | null", meaning: "Set when the name or ticker copies a known token at another address; null otherwise." },
  { path: "fakeTickerOf.symbol", type: "string (max 40)", meaning: "The known token's ticker." },
  { path: "fakeTickerOf.address", type: "address", meaning: "The known token's real address." },
  { path: "fakeTickerOf.source", type: "string (max 40)", meaning: "Where DELPHI knows the real token from (for example a token list)." },
  { path: "launch", type: "object", meaning: "What the launch transaction says." },
  { path: "launch.tx", type: "tx hash", meaning: "The launch transaction." },
  { path: "launch.block", type: "integer string", meaning: "The block it landed in." },
  { path: "launch.timeMs", type: "integer (ms since 1970)", meaning: "When it landed." },
  { path: "launch.creator", type: "address", meaning: "Who made the coin." },
  { path: "launch.creatorBuyShare", type: "number 0–1", meaning: "The creator's own buy in the launch transaction, as a fraction of the supply." },
  { path: "rules", type: "string (max 40)", meaning: "The version of DELPHI's rules that made this record, e.g. \"delphi-v0.5\"." },
  { path: "block", type: "integer string", meaning: "The last block the checks read." },
  { path: "blockHash", type: "block hash | null", meaning: "That block's hash, or null if not recorded." },
  { path: "checkedAtMs", type: "integer (ms since 1970)", meaning: "When DELPHI made this record." },
  { path: "expiresAtMs", type: "integer (ms since 1970)", meaning: "When it should be checked again. After this the envelope says stale: true." },
  { path: "displayOnly", type: "true", meaning: "Always true: DELPHI reports patterns, not intent, and never holds or moves funds. Not a trading signal." },
  { path: "reportUrl", type: "url", meaning: "DELPHI's full report on the coin, every claim linked to its transactions." },
  { path: "disputeUrl", type: "url", meaning: "Where anyone can dispute the record (it opens pantheonindex.com/delphi/dispute?token=…)." },
];

/** The fields around records: the envelope is the server's, the record is exactly as DELPHI stored it. */
export const ENVELOPE_FIELDS: FieldDoc[] = [
  { path: "v", type: "1", meaning: "Format version of the answer." },
  { path: "servedAtMs", type: "integer (ms since 1970)", meaning: "When this server sent the answer. Not part of the ETag." },
  { path: "stale", type: "boolean", meaning: "True when servedAtMs is past the record's expiresAtMs: the record is older than DELPHI meant it to be. Show less, or nothing." },
  { path: "record", type: "FeedRecord", meaning: "The record, exactly as stored (see record fields)." },
  { path: "items", type: "list of {stale, record}", meaning: "Records with their stale flag (tokens, new)." },
  { path: "missing", type: "list of addresses", meaning: "Asked-for tokens DELPHI has no record of yet, in the order asked (tokens)." },
  { path: "next", type: "integer string | null", meaning: "Pass as before= for the next (older) page; null on the last page (new)." },
  { path: "error", type: "string", meaning: "Why a request failed (any 4xx or 5xx): a short code such as \"bad-address\", \"unknown\", \"too-many\", \"rate-limited\"." },
];

export const ERRORS: Record<string, string> = {
  "bad-address": "An address is not 0x and 40 hex characters (400). In tokens, `index` says which one (0-based).",
  "bad-ids": "tokens needs ids=a,b,c (400).",
  "too-many": "More than 50 ids in one call (400).",
  "bad-venue": 'venue must be "perpme", "kalos" or "ascend" (400).',
  "bad-limit": "limit must be a whole number from 1 to 100 (400).",
  "bad-before": "before must be a block number (400).",
  "bad-json": "The body is not JSON (400).",
  "bad-dispute": "The dispute breaks the format; `fields` names the bad ones (400). A signed dispute needs all of wallet, signedAt and signature.",
  "stale-signature": "A signed dispute's signedAt is more than 10 minutes from DELPHI's clock (400): sign it again.",
  "bad-signature": "The signature is not the wallet's signature of this dispute's message (400). Nothing was stored.",
  unknown: "DELPHI has no record of this token (404). `token` is the address asked for, lowercase.",
  "not-found": "No such endpoint (404).",
  "method-not-allowed": "Wrong method for this endpoint; see the Allow header (405).",
  "too-large": "The body is over 4 KB (413).",
  "url-too-long": "The URL is over 4 KB (414).",
  "bad-content-type": "POST bodies must be Content-Type: application/json (415).",
  "rate-limited": "Too many requests from one address; wait Retry-After seconds (429).",
  "bad-request": "The HTTP request itself was malformed (400), or its headers were too large (431) or too slow (408).",
  internal: "Something failed on DELPHI's side (500). Show nothing, never \"clean\".",
};

export const ENDPOINTS = [
  { method: "GET", path: "/v1/token/{address}", returns: "{v, stale, record, servedAtMs} or 404 {v, error:\"unknown\", token}" },
  { method: "GET", path: "/v1/tokens?ids=a,b,c", returns: "{v, items:[{stale, record}], missing:[address], servedAtMs}. Up to 50 ids, answered in the order asked, repeats once." },
  { method: "GET", path: "/v1/new?venue=perpme|kalos|ascend&limit=50&before={block}", returns: "{v, venue, items:[{stale, record}], next, servedAtMs}. Newest launches first; venue optional; limit 1–100 (default 50)." },
  { method: "GET", path: "/v1/history/{address}", returns: "{v, token, items:[{atMs, verdict, rules, why}], servedAtMs}. Every verdict the coin has had, oldest first: DELPHI's public record." },
  { method: "GET", path: "/v1/health", returns: "{v, ok, version, newestUpdateMs, servedAtMs}. Never cached." },
  { method: "GET", path: "/v1/format", returns: "This description." },
  {
    method: "POST",
    path: "/v1/dispute",
    returns:
      "Body {token, contact, message} as application/json (max 4 KB) → 201 {v, ok:true, id, status:\"open\"}. A person answers every dispute. " +
      "Optionally signed by the wallet a finding names: add {wallet, signedAt, signature}, an EIP-191 (personal_sign) signature over signedDispute.message, made within 10 minutes → 201 {..., signed:true}. The wallet is never published.",
  },
];

/** The description served at /v1/format, built once. */
export function formatDescription(limits: { maxIds: number; maxNew: number; maxBodyBytes: number; getPerSecond: number; getBurst: number; postPerHour: number; cacheSeconds: number }) {
  return {
    v: FEED_FORMAT,
    name: "DELPHI feed",
    version: FEED_SERVER_VERSION,
    about:
      "DELPHI's read-only checks on new Elysium coins. Display only: patterns, not intent. Open to anyone (CORS *, no key). Within v1 fields are only ever added, never changed; a breaking change becomes /v2.",
    baseUrl: "https://pantheonindex.com/api/delphi/v1",
    endpoints: ENDPOINTS,
    envelope: ENVELOPE_FIELDS,
    record: RECORD_FIELDS,
    errors: ERRORS,
    limits: {
      idsPerCall: limits.maxIds,
      newPerCall: limits.maxNew,
      disputeBodyBytes: limits.maxBodyBytes,
      getPerSecondPerIp: limits.getPerSecond,
      getBurstPerIp: limits.getBurst,
      disputesPerHourPerIp: limits.postPerHour,
    },
    caching: `Answers carry Cache-Control: public, max-age=${limits.cacheSeconds} and a weak ETag; send If-None-Match to get 304 Not Modified. /v1/health and errors are never cached.`,
    rules: [
      "If DELPHI is down, slow or answers something unexpected, show nothing: never \"clean\".",
      "Show nothing for a record with stale: true, or keep only its facts with the time they were read.",
      "symbol and name come from the coin's creator: render them as text, never as HTML.",
      "Every flag links to its evidence and can be disputed at disputeUrl.",
    ],
    signedDispute: {
      message: "PANTHEON dispute\ncoin: {token, lowercase}\nmessage sha256: {sha256 of the message's UTF-8 bytes, 64 lowercase hex}\nsigned at: {signedAt, unix seconds}",
      signedAtWindowSec: SIGNATURE_WINDOW_SEC,
      about: "Ties a dispute to the wallet a finding names. The signature is checked and the wallet kept for the person who answers; the answer says only signed:true.",
    },
    schema: { record: z.toJSONSchema(FeedRecord), dispute: z.toJSONSchema(Dispute), disputeSignature: z.toJSONSchema(DisputeSignature) },
  };
}
