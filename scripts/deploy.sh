#!/usr/bin/env bash
# Deploys Forevernote to a Proxmox LXC. Configured through the environment; see
# scripts/_config.sh and the README.
#
#   scripts/deploy.sh                    build + push app code only
#   scripts/deploy.sh --replace-data --force
#                                        also overwrite the remote database
#
# The NAS is the live copy: notes are edited and files uploaded there, and text is
# extracted there. Its database is therefore the source of truth, and pushing the local
# one destroys anything created since the last pull. That is why --replace-data needs
# --force as well.
set -euo pipefail

LOCAL_DB=${FOREVERNOTE_DB:-data/forevernote.db}
WITH_DATA=0
if [ "${1:-}" = "--replace-data" ]; then
  if [ "${2:-}" != "--force" ]; then
    echo "refusing: --replace-data overwrites the live database on the NAS."
    echo "Anything uploaded or edited there since your last pull would be lost."
    echo "Re-run as: scripts/deploy.sh --replace-data --force"
    exit 1
  fi
  WITH_DATA=1
fi

cd "$(dirname "$0")/.."
. "$(dirname "$0")/_config.sh"

echo "==> building"
npm run build >/dev/null
COPYFILE_DISABLE=1 tar --no-xattrs -czf /tmp/fn-app.tgz --exclude="._*" build

echo "==> uploading app"
scp -q /tmp/fn-app.tgz "$HOST":/tmp/fn-app.tgz
ssh "$HOST" "pct push $CTID /tmp/fn-app.tgz $APP_DIR/fn-app.tgz && rm -f /tmp/fn-app.tgz"

if [ "$WITH_DATA" = "1" ]; then
  echo "==> snapshotting database (checkpoints WAL, safe while the app runs)"
  rm -f /tmp/fn-deploy.db
  sqlite3 "$LOCAL_DB" ".backup /tmp/fn-deploy.db"
  echo "==> uploading database ($(du -h /tmp/fn-deploy.db | cut -f1))"
  scp -q /tmp/fn-deploy.db "$HOST":/tmp/fn-deploy.db
fi

echo "==> installing"
ssh "$HOST" "
  set -e
  pct exec $CTID -- systemctl stop forevernote
  pct exec $CTID -- bash -lc '
    set -e
    cd $APP_DIR
    rm -rf build
    tar xzf fn-app.tgz && rm fn-app.tgz
    find . -name \"._*\" -delete
    npm install --omit=dev --no-audit --no-fund --silent
  '
  if [ $WITH_DATA = 1 ]; then
    pct exec $CTID -- bash -lc 'rm -f $APP_DIR/data/forevernote.db-wal $APP_DIR/data/forevernote.db-shm'
    pct push $CTID /tmp/fn-deploy.db $APP_DIR/data/forevernote.db
    rm -f /tmp/fn-deploy.db
  fi
  pct exec $CTID -- chown -R forevernote:forevernote $APP_DIR
  pct exec $CTID -- systemctl start forevernote
"

echo "==> verifying"
sleep 3
code=$(curl -s -o /dev/null -w "%{http_code}" "$PUBLIC_URL/")
notes=$(curl -s "$PUBLIC_URL/" | grep -oE '[0-9]+ notes' | head -1)
echo "$PUBLIC_URL/ -> $code ($notes)"
[ "$code" = "200" ]
