#!/bin/sh
set -eu
umask 077
backup_dir=/var/lib/weekly-planner/backups
mkdir -p "$backup_dir"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
tmp="$backup_dir/$stamp.sqlite3.tmp"
node --no-warnings -e '
const { DatabaseSync, backup } = require("node:sqlite");
const source = new DatabaseSync(process.argv[1], { readOnly: true });
backup(source, process.argv[2]).then(() => source.close()).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
' /var/lib/weekly-planner/planner.sqlite3 "$tmp"
node --no-warnings -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
db.exec("PRAGMA journal_mode = DELETE");
if (db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok") process.exit(1);
db.close();
' "$tmp"
mv "$tmp" "$backup_dir/$stamp.sqlite3"
