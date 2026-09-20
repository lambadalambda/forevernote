# Shared configuration for the deployment helpers. Sourced, not run.
#
# These scripts automate one specific setup: a SvelteKit app in a Proxmox LXC, with a
# llama.cpp server in a second container, behind a reverse proxy. Nothing here is
# guessed, because a wrong guess would touch the wrong machine.

require() {
  local name=$1 value=${!1:-}
  if [ -z "$value" ]; then
    echo "error: \$$name is not set." >&2
    echo "The deployment helpers need to be told where to deploy; see the README." >&2
    exit 1
  fi
}

# ssh target for the Proxmox host, e.g. root@proxmox.example.com
require FOREVERNOTE_SSH_HOST
# Container holding the app.
require FOREVERNOTE_CTID
# Public URL, used only to verify a deploy landed.
require FOREVERNOTE_PUBLIC_URL

HOST=$FOREVERNOTE_SSH_HOST
CTID=$FOREVERNOTE_CTID
PUBLIC_URL=${FOREVERNOTE_PUBLIC_URL%/}
APP_DIR=${FOREVERNOTE_APP_DIR:-/opt/forevernote}
