# Inside-app authentication

- `SESSION_SECRET`: server-only random secret, at least 32 characters. Required in production; keep the same value across restarts. Rotating it invalidates all sessions. Development without it uses an ephemeral random key.
- `AUTH_ORIGIN`: canonical public origin, e.g. `https://pantheonindex.com`. Set it behind a reverse proxy. Otherwise the request URL's origin is used. SIWE binds both domain (including port) and URI to this origin.
- `UPLOADED_API`: server-only Uploaded base URL; defaults to `http://127.0.0.1:8791`, matching `services/uploaded`. No previous Uploaded rewrite or URL was configured in the web app. Keep Uploaded private: its direct HTTP routes do not enforce these sessions.
- `NEXT_PUBLIC_RPC_URL`: existing Elysium RPC setting, also used for ERC-1271/6492 signature verification. Ordinary EOA signatures verify locally.

Session cookies are HMAC-SHA256 signed, httpOnly, sameSite=lax, host-only and valid for seven days. They are Secure in production and on HTTPS; plain HTTP development is the only exception. Nonce cookies expire in five minutes. Auth and gateway responses are never cached. POST sign-in/logout reject cross-origin requests; sign-in requires JSON.

Nonce issuance is stateless: the short-lived HMAC-signed nonce cookie proves issuance and binds origin and timestamps. No IP headers, per-client caps or pending-nonce records are used. Only successfully verified signatures add replay records. Verification checks for reuse again after awaiting the signature verifier, then atomically records use before returning a session. Replay records expire with the challenge and are pruned before insertion. At the 10,000-record bound the oldest records are evicted, raising a shared issued-at cutoff to cover each evicted challenge. Any challenge issued at or before the cutoff fails with `INVALID_NONCE`, including evicted replays and older outstanding challenges. Those users need a fresh nonce; new challenges are always issued after the cutoff, even within the same clock millisecond. There is no capacity-based 429. Unsigned requests and cancelled or invalid signatures cannot fill this store.

Replay protection is process-local. Run one Next process; multiple instances need a shared atomic replay store. A restart loses used-nonce records, so rotate the secret on restart or persist/share replay protection if replay across restarts must be prevented. Stateless sessions cannot be remotely revoked: logout deletes the browser cookie, while a copied bearer cookie remains valid until expiry or secret rotation.

`/api/me/*` accepts GET only, selects the wallet exclusively from the verified session, and allows bag, rewards, stake, standing, guard, trials/record, trials/ballot and scan. Query strings and upstream statuses pass through; browser cookies/authorization headers and upstream cookies do not. Scan responses stream without buffering. Upstream failures return 502 rather than example/zero data.

The gateway translates the UI's `trials/record` and `trials/ballot` to Uploaded's existing `/wallets/{wallet}/record` and `/wallets/{wallet}/ballot` endpoints. All other allowed paths are forwarded unchanged.

The existing upload sign action now signs SIWE and creates this session. The upload interface, including its post-bubble placeholder, is retained unchanged; `/space` reads the resulting session. Wiring the designed upload animation's timing to scan SSE is the separate architecture step 1.7.
