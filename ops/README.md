# Production reliability

PANTHEON has three independent safeguards:

1. `/api/health` checks the indexer, Passport, Trials, DELPHI freshness and the last verified backup. Empty or stale DELPHI data cannot report healthy.
2. `pantheon-backup.timer` creates and restores a product-data snapshot every day. A backup is marked healthy only after JSON parsing, archive extraction and SQLite `quick_check` all pass.
3. `.github/workflows/production-health.yml` checks the site from outside the server every ten minutes. It opens one `production-alert` issue on failure and closes it after recovery, without repeated alert spam.

The health response contains component names, states, ages and request latency only. It does not return internal URLs, file paths, credentials or exception text.
