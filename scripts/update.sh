#!/bin/sh
# TurboPanel daemon update — manual refresh for an already-installed node.
#
# This script is NOT served from trbp.nl (unlike run.sh). It is installed into
# the managed FHS tree at /opt/turbopanel/bin/turbopanel-update by run.sh and
# reads license + channel from the FHS state/config directories — no daemon
# source checkout required.
#
# Usage:
#   sudo sh /opt/turbopanel/bin/turbopanel-update
#   sudo sh /opt/turbopanel/bin/turbopanel-update --channel trunk
#
# Must run as root (or via sudo). It downloads the latest run.sh from trbp.nl.

set -eu

INSTALL_ROOT="/opt/turbopanel"
STATE_DIR="/var/lib/turbopanel"
CONFIG_DIR="/etc/turbopanel"
ENV_FILE="$CONFIG_DIR/daemon.env"
CA_PATH="$CONFIG_DIR/instance-ca.pem"
LICENSE_ID_FILE="$STATE_DIR/license.id"
LICENSE_TOKEN_FILE="$STATE_DIR/license.token"
UPDATE_SH="$INSTALL_ROOT/bin/turbopanel-update"

CURL_MAX_TIME="${TURBOPANEL_CURL_MAX_TIME:-300}"
CDN_RUN_SCRIPT="https://trbp.nl/run.sh"
PRODUCTION_CONTROL_PLANE="https://turbopanel.app"

VALID_CHANNELS="trunk edge canary rc release"

tp_is_root() { [ "$(id -u)" = "0" ]; }

tp_curl() {
	_curl="curl -fsSL --max-time $CURL_MAX_TIME"
	[ "${INSECURE_TLS:-false}" = true ] && _curl="curl -fsSLk --max-time $CURL_MAX_TIME"
	# shellcheck disable=SC2086
	$_curl "$@"
}

tp_print_step() {
	_glyph="$1"; _msg="$2"
	if [ -t 1 ]; then printf '\033[36m%s\033[0m %s\n' "$_glyph" "$_msg"
	else printf '%s %s\n' "$_glyph" "$_msg"; fi
}
tp_print_ok() {
	_msg="$1"
	if [ -t 1 ]; then printf '\033[32m✓\033[0m %s\n' "$_msg"
	else printf '✓ %s\n' "$_msg"; fi
}
tp_print_error() {
	_msg="$1"
	if [ -t 2 ]; then printf '\033[31m✗\033[0m %s\n' "$_msg" >&2
	else printf '✗ %s\n' "$_msg" >&2; fi
}

tp_print_header() {
	if [ -t 1 ]; then
		printf '\n'
		printf '  ╭─────────────────────────────────────────╮\n'
		printf '  │  ⚡ TurboPanel  ·  Daemon Update        │\n'
		printf '  ╰─────────────────────────────────────────╯\n'
		printf '\n'
	else
		printf 'TurboPanel Daemon Update\n'
	fi
}

tp_channel_valid() {
	_ch="$1"
	for _valid in $VALID_CHANNELS; do
		if [ "$_ch" = "$_valid" ]; then return 0; fi
	done
	return 1
}

tp_read_dotenv() {
	_key="$1"
	_file="$2"
	[ -f "$_file" ] || return 1
	_line=""
	_line="$(grep -E "^${_key}=" "$_file" 2>/dev/null | tail -1)" || return 1
	_val="${_line#*=}"
	case "$_val" in
		\"*) _val="${_val#\"}"; _val="${_val%\"}" ;;
		\'*) _val="${_val#\'}"; _val="${_val%\'}" ;;
	esac
	[ -n "$_val" ] || return 1
	printf '%s' "$_val"
}

tp_encode_license_b64url() {
	_id="$1"
	_tok="$2"
	printf '%s:%s' "$_id" "$_tok" | base64 | tr '+/' '-_' | tr -d '=\n'
}

tp_usage() {
	cat <<EOF
Usage: turbopanel-update [options]

Manual refresh for an installed TurboPanel daemon. Not a CDN entrypoint —
run the installed helper on the server:

  sudo sh $UPDATE_SH

Options:
  --channel <name>   Update channel (default: read from daemon.env, else trunk)
                     Valid: $VALID_CHANNELS
  --license <b64>    Base64url license (skip reading state files)
  --host <URL>       Instance URL (default: read from daemon.env; omit for production)
  --insecure-tls     curl -k for bootstrap downloads only
  --dry-run          Print the command that would run, then exit
  -h, --help         Show this help
EOF
}

CHANNEL=""
LICENSE=""
HOST_URL=""
INSTANCE_CA=""
INSECURE_TLS=false
DRY_RUN=false

while [ $# -gt 0 ]; do
	case "$1" in
		--channel)
			[ $# -ge 2 ] || { tp_print_error "--channel requires an argument"; exit 1; }
			CHANNEL="$2"; shift 2 ;;
		--license)
			[ $# -ge 2 ] || { tp_print_error "--license requires an argument"; exit 1; }
			LICENSE="$2"; shift 2 ;;
		--host)
			[ $# -ge 2 ] || { tp_print_error "--host requires an argument"; exit 1; }
			HOST_URL="$2"; shift 2 ;;
		--insecure-tls)
			INSECURE_TLS=true; shift ;;
		--dry-run)
			DRY_RUN=true; shift ;;
		-h|--help)
			tp_usage
			exit 0 ;;
		*)
			tp_print_error "unknown option: $1"
			tp_usage >&2
			exit 1 ;;
	esac
done

if ! tp_is_root; then
	tp_print_error "must run as root"
	tp_print_error "  sudo sh $UPDATE_SH"
	exit 1
fi

tp_print_header

if [ -z "$CHANNEL" ]; then
	CHANNEL="$(tp_read_dotenv TURBOPANEL_UPDATE_CHANNEL "$ENV_FILE" 2>/dev/null)" || CHANNEL="trunk"
fi
if ! tp_channel_valid "$CHANNEL"; then
	tp_print_error "invalid channel: $CHANNEL (valid: $VALID_CHANNELS)"
	exit 1
fi
export TURBOPANEL_UPDATE_CHANNEL="$CHANNEL"

if [ -z "$HOST_URL" ]; then
	HOST_URL="$(tp_read_dotenv TURBOPANEL_INSTANCE_URL "$ENV_FILE" 2>/dev/null)" || HOST_URL=""
fi

INSTANCE_CA="$(tp_read_dotenv TURBOPANEL_INSTANCE_CA "$ENV_FILE" 2>/dev/null)" || INSTANCE_CA=""
# Drop stale pre-FHS CA paths; fall back to the canonical FHS location.
if [ -n "$INSTANCE_CA" ] && [ ! -f "$INSTANCE_CA" ]; then
	INSTANCE_CA=""
fi
if [ -z "$INSTANCE_CA" ] && [ -f "$CA_PATH" ]; then
	INSTANCE_CA="$CA_PATH"
fi

if [ -z "$LICENSE" ]; then
	if [ ! -f "$LICENSE_ID_FILE" ] || [ ! -f "$LICENSE_TOKEN_FILE" ]; then
		tp_print_error "license not found in $STATE_DIR"
		tp_print_error "pass --license <base64url> or create a new license in the TurboPanel UI"
		exit 1
	fi
	_license_id="$(cat "$LICENSE_ID_FILE" | tr -d '[:space:]')"
	_license_token="$(cat "$LICENSE_TOKEN_FILE" | tr -d '[:space:]')"
	if [ -z "$_license_id" ] || [ -z "$_license_token" ]; then
		tp_print_error "license files in $STATE_DIR are empty"
		exit 1
	fi
	LICENSE="$(tp_encode_license_b64url "$_license_id" "$_license_token")"
fi

tp_print_step "▸" "Update channel: $CHANNEL"
if [ -n "$HOST_URL" ]; then
	tp_print_step "▸" "Control plane: $HOST_URL"
else
	tp_print_step "▸" "Control plane: $PRODUCTION_CONTROL_PLANE (from channel manifest)"
fi
tp_print_step "▸" "License: loaded from state directory"
tp_print_step "▸" "Installer: $CDN_RUN_SCRIPT"

RUN_ARGS="--license $LICENSE --channel $CHANNEL"
if [ -n "$HOST_URL" ]; then
	case "$HOST_URL" in
		"$PRODUCTION_CONTROL_PLANE"|"${PRODUCTION_CONTROL_PLANE}/")
			;;
		*)
			RUN_ARGS="$RUN_ARGS --host $HOST_URL"
			;;
	esac
fi
if [ -n "$INSTANCE_CA" ] && [ "$INSTANCE_CA" != "$CA_PATH" ]; then
	RUN_ARGS="$RUN_ARGS --instance-ca $INSTANCE_CA"
fi
[ "$INSECURE_TLS" = true ] && RUN_ARGS="$RUN_ARGS --insecure-tls"

if [ "$DRY_RUN" = true ]; then
	tp_print_ok "Dry run — would execute:"
	printf '  curl -fsSL --max-time %s %s | sh -s -- %s\n' "$CURL_MAX_TIME" "$CDN_RUN_SCRIPT" "$RUN_ARGS"
	exit 0
fi

tp_print_step "▸" "Downloading latest installer and refreshing daemon…"
# shellcheck disable=SC2086
set -- $RUN_ARGS
if ! tp_curl "$CDN_RUN_SCRIPT" | sh -s -- "$@"; then
	tp_print_error "Daemon update failed"
	exit 1
fi

tp_print_ok "Daemon update complete (channel $CHANNEL)"
