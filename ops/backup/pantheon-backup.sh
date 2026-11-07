#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

BACKUP_DIR="${BACKUP_DIR:-/var/backups/pantheon}"
STATUS_FILE="${STATUS_FILE:-/var/lib/pantheon-ops/backup-status.json}"
REPO_ROOT="${REPO_ROOT:-/srv/hackathon/pantheon}"
KEEP_BACKUPS="${KEEP_BACKUPS:-14}"
INDEXER_STATE="${INDEXER_STATE:-/var/lib/indexer/index.json}"
PASSPORT_DB="${PASSPORT_DB:-/var/lib/passport/passport.db}"
TRIALS_STATE="${TRIALS_STATE:-/var/lib/trials/ballots.json}"
KEEPER_STATE="${KEEPER_STATE:-/var/lib/keeper/state.json}"
DELPHI_DB="${DELPHI_DB:-$REPO_ROOT/services/delphi/data/delphi.db}"
DELPHI_FEED_DB="${DELPHI_FEED_DB:-$REPO_ROOT/services/delphi/data/feed.db}"
DELPHI_X_DB="${DELPHI_X_DB:-$REPO_ROOT/services/delphi/data/x.db}"
SQLITE_HELPER="${SQLITE_HELPER:-$REPO_ROOT/ops/backup/backup-sqlite.mjs}"
NODE="${NODE:-/usr/bin/node}"
JQ="${JQ:-/usr/bin/jq}"
ZSTD="${ZSTD:-/usr/bin/zstd}"

mkdir -p "$BACKUP_DIR" "$(dirname "$STATUS_FILE")"
chmod 0700 "$BACKUP_DIR"
# The web process only reads this non-secret heartbeat. Archives stay root-only.
chmod 0755 "$(dirname "$STATUS_FILE")"
exec 9>"$BACKUP_DIR/.lock"
flock -n 9 || {
  echo "another PANTHEON backup is already running" >&2
  exit 0
}

started_ms="$("$NODE" -e 'process.stdout.write(String(Date.now()))')"
work="$(mktemp -d "$BACKUP_DIR/.work.XXXXXX")"
snapshot="$work/snapshot"
mkdir -p "$snapshot/state" "$snapshot/delphi" "$snapshot/config"

write_failure() {
  local exit_code=$?
  if (( exit_code != 0 )); then
    local failed_ms previous
    failed_ms="$("$NODE" -e 'process.stdout.write(String(Date.now()))')"
    previous="null"
    if [[ -f "$STATUS_FILE" ]]; then
      previous="$("$JQ" -r 'if .ok == true then .completedAtMs else .lastGoodCompletedAtMs // null end' "$STATUS_FILE" 2>/dev/null || printf null)"
    fi
    "$JQ" -n \
      --argjson startedAtMs "$started_ms" \
      --argjson failedAtMs "$failed_ms" \
      --argjson lastGoodCompletedAtMs "$previous" \
      '{ok:false, startedAtMs:$startedAtMs, failedAtMs:$failedAtMs, lastGoodCompletedAtMs:$lastGoodCompletedAtMs}' \
      >"$STATUS_FILE.tmp"
    chmod 0644 "$STATUS_FILE.tmp"
    mv -f "$STATUS_FILE.tmp" "$STATUS_FILE"
  fi
  rm -rf "$work"
  exit "$exit_code"
}
trap write_failure EXIT

copy_json() {
  local source=$1 destination=$2
  local attempt
  for attempt in 1 2 3; do
    cp --reflink=auto "$source" "$destination"
    if "$JQ" -e . "$destination" >/dev/null; then
      return
    fi
    sleep "$attempt"
  done
  echo "could not take a valid snapshot of $source" >&2
  return 1
}

copy_optional() {
  local source=$1 destination=$2
  [[ -f "$source" ]] || return 0
  cp --reflink=auto "$source" "$destination"
}

copy_optional_json() {
  local source=$1 destination=$2
  [[ -f "$source" ]] || return 0
  copy_json "$source" "$destination"
}

backup_sqlite() {
  local module_root=$1 source=$2 destination=$3
  "$NODE" "$SQLITE_HELPER" backup "$module_root" "$source" "$destination"
}

copy_json "$INDEXER_STATE" "$snapshot/state/indexer.json"
copy_json "$TRIALS_STATE" "$snapshot/state/trials.json"
copy_json "$KEEPER_STATE" "$snapshot/state/keeper.json"
backup_sqlite "$REPO_ROOT/services/passport" "$PASSPORT_DB" "$snapshot/state/passport.db"
backup_sqlite "$REPO_ROOT/services/delphi" "$DELPHI_DB" "$snapshot/delphi/delphi.db"
backup_sqlite "$REPO_ROOT/services/delphi" "$DELPHI_FEED_DB" "$snapshot/delphi/feed.db"
backup_sqlite "$REPO_ROOT/services/delphi" "$DELPHI_X_DB" "$snapshot/delphi/x.db"
copy_optional_json "$REPO_ROOT/services/delphi/out/site.json" "$snapshot/delphi/site.json"
copy_optional_json "$REPO_ROOT/services/delphi/out/scan.json" "$snapshot/delphi/scan.json"
copy_optional "$REPO_ROOT/services/delphi/out/disputes.log" "$snapshot/delphi/disputes.log"
copy_optional "$REPO_ROOT/deployments/elysium.json" "$snapshot/config/elysium.json"
copy_optional "$REPO_ROOT/web/.dist-slot" "$snapshot/config/web-dist-slot"

cat >"$snapshot/MANIFEST.txt" <<EOF
PANTHEON state backup
Created: $(date --utc --iso-8601=seconds)
Secrets and private keys are intentionally excluded.
JSON: indexer, trials, keeper
SQLite online backups: Passport, DELPHI scanner, DELPHI feed, DELPHI X
Derived snapshots: DELPHI site/scan, disputes, public deployment metadata
EOF

stamp="$(date --utc +%Y%m%dT%H%M%SZ)"
archive="$BACKUP_DIR/pantheon-$stamp.tar.zst"
temporary="$archive.partial"
tar --sort=name --mtime="@$((started_ms / 1000))" --owner=0 --group=0 --numeric-owner -C "$snapshot" -cf - . |
  "$ZSTD" -T0 -q -6 -o "$temporary"
chmod 0600 "$temporary"
mv -f "$temporary" "$archive"
sha256="$(sha256sum "$archive" | cut -d' ' -f1)"
printf '%s  %s\n' "$sha256" "$(basename "$archive")" >"$archive.sha256"
chmod 0600 "$archive.sha256"

verify="$(mktemp -d "$work/verify.XXXXXX")"
"$ZSTD" -q -dc "$archive" | tar -xf - -C "$verify"
"$JQ" -e . "$verify/state/indexer.json" "$verify/state/trials.json" "$verify/state/keeper.json" >/dev/null
"$NODE" "$SQLITE_HELPER" check "$REPO_ROOT/services/passport" "$verify/state/passport.db"
"$NODE" "$SQLITE_HELPER" check "$REPO_ROOT/services/delphi" "$verify/delphi/delphi.db"
"$NODE" "$SQLITE_HELPER" check "$REPO_ROOT/services/delphi" "$verify/delphi/feed.db"
"$NODE" "$SQLITE_HELPER" check "$REPO_ROOT/services/delphi" "$verify/delphi/x.db"

completed_ms="$("$NODE" -e 'process.stdout.write(String(Date.now()))')"
size_bytes="$(stat -c %s "$archive")"
"$JQ" -n \
  --arg archive "$(basename "$archive")" \
  --arg sha256 "$sha256" \
  --argjson startedAtMs "$started_ms" \
  --argjson completedAtMs "$completed_ms" \
  --argjson sizeBytes "$size_bytes" \
  '{ok:true, verified:true, archive:$archive, sha256:$sha256, sizeBytes:$sizeBytes, startedAtMs:$startedAtMs, completedAtMs:$completedAtMs}' \
  >"$STATUS_FILE.tmp"
chmod 0644 "$STATUS_FILE.tmp"
mv -f "$STATUS_FILE.tmp" "$STATUS_FILE"

mapfile -t old < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'pantheon-*.tar.zst' -printf '%T@ %p\n' | sort -rn | tail -n "+$((KEEP_BACKUPS + 1))" | cut -d' ' -f2-)
for item in "${old[@]}"; do
  rm -f -- "$item" "$item.sha256"
done

echo "verified backup: $archive ($size_bytes bytes)"
