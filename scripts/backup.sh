#!/usr/bin/env bash
# Pulls the live database off the server. Once you edit notes there, that copy is the
# source of truth, so this is both the backup and the way to get current data locally.
#
#   scripts/backup.sh                  -> backups/forevernote-<UTC>.db
#   scripts/backup.sh --to data/forevernote.db   overwrite the local working copy
set -euo pipefail


cd "$(dirname "$0")/.."
. "$(dirname "$0")/_config.sh"
REMOTE_DB=$APP_DIR/data/forevernote.db
DEST=${2:-}
if [ "${1:-}" = "--to" ] && [ -n "$DEST" ]; then
  OUT="$DEST"
else
  mkdir -p backups
  OUT="backups/forevernote-$(date -u +%Y%m%dT%H%M%SZ).db"
fi

echo "==> snapshotting on the NAS (checkpoints WAL, safe while the app runs)"
ssh "$HOST" "pct exec $CTID -- bash -lc '
  rm -f /tmp/forevernote-backup.db
  sqlite3 $REMOTE_DB \".backup /tmp/forevernote-backup.db\"
  sqlite3 /tmp/forevernote-backup.db \"PRAGMA integrity_check\" | head -1
'"
ssh "$HOST" "pct pull $CTID /tmp/forevernote-backup.db /tmp/forevernote-backup.db && ls -la /tmp/forevernote-backup.db" >/dev/null
scp -q "$HOST":/tmp/forevernote-backup.db "$OUT"
ssh "$HOST" "rm -f /tmp/forevernote-backup.db; pct exec $CTID -- rm -f /tmp/forevernote-backup.db"

echo "==> $OUT ($(du -h "$OUT" | cut -f1))"
sqlite3 "$OUT" "SELECT (SELECT count(*) FROM notes) || ' notes, ' || (SELECT count(*) FROM resources) || ' attachments';"
