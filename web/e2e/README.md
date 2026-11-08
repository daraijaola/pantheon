# Production regression suite

Requires Node 24 and the Playwright browser dependencies:

```sh
cd web
npm ci
npx playwright install --with-deps chromium webkit firefox
npm run test:e2e
```

Playwright starts `server.mjs`, which starts local service/RPC fixtures on port
4174, runs a plain `next build`, then `next start` on port 4173. Ports 4173–4176 must
be free. Successful SIWE uses a second Next process on 4175 behind a local TLS
proxy on 4176, with an ephemeral OpenSSL certificate in the ignored runtime directory.
This exercises unchanged production Secure, HttpOnly, __Host- cookies in every browser.
The build may fetch Google Fonts; runtime application data never uses
production services. No real wallet keys, credentials or live snapshots
are needed. Onboarding signs SIWE with a public disposable fixture key and uses
the real session gateway backed by local Uploaded responses.
Unexpected outbound browser requests and unconfigured fixture calls
fail the tests. Inherited model keys and WalletConnect configuration are disabled.
Browser HTTP(S) traffic uses a deny-only local proxy, bypassed for loopback.
Local requests are observed, not globally intercepted: WebKit can report aborted Next
prefetches as access-control errors when Playwright interception is enabled.
The proxy test verifies that both HTTP and HTTPS outbound attempts are denied.

The twelve projects cover Chromium, WebKit and Firefox at 390×844, 360×800,
768×1024 and 1440×900. Route discovery reads every `page.tsx` under `src/app`,
including route groups; the DELPHI token parameter uses the synthetic PACT report.
`/space` is included in disconnected route discovery and signed-in onboarding coverage.

Tests assert status, uncaught errors, console errors, loaded images, horizontal
overflow and content/header geometry without screenshots or pixel baselines.
Only WebKit's exact known `interactive-widget` console error is allowlisted.
Explore and app navigation use real links. The injected EIP-1193 wallet rejects
all signing and transaction requests by default; only the successful onboarding
case enables fixture SIWE signatures. RPC reads and gas estimates are local.
The mobile chat regression runs at 390 and 360 widths in all three browsers.
All other active specs run in every project.

Audit F01 (homepage navigation) and F09 (connected Stake hydration) are active
regressions, not fixmes or console allowlists.

WalletConnect retry/cancel cleanup (PR 11) stays at the unit level rather than
opening a real relay in browser tests. CI also runs:

```sh
node --experimental-strip-types --test src/lib/wallet-connect-attempt.test.ts
```

`web-e2e.yml` runs on PRs touching `web/`, caches browser downloads and uploads the
HTML report and failure traces. Local reports are under `e2e/playwright-report/`
and traces under `e2e/test-results/`; generated reports and `.runtime/` data are
ignored. Retries are disabled so a flaky first attempt cannot be hidden.
