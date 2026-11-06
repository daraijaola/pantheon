# DELPHI × Kalos — display-only checks for every coin on screen

DELPHI reads on-chain activity to identify bundled launches, wash trading and hidden concentration.
Each verdict links to its evidence; DELPHI never holds funds, signs trades or decides whether a user may trade.

**Integration draft · verified locally on 2026-11-06.** Base URL:
`https://pantheonindex.com/api/delphi/v1`. No API key or wallet session is needed.
Confirm deployment and fresh data before launch: the examples below are genuine, **stale**
Nov 4 reports served from a local published database, not proof that the public deployment is ready.
The [technical reference](kalos-adapter.md) contains the full schema, errors and dispute-signing format.

## 1. One identity, three reads

Join by **chain ID + lowercase token contract**, never ticker or display name. Check
`record.chainId` against the displayed market. A pool address is not the token ID;
one token can trade in multiple pools. These examples belong to **testnet 99801**.

| Surface | Request | Integration |
| --- | --- | --- |
| Coins already on screen | `GET /v1/tokens?ids=address,address` | One batch, at most **50 input IDs**, not one request per row. Replies contain `items` and `missing`. Repeats are deduplicated, addresses normalized. |
| New-launch discovery | `GET /v1/new?venue=perpme&limit=50` | Newest launch blocks first; pass `next` as `before`. `venue` accepts `perpme`, `kalos`, `ascend`; omit it for all venues. Limits: 1–100, default 50. |
| Selected coin | `GET /v1/token/{address}` | The same item plus envelope metadata; an unseen token returns HTTP 404 with `error: "unknown"`. |

Kalos's Sniper supports **PerpMe as well as Kalos pools**. `venue=kalos` does not mean
“everything visible in Kalos.” Prefer the batch read to annotate Kalos's existing list;
DELPHI discovery is an optional launch list, not a replacement for Kalos's market ranking,
liquidity, tradability or live prices. The current scanner excludes base currencies and may not
have every token Kalos shows. Missing means **not checked**, not clean.

### Recorded request/response examples

Prefix each path with the base URL above (which already ends in `/v1`; do not duplicate it).
Requests were exercised against `http://127.0.0.1:13212/v1` backed by the 502-record
published Nov 4 snapshot (`head: 22738575`, `generatedAt: 2026-11-04T00:23:23.405Z`).
Responses below retain actual values but omit unused record fields; they are **projections,
not complete schemas**. Full items also include checks, launch metadata, links and nullable metrics.

**Batch: two coins on screen**

```http
GET /tokens?ids=0x97951493e8839d2afa7730ef3ba73437615c7705,0x0b56c35d8ca0d323f1f871a7e6ea1b607c1f0e4c
```

```json
{"v":1,"items":[{"stale":true,"record":{"v":1,"chainId":99801,"token":"0x97951493e8839d2afa7730ef3ba73437615c7705","venue":"kalos","symbol":"KPIX","state":"ready","verdict":"WATCH","checkedAtMs":1793751803405,"expiresAtMs":1793805803405,"reportUrl":"https://pantheonindex.com/delphi/0x97951493e8839d2afa7730ef3ba73437615c7705","displayOnly":true}},{"stale":true,"record":{"v":1,"chainId":99801,"token":"0x0b56c35d8ca0d323f1f871a7e6ea1b607c1f0e4c","venue":"perpme","symbol":"HDRCHK","verdict":"NOT_ENOUGH_DATA"}}],"missing":[],"servedAtMs":1793988859016}
```

**Discovery: newest PerpMe launch**

```http
GET /new?venue=perpme&limit=1
```

```json
{"v":1,"venue":"perpme","items":[{"stale":true,"record":{"v":1,"chainId":99801,"token":"0xf4fbef791d6713b22b33d8c1498c0776b01d0999","venue":"perpme","symbol":"COLI","state":"thin","verdict":"NOT_ENOUGH_DATA","checkedAtMs":1793751803405,"expiresAtMs":1793805803405}}],"next":"22301460","servedAtMs":1793988859105}
```

Next page: `/new?venue=perpme&limit=1&before=22301460`.

**Detail: selected KPIX**

```http
GET /token/0x97951493e8839d2afa7730ef3ba73437615c7705
```

```json
{"v":1,"stale":true,"record":{"v":1,"chainId":99801,"token":"0x97951493e8839d2afa7730ef3ba73437615c7705","venue":"kalos","symbol":"KPIX","state":"ready","verdict":"WATCH","reportUrl":"https://pantheonindex.com/delphi/0x97951493e8839d2afa7730ef3ba73437615c7705","disputeUrl":"https://pantheonindex.com/delphi/dispute?token=0x97951493e8839d2afa7730ef3ba73437615c7705"},"servedAtMs":1793988859170}
```

All three examples should display **Out of date**, not a current verdict badge.

## 2. Badge rules: evidence, not an endorsement

Apply freshness and identity checks **before** the verdict mapping:

| Condition | Suggested label |
| --- | --- |
| Missing, wrong chain, failed request or invalid response | Not checked / unavailable; never a green badge |
| `stale: true` **or** now exceeds `expiresAtMs` | Out of date; never CLEAN, even if the stored verdict is CLEAN |
| `state: "pending"` or `verdict: "CHECKING"` | Checking |
| Fresh `FLAG` | Flagged |
| Fresh `WATCH` | Watch |
| Fresh `CLEAN` | Checks clear |
| Fresh `NOT_ENOUGH_DATA` | Not enough data |

“Checks clear” means no flagged **behavioral** patterns in the available data, not “safe,”
audited or guaranteed sellable. The behavioral verdict does **not** incorporate the separate
contract/honeypot safety report. Do not infer a balance, holder count or creator buy from absent
metrics; the adapter's numeric `creatorBuyShare=0` is explicitly an unknown placeholder.

Link the badge's **“checked by DELPHI”** attribution to `record.reportUrl`. Offer a nearby
“Dispute this check” link using `record.disputeUrl`. That page collects an explanation/contact;
the optional API form is `POST /v1/dispute` with `token`, `contact` (≤120 characters),
`message` (≤1,200), JSON body ≤4,096 bytes. A valid submission returns 201 with an open dispute
ID; it does not automatically change the verdict. Unsigned disputes are supported; optional
wallet signatures and moderation/history are described in the technical reference.

## 3. Polling, caching and failure handling

- Poll **one batch of visible IDs every five seconds** while the view is active; stop when
  unmounted/hidden. Chunk larger views into ≤50 IDs, deduplicate and avoid overlapping requests.
- Successful data responses have `Cache-Control: public, max-age=5` and a weak `ETag`.
  Browser `cache: "default"` uses normal HTTP caching. If managing a cache yourself, send
  `If-None-Match`; HTTP **304 has no JSON body**, so retain the prior payload. `servedAtMs`
  is excluded from the ETag. Recheck expiry locally even while retaining cached data.
- CORS is `*`; `ETag` and `Retry-After` are exposed. OPTIONS allows `GET, HEAD, POST, OPTIONS`
  and `Content-Type, If-None-Match`. No cookies/credentials are needed.
- Default read budget: **20 requests/second, burst 40 per client address** (IPv6 grouped by /64),
  shared by GET/HEAD/OPTIONS. HTTP 429 includes `Retry-After` seconds: wait at least that long.
  Proxying all viewers through one server aggregates their budget: cache/coalesce requests.
- Other failures: clear current all-clear state and retry with backoff. `/v1/health` is `no-store`;
  `ok: true` means DB-readable, **not** fresh. `empty`/`stale` expose producer freshness.
- These are feed-server defaults verified locally, not a guarantee of proxy/CDN settings or
  a throughput SLA. Confirm edge CORS/cache headers before production. Disputes have separate
  defaults: five/hour per address (burst five), 100/hour globally (burst 100).

## 4. Drop-in TypeScript / React

React is optional: the wire protocol is framework-neutral. This client-only example uses React
and browser APIs only, no wallet or trading dependency. Use one hook per visible page; pass each
row's item to `DelphiBadge`. It validates the fields it uses, hides expired all-clears without
waiting for another poll, and clears previous-page/error results. The types below are a checked
projection of `src/live/types.ts`'s `FeedRecord`, not a replacement for the complete schema.

```tsx
"use client";
import { useEffect, useState } from "react";

type Verdict = "FLAG" | "WATCH" | "CLEAN" | "NOT_ENOUGH_DATA" | "CHECKING";
export type BadgeRecord = {
  v: 1; displayOnly: true; chainId: number; token: string;
  state: "pending" | "ready" | "thin"; verdict: Verdict;
  checkedAtMs: number; expiresAtMs: number; reportUrl: string;
};
export type Item = { stale: boolean; record: BadgeRecord };
export type Batch = { v: 1; items: Item[]; missing: string[]; servedAtMs: number };
const BASE = "https://pantheonindex.com/api/delphi/v1";
const ADDRESS = /^0x[0-9a-f]{40}$/;
const labels: Record<Verdict, string> = {
  FLAG: "Flagged", WATCH: "Watch", CLEAN: "Checks clear",
  NOT_ENOUGH_DATA: "Not enough data", CHECKING: "Checking",
};
const object = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object";
function isItem(x: unknown): x is Item {
  if (!object(x) || typeof x.stale !== "boolean" || !object(x.record)) return false;
  const r = x.record;
  return r.v === 1 && r.displayOnly === true && Number.isSafeInteger(r.chainId)
    && typeof r.token === "string" && ADDRESS.test(r.token)
    && typeof r.verdict === "string" && Object.hasOwn(labels, r.verdict)
    && (r.state === "pending" || r.state === "ready" || r.state === "thin")
    && typeof r.checkedAtMs === "number" && Number.isSafeInteger(r.checkedAtMs)
    && typeof r.expiresAtMs === "number" && Number.isSafeInteger(r.expiresAtMs)
    && r.expiresAtMs >= r.checkedAtMs
    && r.reportUrl === `https://pantheonindex.com/delphi/${r.token}`;
}
function parseBatch(x: unknown): Batch {
  if (!object(x) || x.v !== 1 || typeof x.servedAtMs !== "number"
    || !Number.isSafeInteger(x.servedAtMs) || !Array.isArray(x.items) || !x.items.every(isItem)
    || !Array.isArray(x.missing) || !x.missing.every((a): a is string => typeof a === "string" && ADDRESS.test(a))) {
    throw new Error("Unexpected DELPHI response");
  }
  return { v: 1, items: x.items, missing: x.missing, servedAtMs: x.servedAtMs };
}
export function useDelphi(tokens: readonly string[]) {
  const key = [...new Set(tokens.map(a => a.toLowerCase()))].sort().join(",");
  const [result, setResult] = useState<{ key: string; data: Batch } | null>(null);
  useEffect(() => {
    const ids = key ? key.split(",") : [];
    if (!ids.length || ids.length > 50 || ids.some(a => !ADDRESS.test(a))) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = 5000;
    async function poll() {
      if (document.hidden) { timer = setTimeout(poll, delay); return; }
      try {
        const response = await fetch(`${BASE}/tokens?${new URLSearchParams({ ids: key })}`, {
          credentials: "omit", cache: "default",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
        });
        if (response.status === 429) {
          const seconds = Number(response.headers.get("Retry-After"));
          delay = Number.isFinite(seconds) && seconds > 0 ? Math.max(5000, seconds * 1000) : 10000;
          throw new Error("Rate limited");
        }
        if (!response.ok) throw new Error(`DELPHI HTTP ${response.status}`);
        const data = parseBatch(await response.json());
        if (!controller.signal.aborted) setResult({ key, data });
        delay = 5000;
      } catch {
        if (!controller.signal.aborted) setResult(null);
        if (delay === 5000) delay = 10000;
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(poll, delay);
      }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [key]);
  return result?.key === key ? result.data : null;
}
export function DelphiBadge({ item, chainId }: { item?: Item; chainId: number }) {
  const expires = item?.record.expiresAtMs;
  const [expired, setExpired] = useState(true);
  useEffect(() => {
    if (expires === undefined) return;
    const delay = expires - Date.now() + 1;
    setExpired(delay <= 0);
    const timer = setTimeout(() => setExpired(true), Math.max(0, Math.min(delay, 2147483647)));
    return () => clearTimeout(timer);
  }, [expires]);
  if (!item || item.record.chainId !== chainId) return <span>Not checked</span>;
  const r = item.record;
  const stale = item.stale || expired || Date.now() > r.expiresAtMs;
  const checking = r.state === "pending" || r.verdict === "CHECKING";
  const label = stale ? "Out of date" : checking ? "Checking" : labels[r.verdict];
  return <a href={r.reportUrl} target="_blank" rel="noopener noreferrer"
    data-delphi={stale ? "stale" : checking ? "checking" : r.verdict.toLowerCase()}>
    {label} · checked by DELPHI
  </a>;
}
```

Usage in an existing row: `const batch = useDelphi(visibleTokenAddresses);` then
`<DelphiBadge chainId={marketChainId} item={batch?.items.find(i => i.record.token === tokenAddress.toLowerCase())} />`.
Keep the browser clock accurate. For non-browser clients, implement equivalent expiry checks and
304 caching explicitly. This snippet needs modern `AbortSignal.any` / `timeout` support (or a polyfill).

## 5. Kalos fit and launch checklist — official sources only

Research checked 2026-11-06; public assets/configuration can change:

- **Identifiers / listing:** the [official Sniper data module](https://kalos.fun/kalos-sniper-data.min.js)
  exports `SNIPER_CHAIN=99801`, normalizes `row.token.address` and `row.pool.address`, and
  merges Kalos/PerpMe discovery rows, deduplicating by token address. The
  [Sniper UI module](https://kalos.fun/kalos-sniper.min.js) reads those rows and emits a PerpMe
  venue tag. Kalos's [pool API](https://api.kalos.fun/v2/dex/pools) returns pool address,
  token0/token1 addresses, fee, state block/hash and liquidity; its
  [token API](https://api.kalos.fun/v2/dex/tokens) returns addresses, decimals, metadata and
  registration status. Do not join on its UI route IDs or ticker.
- **PerpMe support is implemented, current visibility is not verified:** the data module has
  `PERPME_LISTED=true` and merges `/v2/sniper/perpme/discovery` with `/v2/dex/discovery`.
  The [official PerpMe discovery API](https://api.kalos.fun/v2/sniper/perpme/discovery?limit=1)
  currently answered `{"error":"unavailable","message":"PerpMe is awaiting activation."}`.
  The [public site](https://kalos.fun/) has a countdown access gate. We did not bypass it or
  verify a live rendered Sniper list; shipped code support is not proof of current visibility.
- **Frontend:** the served modules use native ES-module imports, template strings and DOM
  updates (see the Sniper UI module). The [official HTML](https://kalos.fun/) references
  `.min.js` assets and has no observed Next `/_next/` or `__NEXT_DATA__` markers.
  React/Next as the site's overall build stack is **unverified**, not ruled out by this inspection.
  Kalos can implement the same adapter in its native module layer; React is only an example.
- **Confirmed testnet deployment:** [official config](https://api.kalos.fun/v2/dex/config)
  reports chain **99801**, factory `0x520bF060F58ceE054f725877279328F5f73A7893`,
  router `0x752f6816Bc514e1Eeff852b2eAdcd96f6c0F9f3f`, position manager
  `0x28580f9baeDDBc88D3Daca542aF12271E52B5765`; settlement artifacts explicitly say
  `settler-testnet-candidate.2`. These are **not mainnet addresses**.
- **Mainnet:** the [official countdown](https://kalos.fun/countdown.html) announces
  **Monday, November 9**, at Elysium's launch. The
  [official X account](https://x.com/kalosfun), linked by Kalos itself, also mentions Nov 9
  and mainnet. **Mainnet chain ID and Kalos deployment contracts remain unverified from
  the sources inspected**; do not assume the scanner's configured mainnet ID or reuse testnet contracts.

Before enabling badges: confirm target chain/deployments together; check public feed freshness,
edge headers and known-token responses; agree the visible-list adapter and null/stale styling;
test unavailable/429/expiry behavior. Do not gate trading or request approvals based on DELPHI.

### Verification notes

Examples were schema-validated against `FeedRecord` and served by the real local feed server.
CORS/preflight, weak ETag → empty 304, max-age=5, 50/51 IDs, missing/404, 100/101 discovery
limits, no-store health and a local burst producing 429/Retry-After were exercised.
Defaults were cross-checked in `src/live/server.ts` (`DEFAULT_LIMITS`, `tokens`, `recent`,
`sendData`, `COMMON_HEADERS`); dispute fields in `src/live/types.ts` and `dispute`.
The exact TSX block was extracted and strictly typechecked against React and the real record
projection; recorded responses were also passed through its parser. No service source or
deployment changes are part of this pack.
