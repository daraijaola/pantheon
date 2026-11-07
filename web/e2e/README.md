# Production regression suite

Requires Node 24 and the Playwright browser dependencies:

```sh
cd web
npm ci
npx playwright install --with-deps chromium webkit firefox
npm run test:e2e
```

Playwright starts `server.mjs`, which starts local service/RPC fixtures on port
4174, runs a plain `next build`, then `next start` on port 4173. Both ports must
be free. The build may fetch Google Fonts; runtime application data never uses
production services. No wallet keys, signatures, credentials or live snapshots
are needed. Unexpected outbound browser requests and unconfigured fixture calls
fail the tests. Inherited model keys and WalletConnect configuration are disabled.

The twelve projects cover Chromium, WebKit and Firefox at 390×844, 360×800,
768×1024 and 1440×900. Route discovery reads every `page.tsx` under `src/app`,
including route groups; the DELPHI token parameter uses the synthetic PACT report.
`/space` is not present on the main branch used for this suite (PR 7 is unmerged).

Tests assert status, uncaught errors, console errors, loaded images, horizontal
overflow and content/header geometry without screenshots or pixel baselines.
Only WebKit's exact known `interactive-widget` console error is allowlisted.
Explore and app navigation use real links. The injected EIP-1193 wallet rejects
all signing and transaction requests; RPC reads and gas estimates are local.
The mobile chat regression runs at 390 and 360 widths in all three browsers.
All other active specs run in every project.

Known application issues are named fixmes, not additional console allowlists:

- **Audit F01:** homepage Get uploaded only shows Opening soon instead of
  navigating to `/upload`.
- **E2E F09:** the connected `/stake` transaction scenario emits React hydration
  error 418. This was reproduced with hard navigation and through the homepage
  Stake link; transaction rejection assertions themselves completed. The whole
  connected transaction scenario remains fixme until the hydration issue is fixed.
  Disconnected and wrong-chain Stake cases still run.

WalletConnect retry/cancel cleanup (PR 11) stays at the unit level rather than
opening a real relay in browser tests. CI also runs:

```sh
node --experimental-strip-types --test src/lib/wallet-connect-attempt.test.ts
```

`web-e2e.yml` runs on PRs touching `web/`, caches browser downloads and uploads the
HTML report and failure traces. Local reports are under `e2e/playwright-report/`
and traces under `e2e/test-results/`; generated reports and `.runtime/` data are
ignored. Retries are disabled so a flaky first attempt cannot be hidden.
