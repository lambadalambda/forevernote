#!/usr/bin/env bash
# Provisions the server side of Forevernote's ingestion pipeline. Idempotent.
#
#   app container : poppler-utils, so PDF pages can be read and rasterised
#   llm container : a resident llama-server holding the vision model
#
# The model has to stay loaded: a cold start of E4B took 98 s, which no upload
# should ever wait for.
set -euo pipefail

. "$(dirname "$0")/_config.sh"
# Container running llama.cpp, and the address the app should reach it on.
require FOREVERNOTE_LLM_CTID
require FOREVERNOTE_LLM_IP
APP_CT=$CTID
LLM_CT=$FOREVERNOTE_LLM_CTID
LLM_IP=$FOREVERNOTE_LLM_IP
LLM_PORT=${FOREVERNOTE_LLM_PORT:-8081}
MODEL_DIR=${FOREVERNOTE_MODEL_DIR:-/models/unsloth-gemma-4-E4B-it-GGUF}
# Label only: llama-server serves whichever model it loaded and ignores the requested name.
MODEL_NAME=${FOREVERNOTE_MODEL_NAME:-gemma-4-E4B-it-Q4_K_M.gguf}

echo "==> poppler-utils in container $APP_CT"
ssh "$HOST" "pct exec $APP_CT -- bash -lc '
  set -e
  if ! command -v pdftoppm >/dev/null; then
    apt-get update -qq && apt-get install -y -qq poppler-utils >/dev/null
  fi
  pdftoppm -v 2>&1 | head -1
'"

echo "==> llama-server unit in container $LLM_CT"
ssh "$HOST" "pct exec $LLM_CT -- bash -lc '
  set -e
  model=\$(find $MODEL_DIR -name \"*.gguf\" ! -name \"mmproj*\" | head -1)
  mmproj=\$(find $MODEL_DIR -name \"mmproj*.gguf\" | head -1)
  [ -n \"\$model\" ] && [ -n \"\$mmproj\" ] || { echo \"no model in $MODEL_DIR\"; exit 1; }

  cat > /etc/systemd/system/forevernote-llm.service <<UNIT
[Unit]
Description=Vision model for Forevernote text extraction
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/llama-server \\\\
  --host 0.0.0.0 --port $LLM_PORT \\\\
  -m \$model --mmproj \$mmproj \\\\
  -ngl 99 -c 8192 -t 8 --jinja \\\\
  --parallel 1
Restart=always
RestartSec=10
# Loading ~5 GB off ZFS takes a while; do not let systemd call it a failed start.
TimeoutStartSec=600
Nice=5

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable --now forevernote-llm
  echo \"model:  \$(basename \$model)\"
'"

echo "==> forevernote service in container $APP_CT"
ssh "$HOST" "pct exec $APP_CT -- bash -lc '
  cat > /etc/systemd/system/forevernote.service <<UNIT
[Unit]
Description=Forevernote
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=forevernote
Group=forevernote
WorkingDirectory=/opt/forevernote
Environment=NODE_ENV=production
Environment=HOST=0.0.0.0
Environment=PORT=3000
Environment=FOREVERNOTE_DB=/opt/forevernote/data/forevernote.db
Environment=FOREVERNOTE_LLM_URL=http://$LLM_IP:$LLM_PORT/v1
Environment=FOREVERNOTE_LLM_MODEL=$MODEL_NAME
Environment=PROTOCOL_HEADER=x-forwarded-proto
Environment=HOST_HEADER=x-forwarded-host
Environment=XFF_DEPTH=1
Environment=BODY_SIZE_LIMIT=128M
ExecStart=/usr/bin/node build/index.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/forevernote/data

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl restart forevernote
  systemctl is-active forevernote
'"

echo "==> waiting for the model to load"
for i in $(seq 1 90); do
  if curl -sf "http://$LLM_IP:$LLM_PORT/health" >/dev/null 2>&1; then
    echo "model server ready after ${i}0s at http://$LLM_IP:$LLM_PORT"
    exit 0
  fi
  sleep 10
done
echo "model server did not come up; check: ssh $HOST 'pct exec $LLM_CT -- journalctl -u forevernote-llm -n 40'"
exit 1
