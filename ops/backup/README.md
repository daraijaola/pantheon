# Production backups

`pantheon-backup.sh` creates an online snapshot without stopping the site. It validates every JSON file, uses SQLite's backup API for live databases, restores the archive into a temporary directory, runs `quick_check` on each restored database, and only then marks the backup healthy.

It backs up:

- indexer, Trials and keeper JSON state;
- Passport, DELPHI scanner, feed and X SQLite databases;
- current DELPHI site/scan snapshots and disputes;
- public deployment metadata and the active web build slot.

Secrets and private keys are intentionally excluded. They belong in the environment/secret store, not a product-data archive.

The timer keeps 14 verified daily archives under `/var/backups/pantheon`. Archives remain root-only; `/var/lib/pantheon-ops` is traversable so the web process can read the non-secret, world-readable health heartbeat. `BACKUP_DIR`, `STATUS_FILE`, `REPO_ROOT`, source paths and `KEEP_BACKUPS` can be overridden for a restore drill or a different server layout.

Install after the repository files are deployed:

```sh
sudo install -m 0755 ops/backup/pantheon-backup.sh /usr/local/sbin/pantheon-backup
sudo install -d -m 0700 /var/backups/pantheon
sudo install -d -m 0755 /usr/local/lib/pantheon /var/lib/pantheon-ops
sudo install -m 0644 ops/backup/backup-sqlite.mjs /usr/local/lib/pantheon/backup-sqlite.mjs
sudo install -m 0644 ops/systemd/pantheon-backup.service /etc/systemd/system/pantheon-backup.service
sudo install -m 0644 ops/systemd/pantheon-backup.timer /etc/systemd/system/pantheon-backup.timer
sudo systemctl daemon-reload
sudo systemctl enable --now pantheon-backup.timer
sudo systemctl start pantheon-backup.service
```

Check the result:

```sh
sudo systemctl status pantheon-backup.service
sudo cat /var/lib/pantheon-ops/backup-status.json
sudo sha256sum -c /var/backups/pantheon/pantheon-*.tar.zst.sha256
```
