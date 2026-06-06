#!/usr/bin/env bash
#
# TurboPanel daemon (agent node) installer.
#
# Thin bootstrap wrapper: fetch the repo, install the orchestration runtime
# (uv/Python/ansible), then hand off to the idempotent agent-install playbook
# for all provisioning.
#
#   curl -fsSL https://raw.githubusercontent.com/turbopanel/turbopanel-daemon/trunk/install.sh \
#     | sudo bash -s -- \
#         --instance-url https://<instance-host>:<port> \
#         --tunnel-token <CLOUDFLARED_TOKEN>
#
# Re-running is safe: every ansible role is idempotent.
set -euo pipefail

REPO_URL="https://github.com/turbopanel/turbopanel-daemon"
INSTALL_ROOT="/opt/turbopanel"
DAEMON_DIR="$INSTALL_ROOT/platform/daemon"
SERVICE_USER="turbopanel"
SERVICE_GROUP="turbopanel"
SCREEN_NAME="turbopanel"

BRANCH="trunk"
INSTANCE_URL=""
TUNNEL_TOKEN=""
INSTANCE_CA=""
INSECURE_TLS=""
START=1
PLATFORM_CA_PATH="$INSTALL_ROOT/certs/platform-ca.pem"

log() { printf '\033[1;36m[install]\033[0m %s\n' "$*"; }
err() { printf '\033[1;31m[install]\033[0m %s\n' "$*" >&2; }

# #region agent log
DEBUG_LOG="$INSTALL_ROOT/install-debug-9bf570.log"
debug_log() {
  local hypothesis_id="$1" location="$2" message="$3" data="$4"
  mkdir -p "$INSTALL_ROOT" 2>/dev/null || true
  printf '{"sessionId":"9bf570","hypothesisId":"%s","location":"%s","message":"%s","data":%s,"timestamp":%s}\n' \
    "$hypothesis_id" "$location" "$message" "$data" "$(date +%s000)" >> "$DEBUG_LOG" 2>/dev/null || true
}
# #endregion

usage() {
  cat <<'EOF'
Usage: install.sh --instance-url <URL> [options]

Required:
  --instance-url <URL>     Full instance URL incl. scheme + port
                           (e.g. https://<instance-host>:<port>)

Options:
  --tunnel-token <TOKEN>   Cloudflare tunnel token to run on this node
  --instance-ca <PATH>     PEM platform CA to trust (skips auto-fetch)
  --insecure-tls           Skip TLS verification when dialing the instance
  --branch <NAME>          Branch to track (default: trunk)
  --repo-url <URL>         Override the daemon repo URL
  --no-start               Set everything up but don't launch tilt
  -h, --help               Show this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --instance-url) INSTANCE_URL="${2:-}"; shift 2;;
    --instance-url=*) INSTANCE_URL="${1#*=}"; shift;;
    --tunnel-token) TUNNEL_TOKEN="${2:-}"; shift 2;;
    --tunnel-token=*) TUNNEL_TOKEN="${1#*=}"; shift;;
    --instance-ca) INSTANCE_CA="${2:-}"; shift 2;;
    --instance-ca=*) INSTANCE_CA="${1#*=}"; shift;;
    --fetch-instance-ca) log "note: --fetch-instance-ca is default for https; flag is optional"; shift;;
    --insecure-tls) INSECURE_TLS=1; shift;;
    --branch) BRANCH="${2:-}"; shift 2;;
    --branch=*) BRANCH="${1#*=}"; shift;;
    --repo-url) REPO_URL="${2:-}"; shift 2;;
    --repo-url=*) REPO_URL="${1#*=}"; shift;;
    --no-start) START=0; shift;;
    -h|--help) usage; exit 0;;
    *) err "unknown argument: $1"; usage; exit 1;;
  esac
done

if [ -z "$INSTANCE_URL" ]; then
  err "--instance-url is required"
  usage
  exit 1
fi

if [ "$(id -u)" != "0" ]; then
  err "must run as root (use sudo)"
  exit 1
fi

fetch_platform_ca() {
  mkdir -p "$INSTALL_ROOT/certs"
  log "fetching platform CA from $INSTANCE_URL/api/instance/ca"
  if curl -fsSk "$INSTANCE_URL/api/instance/ca" -o "$PLATFORM_CA_PATH"; then
    INSTANCE_CA="$PLATFORM_CA_PATH"
    log "platform CA saved to $INSTANCE_CA"
  else
    rm -f "$PLATFORM_CA_PATH"
    log "platform CA endpoint unavailable; using system certificate trust"
  fi
}

# Self-hosted instances publish their platform CA at /api/instance/ca. Fetch it
# automatically for https installs unless the caller supplied a CA or opted out
# of verification.
if [ -z "$INSTANCE_CA" ] && [ -z "$INSECURE_TLS" ] &&
  [[ "$INSTANCE_URL" == https://* ]]; then
  fetch_platform_ca
fi

# --- Bootstrap (before ansible exists) --------------------------------------
# Only the minimum needed to fetch the repo and run bootstrap-orchestration.sh.
log "installing bootstrap packages (curl, git, tar)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git tar ca-certificates

git_as_repo_owner() {
  # #region agent log
  local repo_owner repo_group
  repo_owner="$(stat -c '%U' "$DAEMON_DIR" 2>/dev/null || echo unknown)"
  repo_group="$(stat -c '%G' "$DAEMON_DIR" 2>/dev/null || echo unknown)"
  if id "$SERVICE_USER" &>/dev/null; then
    debug_log "A" "install.sh:git_as_repo_owner" "git as service user" \
      "{\"runAs\":\"$SERVICE_USER\",\"repoOwner\":\"$repo_owner\",\"repoGroup\":\"$repo_group\",\"cmd\":\"$*\"}"
    sudo -u "$SERVICE_USER" git -C "$DAEMON_DIR" "$@"
  else
    debug_log "A" "install.sh:git_as_repo_owner" "git as root with safe.directory" \
      "{\"runAs\":\"root\",\"repoOwner\":\"$repo_owner\",\"repoGroup\":\"$repo_group\",\"cmd\":\"$*\"}"
    git -C "$DAEMON_DIR" -c "safe.directory=$DAEMON_DIR" "$@"
  fi
  # #endregion
}

fix_repo_ownership() {
  if [ ! -d "$DAEMON_DIR/.git" ] || ! id "$SERVICE_USER" &>/dev/null; then
    return 0
  fi
  local owner
  owner="$(stat -c '%U' "$DAEMON_DIR" 2>/dev/null || echo unknown)"
  if [ "$owner" = "$SERVICE_USER" ]; then
    return 0
  fi
  # #region agent log
  debug_log "D" "install.sh:fix_repo_ownership" "chown checkout before git" \
    "{\"fromOwner\":\"$owner\",\"toOwner\":\"$SERVICE_USER\"}"
  # #endregion
  chown -R "$SERVICE_USER:$SERVICE_GROUP" "$DAEMON_DIR"
}

ensure_repo() {
  if [ -d "$DAEMON_DIR/.git" ]; then
    log "updating existing checkout at $DAEMON_DIR"
    fix_repo_ownership
    git_as_repo_owner remote set-url origin "$REPO_URL"
    git_as_repo_owner fetch origin "$BRANCH"
    git_as_repo_owner checkout "$BRANCH"
    git_as_repo_owner reset --hard "origin/$BRANCH"
  else
    log "cloning $REPO_URL ($BRANCH) into $DAEMON_DIR"
    mkdir -p "$(dirname "$DAEMON_DIR")"
    git clone --branch "$BRANCH" "$REPO_URL" "$DAEMON_DIR"
  fi
}

ensure_repo

log "bootstrapping orchestration runtime (uv, Python, ansible)"
bash "$DAEMON_DIR/scripts/bootstrap-orchestration.sh"

ANSIBLE_PLAYBOOK="$DAEMON_DIR/orchestration/runtime/venv/bin/ansible-playbook"
ANSIBLE_CFG="$DAEMON_DIR/orchestration/ansible.cfg"
PLAYBOOK="$DAEMON_DIR/orchestration/playbooks/agent-install.yml"

if [ ! -x "$ANSIBLE_PLAYBOOK" ]; then
  err "ansible-playbook not found at $ANSIBLE_PLAYBOOK"
  exit 1
fi

# --- Ansible provisioning (idempotent) ------------------------------------
VARS_FILE="$(mktemp)"
trap 'rm -f "$VARS_FILE"' EXIT

# Write extra vars as YAML for ansible -e @file
{
  printf 'turbopanel_instance_url: "%s"\n' "$INSTANCE_URL"
  printf 'turbopanel_repo_url: "%s"\n' "$REPO_URL"
  printf 'turbopanel_branch: "%s"\n' "$BRANCH"
  printf 'turbopanel_start: %s\n' "$([ "$START" = "1" ] && echo true || echo false)"
  printf 'turbopanel_tls_insecure: %s\n' "$([ -n "$INSECURE_TLS" ] && echo true || echo false)"
  if [ -n "$TUNNEL_TOKEN" ]; then
    printf 'turbopanel_tunnel_token: "%s"\n' "$TUNNEL_TOKEN"
  fi
  if [ -n "$INSTANCE_CA" ]; then
    printf 'turbopanel_instance_ca: "%s"\n' "$INSTANCE_CA"
  fi
} > "$VARS_FILE"

# #region agent log
repo_owner="$(stat -c '%U' "$DAEMON_DIR" 2>/dev/null || echo unknown)"
debug_log "B" "install.sh:pre-ansible" "handing off to ansible daemon-repo" \
  "{\"repoOwner\":\"$repo_owner\",\"ansibleUser\":\"root\",\"playbook\":\"agent-install.yml\"}"
# #endregion

log "running agent-install playbook"
ANSIBLE_CONFIG="$ANSIBLE_CFG" "$ANSIBLE_PLAYBOOK" \
  -i localhost, \
  -c local \
  -e "@$VARS_FILE" \
  "$PLAYBOOK"

if [ "$START" = "1" ]; then
  log "restarting daemon to apply configuration"
  sudo -u "$SERVICE_USER" screen -S "$SCREEN_NAME" -X quit >/dev/null 2>&1 || true
  sleep 1
  sudo -u "$SERVICE_USER" bash -lc "cd '$DAEMON_DIR' && screen -dmS '$SCREEN_NAME' tilt up --stream"
fi

cat <<EOF

TurboPanel daemon installed.

  service user : $SERVICE_USER:$SERVICE_GROUP (9999:9999)
  instance URL : $INSTANCE_URL
  checkout     : $DAEMON_DIR ($BRANCH)
  config       : $DAEMON_DIR/.env
  tunnels      : $DAEMON_DIR/cloudflared/tunnels/*.token

Manage it:
  sudo -u $SERVICE_USER screen -r $SCREEN_NAME      # attach (Ctrl-A D to detach)
  sudo -u $SERVICE_USER screen -S $SCREEN_NAME -X quit   # stop

Re-run this installer to upgrade or reconcile configuration.

Start manually (if launched with --no-start):
  sudo -u $SERVICE_USER bash -lc 'cd $DAEMON_DIR && tilt up --stream'

Add another Cloudflare tunnel later: drop a <name>.token file in
  $DAEMON_DIR/cloudflared/tunnels/
EOF
