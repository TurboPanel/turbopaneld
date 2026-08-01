#!/bin/sh
# TurboPanel daemon bootstrap — single entrypoint served at
# https://turbopanel.sh/run.sh. Caddy also serves /run.sh in co-located dev.
#
# Fetches split release artifacts from the channel manifest at
# https://dl.trbp.nl/channels.json (host-arch native binary + orchestration tree;
# JS bundle when the native binary cannot execute on this host), installs the
# production FHS layout (bin/turbopaneld, optional bin/turbopaneld.js,
# share/orchestration/), probes native binary executability, bootstraps
# orchestration runtimes, and runs daemon-install.yml via Ansible
# (turbopaneld.service — native or Deno JS runtime; see AGENTS.md).
#
# Config: /etc/turbopanel  State: /var/lib/turbopanel  Runtime: /run/turbopanel
#
# Run as root or as a sudo-capable user (self-escalates via sudo when available).
#
# Typical install (production):
#   curl -fsSL turbopanel.sh/run.sh | TURBOPANEL_LICENSE=<b64> sh
# Optional: TURBOPANEL_HOST, TURBOPANEL_INSECURE_TLS=1, TURBOPANEL_UPDATE_CHANNEL.
# Flags (--license, --host, …) remain supported for scripts and sudo re-exec.
#
# Manifest and release helpers below must stay in sync with scripts/lib/release-artifacts.sh.

# Shared curl prefixes for HTTPS downloads (and the insecure-TLS install path).
TP_CURL_FETCH='curl -fsSL'
TP_CURL_FETCH_INSECURE='curl -fsSLk'

# Release artifact downloads (channel manifest, verified binary/orchestration/JS
# artifacts, and the Deno runtime zip) always verify TLS against public trust.
# `--insecure-tls` only relaxes trust for the self-hosted *instance* bootstrap
# legs (the initial run.sh re-exec and the instance CA fetch) — it must never
# weaken release/CDN trust, so bootstrapping a self-signed instance cannot
# silently disable verification of the code we execute. If a genuine
# release-download TLS emergency ever arises, TURBOPANEL_RELEASE_TLS_INSECURE_OVERRIDE=1
# is a deliberately undocumented, operator-only escape hatch: it is never derived
# from --insecure-tls and never emitted by the install-command builder.
tp_release_curl() {
  if [ "${TURBOPANEL_RELEASE_TLS_INSECURE_OVERRIDE:-}" = 1 ]; then
    printf '%s' "$TP_CURL_FETCH_INSECURE"
  else
    printf '%s' "$TP_CURL_FETCH"
  fi
}

tp_prod_home() { printf '/opt/turbopanel'; }
tp_daemon_binary_name() { printf 'turbopaneld'; }
tp_daemon_js_fallback_name() { printf 'turbopaneld.js'; }
tp_daemon_binary_path() {
  _home="${1:-$(tp_prod_home)}"
  printf '%s/bin/%s' "$_home" "$(tp_daemon_binary_name)"
}
# Mirrors tp_daemon_js_fallback_path in scripts/lib/release-artifacts.sh — run.sh
# inlines it because CDN bootstrap runs via curl | sh without a checkout to source.
tp_daemon_js_fallback_path() {
  _home="${1:-$(tp_prod_home)}"
  printf '%s/bin/%s' "$_home" "$(tp_daemon_js_fallback_name)"
}

tp_resolve_linux_arch() {
  _machine="$(uname -m)"
  case "$_machine" in
    x86_64) printf 'linux-amd64' ;;
    aarch64 | arm64) printf 'linux-arm64' ;;
    *)
      echo "run.sh: unsupported CPU architecture for daemon updates: $_machine" >&2
      return 1
      ;;
  esac
}

tp_manifest_compact() {
  _json="$1"
  # shellcheck disable=SC2086
  printf '%s' "$_json" | tr -d '[:space:]'
}

tp_manifest_field() {
  _json="$1"
  _field="$2"
  # shellcheck disable=SC2086
  printf '%s' "$_json" | grep -o "\"$_field\":\"[^\"]*\"" | head -1 | sed 's/.*":"//' | tr -d '"'
}

tp_manifest_artifact_field() {
  _json="$1"
  _artifact_key="$2"
  _field="$3"
  # shellcheck disable=SC2086
  _block="$(printf '%s' "$_json" | grep -o "\"$_artifact_key\"[^}]*{[^}]*\"$_field\":\"[^\"]*\"" | head -1)"
  [ -n "$_block" ] || return 1
  printf '%s' "$_block" | grep -o "\"$_field\":\"[^\"]*\"" | sed 's/.*":"//' | tr -d '"'
}

tp_manifest_binary_artifact_field() {
  _json="$1"
  _arch="$2"
  _field="$3"
  # shellcheck disable=SC2086
  _block="$(printf '%s' "$_json" | grep -o "\"$_arch\"[^}]*{[^}]*\"$_field\":\"[^\"]*\"" | head -1)"
  [ -n "$_block" ] || return 1
  printf '%s' "$_block" | grep -o "\"$_field\":\"[^\"]*\"" | sed 's/.*":"//' | tr -d '"'
}

tp_resolve_channel_manifest() {
  _manifest_json="$1"
  _compact="$(tp_manifest_compact "$_manifest_json")"
  _manifest_host="$(tp_manifest_field "$_compact" "defaultControlPlaneUrl")"
  _manifest_commit="$(tp_manifest_field "$_compact" "commit")"
  _manifest_build_id="$(tp_manifest_field "$_compact" "buildId")"
  _linux_arch="$(tp_resolve_linux_arch)" || return 1
  _binary_artifact_url="$(tp_manifest_binary_artifact_field "$_compact" "$_linux_arch" "url")"
  _binary_artifact_sha256="$(tp_manifest_binary_artifact_field "$_compact" "$_linux_arch" "sha256")"
  _js_fallback_artifact_url="$(tp_manifest_artifact_field "$_compact" "jsFallbackArtifact" "url")"
  _js_fallback_artifact_sha256="$(tp_manifest_artifact_field "$_compact" "jsFallbackArtifact" "sha256")"
  _orchestration_artifact_url="$(tp_manifest_artifact_field "$_compact" "orchestrationArtifact" "url")"
  _orchestration_artifact_sha256="$(tp_manifest_artifact_field "$_compact" "orchestrationArtifact" "sha256")"
  if [ -z "$_manifest_host" ]; then
    _manifest_host="https://turbopanel.app"
  fi
  if [ -z "$_binary_artifact_url" ] || [ -z "$_binary_artifact_sha256" ] \
    || [ -z "$_js_fallback_artifact_url" ] || [ -z "$_js_fallback_artifact_sha256" ] \
    || [ -z "$_orchestration_artifact_url" ] || [ -z "$_orchestration_artifact_sha256" ]; then
    return 1
  fi
  return 0
}

tp_extract_tar_zst_archive() {
  _archive="$1"
  _dest_root="$2"
  if ! command -v zstd >/dev/null 2>&1; then
    echo "run.sh: zstd is required" >&2
    return 1
  fi
  mkdir -p "$_dest_root"
  if ! zstd -d -q -c "$_archive" | tar -x -C "$_dest_root"; then
    echo "run.sh: failed to extract $_archive" >&2
    return 1
  fi
  return 0
}

tp_extract_orchestration_release() {
  _archive="$1"
  _dest_root="$2"
  _home="${3:-$(tp_prod_home)}"
  if ! command -v zstd >/dev/null 2>&1; then
    echo "run.sh: zstd is required" >&2
    return 1
  fi
  mkdir -p "$_dest_root"
  if ! zstd -d -q -c "$_archive" | tar -x -C "$_dest_root"; then
    echo "run.sh: failed to extract $_archive" >&2
    return 1
  fi
  if [ ! -f "$_dest_root/$_home/share/orchestration/ansible.cfg" ]; then
    echo "run.sh: orchestration archive missing $_home/share/orchestration/ansible.cfg" >&2
    return 1
  fi
  return 0
}

tp_release_download_url() {
  _url="$1"
  printf '%s' "$_url"
}

tp_download_verified_artifact() {
  _url="$1"
  _sha256="$2"
  _dest="$3"

  case "$_url" in
    https://*) ;;
    *)
      echo "run.sh: release URL must use HTTPS: $_url" >&2
      return 1
      ;;
  esac

  _curl="$(tp_release_curl)"
  _fetch_url="$(tp_release_download_url "$_url")"
  _attempt=1
  _max_attempts=5

  while [ "$_attempt" -le "$_max_attempts" ]; do
    rm -f "$_dest"
    # shellcheck disable=SC2086
    if ! $_curl "$_fetch_url" -o "$_dest"; then
      echo "run.sh: failed to download $_fetch_url" >&2
      return 1
    fi
    if printf '%s  %s\n' "$_sha256" "$_dest" | sha256sum -c - >/dev/null 2>&1; then
      return 0
    fi
    if [ "$_attempt" -lt "$_max_attempts" ]; then
      echo "run.sh: SHA-256 mismatch for $_url (attempt $_attempt/$_max_attempts), retrying…" >&2
      sleep 3
    fi
    _attempt=$((_attempt + 1))
  done

  _actual_sha256="$(sha256sum "$_dest" | awk '{print $1}')"
  echo "run.sh: SHA-256 mismatch for $_url (expected $_sha256, got $_actual_sha256)" >&2
  return 1
}

tp_remove_js_fallback_binaries() {
  _home="$(tp_prod_home)"
  _js="$(tp_daemon_js_fallback_path "$_home")"
  if [ -e "$_js" ]; then
    rm -f "$_js"
  fi
}

tp_install_verified_binary_and_orchestration() {
  _home="$(tp_prod_home)"
  _binary_name="$(tp_daemon_binary_name)"
  _binary_archive=""
  _orchestration_archive=""
  _staging=""

  _cleanup() {
    rm -f "$_binary_archive" "$_orchestration_archive"
    rm -rf "$_staging"
  }
  trap _cleanup EXIT INT HUP TERM

  _binary_archive="$(mktemp)"
  _orchestration_archive="$(mktemp)"
  _staging="$(mktemp -d)"

  if ! tp_download_verified_artifact "$_binary_artifact_url" "$_binary_artifact_sha256" "$_binary_archive"; then
    return 1
  fi
  if ! tp_download_verified_artifact "$_orchestration_artifact_url" "$_orchestration_artifact_sha256" "$_orchestration_archive"; then
    return 1
  fi

  _binary_staging="$_staging/binary"
  _orchestration_staging="$_staging/orchestration"
  mkdir -p "$_binary_staging" "$_orchestration_staging"

  if ! tp_extract_tar_zst_archive "$_binary_archive" "$_binary_staging"; then
    return 1
  fi
  if ! tp_extract_orchestration_release "$_orchestration_archive" "$_orchestration_staging" "$_home"; then
    return 1
  fi

  if [ ! -f "$_binary_staging/$_home/bin/$_binary_name" ] \
    || [ ! -f "$_orchestration_staging/$_home/share/orchestration/ansible.cfg" ]; then
    echo "run.sh: release artifacts missing expected production layout" >&2
    return 1
  fi

  mkdir -p "$_home/bin" "$_home/share/orchestration"
  install -m 0755 "$_binary_staging/$_home/bin/$_binary_name" "$_home/bin/$_binary_name"
  rm -rf "$_home/share/orchestration"
  cp -a "$_orchestration_staging/$_home/share/orchestration" "$_home/share/"
  trap - EXIT INT HUP TERM
  _cleanup
  return 0
}

tp_install_verified_js_fallback() {
  _home="$(tp_prod_home)"
  _js_name="$(tp_daemon_js_fallback_name)"
  _js_archive=""
  _staging=""

  _cleanup() {
    rm -f "$_js_archive"
    rm -rf "$_staging"
  }
  trap _cleanup EXIT INT HUP TERM

  _js_archive="$(mktemp)"
  _staging="$(mktemp -d)"

  if ! tp_download_verified_artifact "$_js_fallback_artifact_url" "$_js_fallback_artifact_sha256" "$_js_archive"; then
    return 1
  fi

  if ! tp_extract_tar_zst_archive "$_js_archive" "$_staging"; then
    return 1
  fi

  if [ ! -f "$_staging/$_home/bin/$_js_name" ]; then
    echo "run.sh: Deno JS runtime release missing $_home/bin/$_js_name" >&2
    return 1
  fi

  mkdir -p "$_home/bin"
  install -m 0644 "$_staging/$_home/bin/$_js_name" "$_home/bin/$_js_name"
  trap - EXIT INT HUP TERM
  _cleanup
  return 0
}

tp_is_root() { [ "$(id -u)" = "0" ]; }
tp_is_interactive() {
  if [ -t 0 ]; then
    return 0
  fi
  [ -r /dev/tty ] && [ -w /dev/tty ] 2>/dev/null
}
tp_sudo_installed() { command -v sudo >/dev/null 2>&1; }
tp_validate_sudo() {
  if ! tp_sudo_installed; then
    return 2
  fi
  if sudo -n true 2>/dev/null; then
    return 0
  fi
  if tp_is_interactive && sudo -v 2>/dev/null; then
    return 0
  fi
  return 1
}
tp_install_privilege_denied() {
  _reason="${1:-}"
  case "$_reason" in
  no_sudo)
    tp_print_error "run as root (su -); sudo is not installed yet — the daemon installer will install it"
    ;;
  sudo_failed)
    tp_print_error "sudo validation failed — run as root or enter a valid sudo password"
    ;;
  *)
    tp_print_error "must run as root or have sudo privileges"
    ;;
  esac
  exit 1
}

tp_print_step() {
  _glyph="$1"; _msg="$2"
  if [ -t 1 ]; then
    printf '\033[36m%s\033[0m %s\n' "$_glyph" "$_msg"
  else
    printf '%s %s\n' "$_glyph" "$_msg"
  fi
}

tp_print_ok() {
  _msg="$1"
  if [ -t 1 ]; then
    printf '\033[32m✓\033[0m %s\n' "$_msg"
  else
    printf '✓ %s\n' "$_msg"
  fi
}

tp_print_error() {
  _msg="$1"
  if [ -t 2 ]; then
    printf '\033[31m✗\033[0m %s\n' "$_msg" >&2
  else
    printf '✗ %s\n' "$_msg" >&2
  fi
}

DAEMON_SERVICE_NAME="turbopaneld.service"

# Stop the running daemon before replacing release binaries on manual reconcile.
# Skipped for --no-start (in-process UI update): that path must not stop the
# caller; the daemon chdirs away and restarts itself after run.sh completes.
tp_stop_running_daemon_for_release_swap() {
  if [ "$NO_START" = true ]; then
    return 0
  fi
  if ! command -v systemctl >/dev/null 2>&1; then
    return 0
  fi
  if ! systemctl cat "$DAEMON_SERVICE_NAME" >/dev/null 2>&1; then
    return 0
  fi
  if ! systemctl is-active --quiet "$DAEMON_SERVICE_NAME" 2>/dev/null; then
    return 0
  fi
  tp_print_step "▸" "Stopping $DAEMON_SERVICE_NAME for release update…"
  if ! systemctl stop "$DAEMON_SERVICE_NAME"; then
    tp_print_error "Failed to stop $DAEMON_SERVICE_NAME"
    exit 1
  fi
  tp_print_ok "Daemon stopped ($DAEMON_SERVICE_NAME)"
}

tp_start_or_restart_daemon() {
  if [ "$NO_START" = true ]; then
    return 0
  fi
  if ! command -v systemctl >/dev/null 2>&1; then
    return 0
  fi
  if ! systemctl cat "$DAEMON_SERVICE_NAME" >/dev/null 2>&1; then
    return 0
  fi
  tp_print_step "▸" "Starting $DAEMON_SERVICE_NAME…"
  if ! systemctl enable --now "$DAEMON_SERVICE_NAME"; then
    tp_print_error "Failed to enable/start $DAEMON_SERVICE_NAME"
    exit 1
  fi
  tp_print_ok "Daemon running"
}

# Probe whether the native release binary can execute a trivial subcommand.
# Records DAEMON_EXEC_MODE=native|js for the systemd unit template.
tp_probe_native_daemon() {
  _bin="$(tp_daemon_binary_path)"
  if [ ! -x "$_bin" ]; then
    return 1
  fi
  if "$_bin" --version >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

# Host-local carry-over for release swaps lives under FHS paths (not the old
# platform/daemon checkout). Keep this list in sync with HOST_LOCAL_ARTIFACTS
# in src/dev-sync-apply.ts — identity/config are under /var/lib and /etc, so
# only checkout leftovers that may still appear under a source tree remain.
# shellcheck disable=SC2034
TP_HOST_LOCAL_ARTIFACTS=".git .github logs cloudflared"

# Keep in sync with orchestration/roles/deno-runtime/defaults/main.yml.
TP_DENO_VERSION="2.9.4"

# Install Deno into the runtimes tree (idempotent), mirroring uv/ansible/cloudflared:
#   $RUNTIMES_DIR/deno/$TP_DENO_VERSION/deno  plus `current` and `bin/deno` symlinks.
# Keep the download/extract path in sync with orchestration/roles/deno-runtime/tasks/main.yml
# (dl.deno.land release zip + python3 stdlib — host-base only guarantees python3, not unzip).
tp_install_deno_runtime() {
  _deno_versioned_dir="$RUNTIMES_DIR/deno/$TP_DENO_VERSION"
  _deno_bin="$_deno_versioned_dir/deno"
  if [ ! -x "$_deno_bin" ]; then
    case "$(uname -m)" in
    aarch64 | arm64) _deno_arch="aarch64-unknown-linux-gnu" ;;
    x86_64 | amd64) _deno_arch="x86_64-unknown-linux-gnu" ;;
    *)
      tp_print_error "Unsupported architecture for Deno: $(uname -m)"
      return 1
      ;;
    esac
    _deno_asset="deno-${_deno_arch}.zip"
    _deno_url="https://dl.deno.land/release/v${TP_DENO_VERSION}/${_deno_asset}"
    _deno_tmp="$(mktemp -d)"
    _curl="$(tp_release_curl)"
    # shellcheck disable=SC2086
    if ! $_curl -o "$_deno_tmp/$_deno_asset" "$_deno_url" 2>"$_deno_tmp/curl.err"; then
      tp_print_error "Failed to download Deno from $_deno_url"
      [ -s "$_deno_tmp/curl.err" ] && cat "$_deno_tmp/curl.err" >&2
      rm -rf "$_deno_tmp"
      return 1
    fi
    mkdir -p "$_deno_versioned_dir"
    if ! python3 - "$_deno_tmp/$_deno_asset" "$_deno_bin" 2>"$_deno_tmp/python.err" <<'PY'
import shutil, sys, tempfile, zipfile
from pathlib import Path

archive, dest = Path(sys.argv[1]), Path(sys.argv[2])
dest.parent.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix="deno-zip-") as tmp:
    tmp_path = Path(tmp)
    with zipfile.ZipFile(archive) as zf:
        zf.extractall(tmp_path)
    candidates = list(tmp_path.rglob("deno"))
    if not candidates:
        raise SystemExit("deno binary not found in release zip")
    shutil.copy2(candidates[0], dest)
dest.chmod(0o755)
PY
    then
      tp_print_error "Failed to extract Deno release zip"
      [ -s "$_deno_tmp/python.err" ] && cat "$_deno_tmp/python.err" >&2
      rm -rf "$_deno_tmp"
      return 1
    fi
    rm -rf "$_deno_tmp"
  fi
  # Always restore stable symlinks (repair/retry may leave them drifted).
  ln -sfn "$TP_DENO_VERSION" "$RUNTIMES_DIR/deno/current"
  # Stable path for the JS-fallback systemd ExecStart (next phase).
  mkdir -p "$RUNTIMES_DIR/deno/bin"
  ln -sfn "../current/deno" "$RUNTIMES_DIR/deno/bin/deno"
}

tp_fetch_channel_manifest() {
  _channel="${TURBOPANEL_UPDATE_CHANNEL:-trunk}"
  _curl="$(tp_release_curl)"

  _channels_json=""
  if ! _channels_json="$($_curl "https://dl.trbp.nl/channels.json" 2>/dev/null)"; then
    return 1
  fi

  _channels_oneline="$(tp_manifest_compact "$_channels_json")"
  _manifest_url="$(printf '%s' "$_channels_oneline" | grep -o "\"${_channel}\"[^}]*manifestUrl\":\"[^\"]*\"" | sed 's/.*manifestUrl":"//' | tr -d '"')"
  if [ -z "$_manifest_url" ]; then
    return 1
  fi

  _manifest_json=""
  if ! _manifest_json="$($_curl "${_manifest_url}?$(date +%s)" 2>/dev/null)"; then
    return 1
  fi

  if ! tp_resolve_channel_manifest "$_manifest_json"; then
    return 1
  fi

  return 0
}

set -eu

tp_print_header() {
  if [ -t 1 ]; then
    printf '\n'
    printf '  ╭─────────────────────────────────────────╮\n'
    printf '  │  ⚡ TurboPanel  ·  Daemon Installer     │\n'
    printf '  ╰─────────────────────────────────────────╯\n'
    printf '\n'
  else
    printf 'TurboPanel Daemon Installer\n'
  fi
}

LICENSE=""
HOST_URL=""
INSTANCE_CA=""
TUNNEL_TOKEN=""
INSECURE_TLS=false
NO_START=false

while [ $# -gt 0 ]; do
  case "$1" in
    --license)
      [ $# -ge 2 ] || { tp_print_error "--license requires an argument"; exit 1; }
      LICENSE="$2"; shift 2 ;;
    --host)
      [ $# -ge 2 ] || { tp_print_error "--host requires an argument"; exit 1; }
      HOST_URL="$2"; shift 2 ;;
    --instance-ca)
      [ $# -ge 2 ] || { tp_print_error "--instance-ca requires an argument"; exit 1; }
      INSTANCE_CA="$2"; shift 2 ;;
    --tunnel-token)
      [ $# -ge 2 ] || { tp_print_error "--tunnel-token requires an argument"; exit 1; }
      TUNNEL_TOKEN="$2"; shift 2 ;;
    --insecure-tls)
      INSECURE_TLS=true; shift ;;
    --no-start)
      NO_START=true; shift ;;
    --channel)
      [ $# -ge 2 ] || { tp_print_error "--channel requires an argument"; exit 1; }
      export TURBOPANEL_UPDATE_CHANNEL="$2"; shift 2 ;;
    *)
      tp_print_error "unknown option: $1"; exit 1 ;;
  esac
done

# Piped install form prefers env vars so the copy-paste command stays clean:
#   curl -fsSL turbopanel.sh/run.sh | TURBOPANEL_LICENSE=… sh
# Explicit flags win when both are set (sudo re-exec always uses flags).
[ -n "$LICENSE" ] || LICENSE="${TURBOPANEL_LICENSE:-}"
[ -n "$HOST_URL" ] || HOST_URL="${TURBOPANEL_HOST:-}"
case "${TURBOPANEL_INSECURE_TLS:-}" in
  1|true|TRUE|yes|YES) INSECURE_TLS=true ;;
  *)
    # Leave INSECURE_TLS unchanged (may already be set by --insecure-tls).
    ;;
esac

if [ -z "$LICENSE" ]; then
  tp_print_error "TURBOPANEL_LICENSE (or --license) is required"
  exit 1
fi

_padded="$LICENSE"
while [ $(( ${#_padded} % 4 )) -ne 0 ]; do
  _padded="${_padded}="
done
_decoded="$(printf '%s' "$_padded" | tr -- '-_' '+/' | base64 -d 2>/dev/null)" || {
  tp_print_error "invalid --license format; expected base64url-encoded id:token"
  exit 1
}
LICENSE_ID="$(echo "$_decoded" | cut -d: -f1)"
LICENSE_TOKEN="$(echo "$_decoded" | cut -d: -f2-)"
if [ -z "$LICENSE_ID" ] || [ -z "$LICENSE_TOKEN" ]; then
  tp_print_error "invalid --license format; expected base64url-encoded id:token"
  exit 1
fi

if ! tp_is_root; then
  _sudo_rc=0
  tp_validate_sudo || _sudo_rc=$?
  if [ "$_sudo_rc" -eq 2 ]; then
    tp_install_privilege_denied no_sudo
  fi
  if [ "$_sudo_rc" -ne 0 ]; then
    tp_install_privilege_denied sudo_failed
  fi
  if [ -n "$HOST_URL" ]; then
    _REEXEC_SCRIPT_URL="${HOST_URL%/}/run.sh"
  else
    _REEXEC_SCRIPT_URL="https://turbopanel.sh/run.sh"
  fi
  set -- --license "$LICENSE"
  [ -n "$HOST_URL" ] && set -- "$@" --host "$HOST_URL"
  [ -n "$INSTANCE_CA" ] && set -- "$@" --instance-ca "$INSTANCE_CA"
  [ -n "$TUNNEL_TOKEN" ] && set -- "$@" --tunnel-token "$TUNNEL_TOKEN"
  [ "$INSECURE_TLS" = true ] && set -- "$@" --insecure-tls
  [ "$NO_START" = true ] && set -- "$@" --no-start
  [ -n "${TURBOPANEL_UPDATE_CHANNEL:-}" ] && set -- "$@" --channel "$TURBOPANEL_UPDATE_CHANNEL"
  _curl="$TP_CURL_FETCH"
  [ "$INSECURE_TLS" = true ] && _curl="$TP_CURL_FETCH_INSECURE"
  # Re-run the script under sudo. `exec` cannot be used here: in a pipeline
  # each command runs in its own subshell, so `exec` would only replace the
  # curl subshell, not this shell — leaving the original non-root shell to
  # fall through and fail on the privileged mkdir calls below. Run the
  # pipeline, then exit with its status so the parent shell never continues.
  # shellcheck disable=SC2086
  $_curl "$_REEXEC_SCRIPT_URL" | sudo sh -s -- "$@"
  exit $?
fi

tp_print_header

INSTALL_ROOT="/opt/turbopanel"
BIN_DIR="$INSTALL_ROOT/bin"
ORCHESTRATION_DIR="$INSTALL_ROOT/share/orchestration"
RUNTIMES_DIR="$INSTALL_ROOT/vendor"
CONFIG_DIR="/etc/turbopanel"
STATE_DIR="/var/lib/turbopanel"
RUN_DIR="/run/turbopanel"
ENV_FILE="$CONFIG_DIR/daemon.env"
CA_PATH="$CONFIG_DIR/instance-ca.pem"
LICENSE_STAGING_DIR="$STATE_DIR/daemon-license-staging"

# NOTE: `--insecure-tls` (INSECURE_TLS) deliberately does NOT export any
# release-insecure flag. It only relaxes trust for the self-hosted instance
# bootstrap legs below (the run.sh re-exec above and the instance CA fetch).
# Release/CDN downloads stay TLS-verified via tp_release_curl(); the only way to
# relax them is the undocumented operator-only TURBOPANEL_RELEASE_TLS_INSECURE_OVERRIDE.

mkdir -p "$STATE_DIR" "$CONFIG_DIR" "$BIN_DIR" "$INSTALL_ROOT/share" "$RUN_DIR"
STAGING_DIR="$LICENSE_STAGING_DIR"
mkdir -p "$STAGING_DIR"
printf '%s' "$LICENSE_ID" > "$STAGING_DIR/license.id"
printf '%s' "$LICENSE_TOKEN" > "$STAGING_DIR/license.token"
chmod 0640 "$STAGING_DIR/license.id" "$STAGING_DIR/license.token"

export DEBIAN_FRONTEND=noninteractive
tp_print_step "▸" "Checking host prerequisites…"
# Host-base boundary (not TurboPanel-managed vendors): tools required to
# download/extract release artifacts and bootstrap vendor. Vendor runtimes
# (uv, Deno, Node, Caddy, Redis, …) are installed by orchestration — never via
# apt in run.sh.
_tp_host_missing=""
for _tp_host_cmd in sudo curl tar python3; do
  if ! command -v "$_tp_host_cmd" >/dev/null 2>&1; then
    _tp_host_missing="$_tp_host_missing $_tp_host_cmd"
  fi
done
_tp_host_prereq_fail() {
  _msg="$1"
  tp_print_error "$_msg"
  cat "$_apt_log" >&2
  rm -f "$_apt_log"
  exit 1
}
_apt_log="$(mktemp)"
if [ -n "$_tp_host_missing" ] \
  && { ! apt-get update -qq >>"$_apt_log" 2>&1 \
    || ! apt-get install -y -qq sudo curl ca-certificates tar python3-minimal >>"$_apt_log" 2>&1; }; then
  _tp_host_prereq_fail "host prerequisites failed (need:${_tp_host_missing})"
fi
if ! command -v curl >/dev/null 2>&1 || ! command -v tar >/dev/null 2>&1 \
  || ! command -v python3 >/dev/null 2>&1; then
  _tp_host_prereq_fail "host prerequisites missing after install (need curl tar python3)"
fi
rm -f "$_apt_log"
tp_print_ok "Host prerequisites ready"

tp_print_step "▸" "Fetching release manifest…"
if ! tp_fetch_channel_manifest; then
  tp_print_error "Failed to fetch release manifest"
  exit 1
fi
if [ -z "$HOST_URL" ]; then
  HOST_URL="$_manifest_host"
fi
tp_print_ok "Release manifest resolved (channel ${TURBOPANEL_UPDATE_CHANNEL:-trunk}, arch ${_linux_arch:-unknown})"
tp_print_step "  " "Binary (${_linux_arch:-unknown}): $_binary_artifact_url"
tp_print_step "  " "JS bundle (if needed): $_js_fallback_artifact_url"
tp_print_step "  " "Commit: ${_manifest_commit:-unknown}"
tp_print_step "  " "Control plane: $HOST_URL"

mkdir -p "$CONFIG_DIR"
if [ -n "$INSTANCE_CA" ]; then
  # Compare resolved paths, not raw strings: a symlink or path-variant (e.g. a
  # trailing slash or relative form) pointing at the canonical CA otherwise
  # slips past a string-only check and makes `install` fail with
  # "are the same file". Resolve both sides before deciding to copy.
  _ca_src_resolved="$(readlink -f "$INSTANCE_CA" 2>/dev/null || echo "$INSTANCE_CA")"
  _ca_dst_resolved="$(readlink -f "$CA_PATH" 2>/dev/null || echo "$CA_PATH")"
  if [ "$_ca_src_resolved" != "$_ca_dst_resolved" ]; then
    install -m 0640 "$INSTANCE_CA" "$CA_PATH"
  fi
else
  case "$HOST_URL" in
    http://*)
      tp_print_step "–" "No platform CA (plaintext control plane — TLS not used)"
      ;;
    *)
      tp_print_step "▸" "Fetching instance CA…"
      _curl_base="curl -sSL"
      [ "$INSECURE_TLS" = true ] && _curl_base="curl -sSLk"
      if [ "$INSECURE_TLS" != true ] && [ -f "$CA_PATH" ]; then
        _curl_base="curl -sSL --cacert $CA_PATH"
      fi
      _ca_tmp="$(mktemp)"
      _ca_http_code=""
      # shellcheck disable=SC2086
      _ca_http_code=$($_curl_base -o "$_ca_tmp" -w '%{http_code}' "${HOST_URL%/}/api/daemon/v1/instance/ca" || echo "000")
      case "$_ca_http_code" in
        200)
          install -m 0640 "$_ca_tmp" "$CA_PATH"
          tp_print_ok "Instance CA downloaded"
          ;;
        404)
          # Workers production and other publicly-trusted control planes have no
          # platform CA — the daemon uses the system trust store instead.
          tp_print_step "–" "No platform CA (public TLS — using system trust store)"
          rm -f "$CA_PATH"
          ;;
        *)
          tp_print_step "~" "Could not download instance CA (HTTP ${_ca_http_code}) — keeping existing CA if present"
          ;;
      esac
      rm -f "$_ca_tmp"
      ;;
  esac
fi

# Production FHS layout — never point TURBOPANEL_DAEMON_ROOT at a source
# checkout or detectInstallMode() may classify this managed install as dev.
export TURBOPANEL_RUNTIMES_DIR="$RUNTIMES_DIR"
export TURBOPANEL_ORCHESTRATION_DIR="$ORCHESTRATION_DIR"
export TURBOPANEL_CONFIG_DIR="$CONFIG_DIR"
export TURBOPANEL_STATE_DIR="$STATE_DIR"
export TURBOPANEL_DAEMON_STATE_DIR="$STATE_DIR"
export TURBOPANEL_RUN_DIR="$RUN_DIR"

tp_print_step "▸" "Downloading daemon release…"
tp_stop_running_daemon_for_release_swap

if ! tp_install_verified_binary_and_orchestration; then
  tp_print_error "Failed to install daemon release artifacts"
  exit 1
fi

if [ ! -x "$(tp_daemon_binary_path)" ]; then
  tp_print_error "Daemon release missing native binary at $(tp_daemon_binary_path)"
  exit 1
fi
if [ ! -f "$ORCHESTRATION_DIR/ansible.cfg" ]; then
  tp_print_error "Daemon release missing orchestration tree at $ORCHESTRATION_DIR"
  exit 1
fi
tp_print_ok "Release installed (SHA-256 ok)"

tp_print_step "▸" "Probing native daemon binary…"
if tp_probe_native_daemon; then
  DAEMON_EXEC_MODE="native"
  tp_print_ok "Native binary is executable — using turbopaneld"
  tp_remove_js_fallback_binaries
else
  DAEMON_EXEC_MODE="js"
  tp_print_step "~" "Native binary not executable on this host — using Deno JS runtime (turbopaneld.js)"
  tp_print_step "▸" "Downloading Deno JS runtime bundle…"
  if ! tp_install_verified_js_fallback; then
    tp_print_error "Failed to install Deno JS runtime bundle"
    exit 1
  fi
  if [ ! -f "$BIN_DIR/$(tp_daemon_js_fallback_name)" ]; then
    tp_print_error "Daemon release missing turbopaneld.js at $BIN_DIR/$(tp_daemon_js_fallback_name)"
    exit 1
  fi
  tp_print_ok "Deno JS runtime installed"
fi

if [ "$DAEMON_EXEC_MODE" = "js" ]; then
  tp_print_step "▸" "Installing Deno runtime…"
  if ! tp_install_deno_runtime; then
    tp_print_error "Failed to install Deno runtime"
    exit 1
  fi
  DENO_BIN="$RUNTIMES_DIR/deno/bin/deno"
  tp_print_ok "Deno ${TP_DENO_VERSION} ready"
else
  tp_print_step "–" "Skipping Deno runtime (native binary)"
fi

if [ "$DAEMON_EXEC_MODE" = "native" ]; then
  "$(tp_daemon_binary_path)" bootstrap-orchestration
else
  HOME="$INSTALL_ROOT" "$DENO_BIN" run --allow-all "$(tp_daemon_js_fallback_path)" bootstrap-orchestration
  # Warm the JS module cache so first start is fast/offline.
  HOME="$INSTALL_ROOT" "$DENO_BIN" cache "$(tp_daemon_js_fallback_path)" >/dev/null 2>&1 || true
fi

if [ ! -f "$ORCHESTRATION_DIR/ansible.cfg" ]; then
  tp_print_error "Bootstrap did not leave orchestration/ansible.cfg in place"
  exit 1
fi

VARS_FILE="$(mktemp)"
trap 'rm -f "$VARS_FILE"' EXIT
{
  printf 'turbopanel_instance_url: %s\n' "$HOST_URL"
  printf 'turbopanel_start: %s\n' "$([ "$NO_START" = true ] && echo false || echo true)"
  printf 'turbopanel_manage_service_state: %s\n' "$([ "$NO_START" = true ] && echo false || echo true)"
  printf 'turbopanel_restart_daemon: %s\n' "$([ "$NO_START" = true ] && echo false || echo true)"
  printf 'turbopanel_daemon_exec_mode: %s\n' "$DAEMON_EXEC_MODE"
  printf 'turbopanel_vendor_dir: %s\n' "$RUNTIMES_DIR"
  printf 'turbopanel_orchestration_dir: %s\n' "$ORCHESTRATION_DIR"
  printf 'turbopanel_config_dir: %s\n' "$CONFIG_DIR"
  printf 'turbopanel_daemon_state_dir: %s\n' "$STATE_DIR"
  printf 'turbopanel_daemon_env_file: %s\n' "$ENV_FILE"
  printf 'turbopanel_daemon_bin: %s\n' "$(tp_daemon_binary_path)"
  printf 'turbopanel_daemon_js: %s\n' "$(tp_daemon_js_fallback_path)"
  printf 'turbopanel_daemon_workdir: %s\n' "$INSTALL_ROOT"
  if [ "$DAEMON_EXEC_MODE" = "js" ]; then
    printf 'turbopanel_daemon_deno_bin: %s\n' "$DENO_BIN"
  fi
  printf 'turbopanel_service_name: %s\n' "turbopaneld"
  case "$HOST_URL" in
    http://*) ;;
    *)
      if [ -f "$CA_PATH" ]; then
        printf 'turbopanel_instance_ca: %s\n' "$CA_PATH"
      fi
      ;;
  esac
  printf 'turbopanel_update_channel: %s\n' "${TURBOPANEL_UPDATE_CHANNEL:-trunk}"
  if [ -n "$TUNNEL_TOKEN" ]; then
    printf 'turbopanel_tunnel_token: %s\n' "$TUNNEL_TOKEN"
  fi
} > "$VARS_FILE"

if [ "$DAEMON_EXEC_MODE" = "native" ]; then
  if ! "$(tp_daemon_binary_path)" run-installer --vars-file "$VARS_FILE"; then
    rm -rf /tmp/turbopanel-ansible /root/.ansible
    exit 1
  fi
else
  if ! HOME="$INSTALL_ROOT" "$DENO_BIN" run --allow-all "$(tp_daemon_js_fallback_path)" run-installer --vars-file "$VARS_FILE"; then
    rm -rf /tmp/turbopanel-ansible /root/.ansible
    exit 1
  fi
fi
# Disposable ansible scratch (ANSIBLE_HOME); roles/collections already live under FHS.
rm -rf /tmp/turbopanel-ansible /root/.ansible

# Plaintext --host http://… installs must opt into TURBOPANEL_DEV_HTTP_CONTROL_PLANE
# or the daemon refuses to start (resolveInstanceConfig). daemon-config dotenv.j2
# is the only writer — validate rather than patching daemon.env outside Ansible.
tp_assert_dev_http_control_plane_env() {
  _env_file="$1"
  _host_url="$2"
  case "$_host_url" in
    http://*)
      ;;
    *)
      return 0
      ;;
  esac
  if [ ! -f "$_env_file" ]; then
    tp_print_error "daemon env missing after install: $_env_file"
    return 1
  fi
  if grep -q '^TURBOPANEL_DEV_HTTP_CONTROL_PLANE=1$' "$_env_file" 2>/dev/null; then
    return 0
  fi
  tp_print_error "http:// control plane requires TURBOPANEL_DEV_HTTP_CONTROL_PLANE=1 in $_env_file (written by daemon-config dotenv.j2; older orchestration bundles are unsupported)"
  return 1
}
if ! tp_assert_dev_http_control_plane_env "$ENV_FILE" "$HOST_URL"; then
  exit 1
fi
