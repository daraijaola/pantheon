# DELPHI feed v1: for Kalos's Sniper

DELPHI checks every new coin on Elysium (PerpMe launches, new Kalos pools and Ascend launches) and keeps one short record for each one: who holds it, what the creator did, and what looks wrong, with the transactions behind every claim. This feed serves those records to any app, which shows them in its own design.

- **Base URL:** `https://pantheonindex.com/api/delphi/v1`
- **Open:** CORS `*`, no key, JSON only.
- **Fast:** answers come from a local database, with no chain reads during a call. The server prepares a batch of 50 in about half a millisecond.
- **Strict:** within `v1`, fields are only ever added, never changed or removed. A breaking change becomes `/v2`, with overlap. Every answer and every record carries `v: 1`.
- **Display only:** DELPHI reports patterns, not intent. It never holds or moves funds. If DELPHI is down, slow, or answers something you don't expect, **show nothing, never "clean"**.

The same description, machine-readable (every endpoint, every field and the JSON Schema), is at `GET /v1/format`.

## Endpoints

| Call | Answer |
|---|---|
| `GET /v1/tokens?ids=a,b,c` | Up to 50 tokens: `{v, items:[{stale, record}], missing:[address], servedAtMs}`. Items come in the order asked (a repeat is answered once). Tokens DELPHI hasn't seen yet are listed in `missing`. |
| `GET /v1/token/{address}` | One token: `{v, stale, record, servedAtMs}`, or 404 `{v, error:"unknown", token}`. |
| `GET /v1/new?venue=perpme&limit=50&before={block}` | The newest launches first: `{v, venue, items:[{stale, record}], next, servedAtMs}`. `venue` is optional (`perpme`, `kalos` or `ascend`); `limit` is 1 to 100 (default 50). Pass `next` back as `before` for the next page. |
| `GET /v1/history/{address}` | Every verdict the coin has had, oldest first, with the reason it changed: `{v, token, items:[{atMs, verdict, rules, why}], servedAtMs}`. This is DELPHI's public record. |
| `GET /v1/health` | `{v, ok, version, newestUpdateMs, newestUpdateAgeMs, recordCount, empty, stale, servedAtMs}`. Never cached. |
| `GET /v1/format` | The machine-readable description. |
| `POST /v1/dispute` | A dispute about a record (see the end). |

Addresses can be sent in any case; answers are always lowercase.

### Publishing scanner reports

`npm run feed:publish` validates the canonical `OUT_DIR/scan.json` (default
`out/scan.json`) and writes records through `FeedStore.put()` into `FEED_DB`
(default `data/feed.db`). `FEED_SITE_URL` optionally sets report/dispute link
origin; the default is `https://pantheonindex.com`. No RPC calls are made.
Network and head come from scan metadata, not browser input. Unlisted old
per-coin files are never imported. Missing/malformed reports are skipped, never
treated as CLEAN; skipped reports make the command exit nonzero. Invalid scan
metadata or unreadable input fails the command. Previous records are retained
and expire normally; publishing does not delete disputes or history.

`npm run refresh` runs scan, then explain, then publish, stopping on any failure.
The deployed `delphi-refresh.service` is not tracked in this repository. Its
operator must replace its existing scan/explain ExecStart with:

```ini
WorkingDirectory=/srv/hackathon/pantheon/services/delphi
ExecStart=/usr/bin/npm run refresh
Environment=FEED_DB=/srv/hackathon/pantheon/services/delphi/data/feed.db
```

This is a deployment instruction only; no unit is changed by these scripts.
The producer and feed server must use the same FEED_DB. The scanner's RPC access
problem must be fixed separately before this refresh can succeed.

Publication preserves each report's generatedAt as checkedAtMs, with expiry
15 hours later (the twice-daily schedule plus three hours of grace). Re-running
old reports does not make them fresh. Unchanged records are skipped; older
reports cannot replace newer records. The initial verdict is recorded once;
later history entries are added only when the verdict actually changes.

The adapter publishes only what the behavioral report contains. Holder rows,
dev balances/sales, people counts, block hash and impersonation data remain
null, not fabricated. The v1 launch creatorBuyShare is required numeric; this
adapter uses the launch-ingestion convention of zero for unknown, accompanied
by a `creator-buy` / `not-enough-data` check. Do not display that placeholder as
a measured zero. Behavioral verdicts do not incorporate the separate safety
report's honeypot/contract checks. Follow reportUrl for the full report.

Health preserves `ok` and HTTP 200 for a readable database, including an empty
or stale one. `recordCount` is the stored row count, `empty` means no rows, and
`stale` means empty or the newest checked record is past its expiresAtMs.
`newestUpdateAgeMs` is its nonnegative age, or null for an empty database.
On database errors HTTP 503 / ok:false is retained; count/empty are null and
stale is true. Consumers must check freshness as well as availability, and
still honor each item's individual stale flag.

## The adapter

The Sniper's `ctx.sniperInsights` calls `holders(t)` and `dev(t)` while it paints, so it has to answer from memory. This adapter fetches the rows on screen in one call (on the Sniper's 5 s rhythm), keeps the fresh answers, and tells the Sniper when new data arrives. `record.holders` and `record.dev` already have the Sniper's shapes and units: `share` is a fraction from 0 to 1, and `top10` is a percent.

```js
// DELPHI → Sniper insights: one batch call for the rows on screen; holders(t) and dev(t) answer from memory.
export function delphiInsights(ctx, base = "https://pantheonindex.com/api/delphi/v1") {
  const cache = new Map(); // token → record, only while fresh
  const key = (t) => String(t?.address ?? t).toLowerCase();
  const fresh = (t) => { const r = cache.get(key(t)); return r && r.expiresAtMs > Date.now() ? r : null; };
  async function refresh(tokens) { // every 5 s, with the (up to 50) tokens on screen
    const ids = [...new Set(tokens.map(key))].slice(0, 50);
    if (!ids.length) return;
    try {
      const res = await fetch(`${base}/tokens?ids=${ids.join(",")}`, { signal: AbortSignal.timeout(4000) });
      const body = res.ok ? await res.json() : null;
      if (body?.v !== 1 || !Array.isArray(body.items)) return; // not v1: show nothing new
      for (const { stale, record } of body.items) if (stale) cache.delete(record.token); else cache.set(record.token, record);
      for (const t of body.missing ?? []) cache.delete(t);
      ctx.emit("sniper-insights");
    } catch { /* DELPHI down or slow: old answers expire on their own; never show "clean" */ }
  }
  return { refresh, holders: (t) => fresh(t)?.holders ?? null, dev: (t) => fresh(t)?.dev ?? null };
}
```

Notes:
- `holders(t)` gives `{count, top10, rows:[{address, balance, share, pool, dev, linkedTo}]}`. The Sniper's other row fields (`value`, `entry`, `pnl`, `pnlPct`, `heldMs`, `you`) depend on prices and on who is looking, so Kalos fills those in.
- `null` means "nothing to show yet". A brand-new coin is in `missing` for its first seconds, then comes back with `state: "pending"` and `verdict: "CHECKING"`.
- The same cached record has everything for a Checks box: `verdict`, `checks`, `people`, `fakeTickerOf`, `reportUrl` and `disputeUrl`.

## The envelope

The server wraps each record. It never changes the record's own fields.

| Field | Type | Meaning |
|---|---|---|
| `v` | 1 | Format version of the answer. |
| `servedAtMs` | integer (ms since 1970) | When this server sent the answer. Not part of the ETag. |
| `stale` | boolean | True when servedAtMs is past the record's expiresAtMs: the record is older than DELPHI meant it to be. Show less, or nothing. |
| `record` | FeedRecord | The record, exactly as stored (see record fields). |
| `items` | list of {stale, record} | Records with their stale flag (tokens, new). |
| `missing` | list of addresses | Asked-for tokens DELPHI has no record of yet, in the order asked (tokens). |
| `next` | integer string \| null | Pass as before= for the next (older) page; null on the last page (new). |
| `error` | string | Why a request failed (any 4xx or 5xx): a short code such as "bad-address", "unknown", "too-many", "rate-limited". |

`stale` is recomputed on every answer (`servedAtMs > record.expiresAtMs`). The record's own `expiresAtMs` is left as DELPHI stored it.

## Record fields

| Field | Type | Meaning |
|---|---|---|
| `v` | 1 | Format version. Always 1 in /v1: no field changes meaning within it. |
| `chainId` | integer | Elysium chain id: 99801 on testnet, 99901 on mainnet. |
| `token` | address | The coin's contract address, lowercase. |
| `venue` | "perpme" \| "kalos" \| "ascend" | Where DELPHI first saw the coin: a PerpMe launch, a new pool on Kalos, or an Ascend launch. |
| `pool` | address \| bytes32 | The coin's main pool: a pool address (PerpMe, Kalos) or Ascend's 32-byte pool id. |
| `symbol` | string (max 40) \| null | The ticker the token contract reports, or null if not read yet. Set by the coin's creator: show it as plain text. |
| `name` | string (max 40) \| null | The name the token contract reports, or null if not read yet. Set by the coin's creator: show it as plain text. |
| `state` | "pending" \| "ready" \| "thin" | "pending": just launched, checks running. "ready": checked. "thin": checked, but there is too little trading to judge much yet. |
| `verdict` | "FLAG" \| "WATCH" \| "CLEAN" \| "NOT_ENOUGH_DATA" \| "CHECKING" | DELPHI's overall answer. FLAG and WATCH are findings; CLEAN means the checks ran and found nothing; NOT_ENOUGH_DATA and CHECKING are not a judgement either way. |
| `checks` | list (max 16) | What DELPHI found or noted, one short line each: the worst finding first, context lines (result "info") last. |
| `checks[].code` | string [a-z0-9-]{2,32} | Stable machine code for the check, e.g. "bundle", "wash", "whales", "one-wallet", "mint-power", "sell-blocked", "fake-ticker". New codes can appear; ignore ones you do not know. |
| `checks[].result` | "flag" \| "watch" \| "ok" \| "info" \| "pending" \| "not-enough-data" | "flag" and "watch" are findings; "ok" says the check ran and found nothing; "info" is context, never a warning; "pending" is still running; "not-enough-data" could not judge yet. |
| `checks[].text` | string (max 160) | The finding in one plain sentence, written by DELPHI. |
| `checks[].evidence` | list of tx hashes (max 8) | The transactions behind the finding, so anyone can check it on the explorer. |
| `holders` | object \| null | Who holds the coin, in the shape of Kalos's holders(t). Null until read. |
| `holders.count` | integer | How many addresses hold any of the coin. |
| `holders.top10` | number 0–100 | The share of the supply the 10 biggest holders hold, as a percent (not a fraction). |
| `holders.rows` | list (max 20) | The biggest holders, biggest first. |
| `holders.rows[].address` | address | The holder's address, lowercase. |
| `holders.rows[].balance` | integer string | What it holds, in the token's smallest unit (a raw integer, as a decimal string). |
| `holders.rows[].share` | number 0–1 | What it holds as a fraction of the supply (0.05 = 5%). |
| `holders.rows[].pool` | boolean | True for a liquidity pool (Kalos labels these "Liquidity pool"). |
| `holders.rows[].dev` | boolean | True for the coin's creator. |
| `holders.rows[].linkedTo` | address \| null | The wallet DELPHI links this holder to (the creator, or the wallet that funded both), with the proof in the report; null when none. |
| `dev` | object \| null | The creator, in the shape of Kalos's dev(t). Null until read. |
| `dev.address` | address | The creator's wallet. |
| `dev.share` | number 0–1 | What the creator holds now, as a fraction of the supply. |
| `dev.sold` | boolean | True once the creator has sold any of the coin (Kalos's "Sold" tag). |
| `people` | object \| null | How many separate people stand behind the wallets that traded or hold the coin. Null until read. |
| `people.wallets` | integer | Wallets that traded or hold the coin. |
| `people.people` | integer | The same wallets with linked ones counted once: DELPHI's estimate of separate people. |
| `fakeTickerOf` | object \| null | Set when the name or ticker copies a known token at another address; null otherwise. |
| `fakeTickerOf.symbol` | string (max 40) | The known token's ticker. |
| `fakeTickerOf.address` | address | The known token's real address. |
| `fakeTickerOf.source` | string (max 40) | Where DELPHI knows the real token from (for example a token list). |
| `launch` | object | What the launch transaction says. |
| `launch.tx` | tx hash | The launch transaction. |
| `launch.block` | integer string | The block it landed in. |
| `launch.timeMs` | integer (ms since 1970) | When it landed. |
| `launch.creator` | address | Who made the coin. |
| `launch.creatorBuyShare` | number 0–1 | The creator's own buy in the launch transaction, as a fraction of the supply. |
| `rules` | string (max 40) | The version of DELPHI's rules that made this record, e.g. "delphi-v0.5". |
| `block` | integer string | The last block the checks read. |
| `blockHash` | block hash \| null | That block's hash, or null if not recorded. |
| `checkedAtMs` | integer (ms since 1970) | When DELPHI made this record. |
| `expiresAtMs` | integer (ms since 1970) | When it should be checked again. After this the envelope says stale: true. |
| `displayOnly` | true | Always true: DELPHI reports patterns, not intent, and never holds or moves funds. Not a trading signal. |
| `reportUrl` | url | DELPHI's full report on the coin, every claim linked to its transactions. |
| `disputeUrl` | url | Where anyone can dispute the record (it opens pantheonindex.com/delphi/dispute?token=…). |

## Errors

Every error is `{v: 1, error: "<code>"}` with a 4xx or 5xx status, sometimes with one more field, never with a stack trace or your input echoed back. Errors are never cached.

| error | Meaning |
|---|---|
| `bad-address` | An address is not 0x and 40 hex characters (400). In tokens, `index` says which one (0-based). |
| `bad-ids` | tokens needs ids=a,b,c (400). |
| `too-many` | More than 50 ids in one call (400). |
| `bad-venue` | venue must be "perpme", "kalos" or "ascend" (400). |
| `bad-limit` | limit must be a whole number from 1 to 100 (400). |
| `bad-before` | before must be a block number (400). |
| `bad-json` | The body is not JSON (400). |
| `bad-dispute` | The dispute breaks the format; `fields` names the bad ones (400). |
| `unknown` | DELPHI has no record of this token (404). `token` is the address asked for, lowercase. |
| `not-found` | No such endpoint (404). |
| `method-not-allowed` | Wrong method for this endpoint; see the Allow header (405). |
| `too-large` | The body is over 4 KB (413). |
| `url-too-long` | The URL is over 4 KB (414). |
| `bad-content-type` | POST bodies must be Content-Type: application/json (415). |
| `rate-limited` | Too many requests from one address; wait Retry-After seconds (429). |
| `bad-request` | The HTTP request itself was malformed (400), or its headers were too large (431) or too slow (408). |
| `internal` | Something failed on DELPHI's side (500). Show nothing, never "clean". |

## Caching and limits

- Answers carry `Cache-Control: public, max-age=5` and a weak `ETag`. Send `If-None-Match` and an unchanged answer comes back as `304 Not Modified` with no body. `servedAtMs` is not part of the ETag.
- Per address: 20 reads a second, with bursts of 40. Over that the answer is `429` with `Retry-After`. Calling from each viewer's browser (one batch every 5 s) stays far below it. A Kalos server proxying for everyone should cache, or ask us to raise its limit.
- At most 50 ids per call, URLs up to 4 KB, and dispute bodies up to 4 KB. Slow or oversized requests are cut off.

## Disputes (for the page at pantheonindex.com/delphi/dispute)

Every record's `disputeUrl` opens `https://pantheonindex.com/delphi/dispute?token=0x…`. That page sends:

```http
POST /api/delphi/v1/dispute
Content-Type: application/json

{"token": "0x…", "contact": "@handle or email (max 120)", "message": "what is wrong, and why (max 1,200)"}
```

| Status | Body | Show |
|---|---|---|
| 201 | `{v:1, ok:true, id, status:"open"}` | "Thanks: a person will answer. Dispute #id." |
| 400 | `{v:1, error:"bad-dispute", fields:["message"]}` | Mark the named fields. An empty message, or one with control characters, counts as bad. |
| 400 | `{v:1, error:"bad-json"}` | A bug in the page. |
| 404 | `{v:1, error:"unknown", token}` | "DELPHI has no record of this coin." |
| 413 / 415 | `too-large` / `bad-content-type` | A bug in the page (send JSON, under 4 KB). |
| 429 | `{v:1, error:"rate-limited"}` + `Retry-After` | "Too many disputes from here; try again in an hour." (5 an hour per address.) |

The message is stored as plain text and is never shown back in an answer, so the page must not echo it as HTML either.

### Signed by the wallet (optional)

A dispute can be tied to the wallet a finding names: the wallet signs a fixed, plain message (EIP-191 `personal_sign`), and the body carries three more fields. The unsigned form above keeps working exactly as it is.

```http
POST /api/delphi/v1/dispute
Content-Type: application/json

{"token": "0x…", "contact": "…", "message": "…", "wallet": "0x…", "signedAt": 1793750400, "signature": "0x…"}
```

The message to sign, four lines joined by `\n`, with no line break at the end:

```text
PANTHEON dispute
coin: <token, lowercase>
message sha256: <sha256 of the message's UTF-8 bytes, 64 lowercase hex characters>
signed at: <signedAt, unix seconds>
```

With viem: `walletClient.signMessage({ account, message })`, after `sha256(stringToBytes(message)).slice(2)` for the third line. `signedAt` must be within 10 minutes of DELPHI's clock, either way. Plain wallets are checked with no chain read; smart wallets (ERC-1271, or ERC-6492 before they are deployed) when the feed runs with `DISPUTE_RPC` set.

| Status | Body | Show |
|---|---|---|
| 201 | `{v:1, ok:true, id, status:"open", signed:true}` | "Thanks: a person will answer. Signed by your wallet." The wallet is kept for the person who answers and never published. |
| 400 | `{v:1, error:"bad-dispute", fields:["signature"]}` | A field of the signed form is missing or malformed: all three of `wallet`, `signedAt` and `signature` are needed. |
| 400 | `{v:1, error:"stale-signature"}` | "That signature is too old: sign again." |
| 400 | `{v:1, error:"bad-signature"}` | "That signature isn't this wallet's, for this message: sign again." Nothing is stored. |
