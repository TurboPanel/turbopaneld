#!/bin/sh
# installer-screen-demo.sh - a simulated install that drives the installer screen.
#
# MOCKUP: nothing here touches the host. Every "step" is a short sleep and a fake
# line sent to the log file, so the screen can be looked at and recorded.
#
#   sh scripts/installer-screen-demo.sh --mode daemon
#   sh scripts/installer-screen-demo.sh --mode panel
#   sh scripts/installer-screen-demo.sh --mode panel --fail-at 5
#
# Options
#   --mode daemon|panel   daemon (enrol a server) or panel (self-hosted control plane)
#   --fail-at <n>         fail area n to show the failure state
#   --fast                no pauses (tests, frame capture)
#   --version <v>         version shown in the header (default 1.8.2)
#   --channel <name>      channel shown in the header (default release)
#   --log <file>          log file (default: a new file under $TMPDIR)
#
# SCREEN_FORCE_TTY=1, SCREEN_COLS, SCREEN_UNICODE and SCREEN_FIXED_CLOCK are
# described in lib/installer-screen.sh.

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/lib/installer-screen.sh"

MODE=daemon
FAIL_AT=0
FAST=0
VERSION=1.8.2
CHANNEL=release
LOG="${TMPDIR:-/tmp}/turbopanel-installer-demo.$$.log"

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case $1 in
    --mode)
      [ $# -ge 2 ] || usage 2
      MODE=$2
      shift 2
      ;;
    --fail-at)
      [ $# -ge 2 ] || usage 2
      FAIL_AT=$2
      shift 2
      ;;
    --fast)
      FAST=1
      shift
      ;;
    --version)
      [ $# -ge 2 ] || usage 2
      VERSION=$2
      shift 2
      ;;
    --channel)
      [ $# -ge 2 ] || usage 2
      CHANNEL=$2
      shift 2
      ;;
    --log)
      [ $# -ge 2 ] || usage 2
      LOG=$2
      shift 2
      ;;
    -h | --help) usage 0 ;;
    *) usage 2 ;;
  esac
done

case $MODE in daemon | panel) ;; *) usage 2 ;; esac
case $FAIL_AT in '' | *[!0-9]*) usage 2 ;; esac

AREA=0

# One simulated sub-step: show it, run a stand-in command whose output goes
# to the log file. "key|value" shows as an aligned key and value.
step() {
  case $1 in
    *'|'*) screen_sub "${1%%|*}" "${1#*|}" ;;
    *) screen_sub "$1" ;;
  esac
  if [ "$FAST" = 1 ]; then
    screen_run sh -c 'printf "%s\n" "demo step: $0"' "$1"
  else
    screen_run sh -c 'printf "%s\n" "demo step: $0"; sleep "$1"' "$1" "${2:-0.7}"
  fi
}

# area <name> <result detail> <failure reason> <next step> <sub-steps...>
# When this is the area chosen with --fail-at, only the first third of the
# sub-steps run before it fails, so the detail lines show where it stopped.
area() {
  AREA=$((AREA + 1))
  _name=$1
  _detail=$2
  _why=$3
  _hint=$4
  screen_area_start "$_name"
  shift 4
  _count=$#
  _stop=$((_count / 3))
  [ "$_stop" -ge 1 ] || _stop=1
  _ran=0
  for _s in "$@"; do
    if [ "$AREA" -eq "$FAIL_AT" ] && [ "$_ran" -ge "$_stop" ]; then
      break
    fi
    step "$_s"
    _ran=$((_ran + 1))
  done
  if [ "$AREA" -eq "$FAIL_AT" ]; then
    screen_area_fail "$_why" "$_hint"
    exit 1
  fi
  screen_area_done "$_detail"
}

daemon_1() { area "Checking this server" "Debian 13, 4 CPU, 8 GiB" "Only 2.1 GiB free on /opt, 10 GiB needed" \
  "free up space on /opt, then run the installer again" \
  "host system|Debian 13" "prerequisites|checking" "install key|checking" "prerequisites|ready"; }
daemon_2() { area "Verifying the release" "signature verified" "The release manifest signature did not verify" \
  "check the clock and the channel name, then run the installer again" \
  "manifest|fetching" "signature|waiting" "platform CA|waiting" "manifest|ready"; }
daemon_3() { area "Downloading TurboPanel" "turbopaneld $VERSION, native, 61 MiB" "SHA-256 of turbopaneld does not match the manifest" \
  "run the installer again to fetch the archive anew" \
  "turbopaneld $VERSION|downloading" "archive|waiting" "binary|waiting" "turbopaneld $VERSION|ready"; }
daemon_4() { area "Installing orchestration runtime" "runtime and task library ready" "The orchestration runtime did not install: no space left on device" \
  "free up space under /opt, then run the installer again" \
  "runtime|installing" "task library|waiting" "plan|waiting" "runtime|ready" "task library|ready" "plan|ready"; }
daemon_5() { area "Tuning the kernel" "cgroup v2, user namespaces" "Kernel feature check failed" \
  "enable cgroup v2 and user namespaces, then run the installer again" \
  "cgroup v2|checking" "user namespaces|checking"; }
daemon_6() { area "Installing instance" "turbopaneld active, update guard armed" "turbopaneld.service exited with status 1" \
  "read the service log, then run the installer again" \
  "daemon settings|applying" "turbopaneld.service|writing" "update guard|waiting" "turbopaneld.service|starting" "update guard|armed"; }
daemon_7() { area "Enrolling this server" "enrolled as server-a.example.lan" "No answer from panel.example.net after 120 s" \
  "check that this host can reach panel.example.net, then run the installer again" \
  "panel.example.net|waiting for it to accept this server" "handshake|waiting" "configuration|waiting" "handshake|ready"; }
daemon_8() { area "Checking health" "healthy in 3 s" "The daemon did not report healthy in 60 s" \
  "read the service log, then run the installer again" \
  "daemon|waiting" "panel link|waiting" "daemon|ready" "panel link|ready"; }

panel_1() { area "Checking this server" "Debian 13, 4 CPU, 8 GiB" "Only 2.1 GiB free on /opt, 10 GiB needed" \
  "free up space on /opt, then run the installer again" \
  "host system|Debian 13" "prerequisites|checking" "ports 80, 443, 8443|checking" "prerequisites|ready"; }
panel_2() { area "Verifying the release" "signature verified" "The release manifest signature did not verify" \
  "check the clock and the channel name, then run the installer again" \
  "manifest|fetching" "control plane|waiting" "web app|waiting" "manifest|ready"; }
panel_3() { area "Downloading TurboPanel" "control plane $VERSION, web app $VERSION" "SHA-256 of the control plane package does not match" \
  "run the installer again to fetch the package anew" \
  "control plane $VERSION|downloading" "web app $VERSION|waiting" "unpack|waiting" "control plane $VERSION|ready" "web app $VERSION|downloading" "web app $VERSION|ready"; }
panel_4() { area "Installing orchestration runtime" "runtime and task library ready" "The orchestration runtime did not install: no space left on device" \
  "free up space under /opt, then run the installer again" \
  "runtime|installing" "task library|waiting" "plan|waiting" "runtime|ready" "task library|ready" "plan|ready"; }
panel_5() { area "Installing TurboPanel database" "schema is up to date" "The TurboPanel database did not start: its port is already in use" \
  "stop whatever uses that port, then run the installer again" \
  "database|installing" "roles|waiting" "migrations|waiting" "database|starting" \
  "database|ready" "roles|creating" "roles|ready" "migrations|running" "migrations|ready" "schema|waiting" "schema|checking" "schema|ready"; }
panel_6() { area "Installing cache and message queue" "cache and message queue ready" "The message queue did not start: its port is already in use" \
  "stop whatever uses that port, then run the installer again" \
  "cache|installing" "message queue|waiting" "cache|pulling image" "cache|ready" "message queue|installing" "message queue|ready"; }
panel_7() { area "Installing instance" "control plane, web gateway and daemon active" "turbopanel.service exited with status 1" \
  "read the service log, then run the installer again" \
  "instance settings|applying" "control plane|waiting" "web gateway|waiting" "daemon|waiting" "control plane|starting" "control plane|ready" "web gateway|starting" "web gateway|ready" "daemon|starting" "daemon|ready"; }
panel_8() { area "Checking health" "healthy in 4 s" "The control plane did not answer /api/health in 60 s" \
  "read the control plane log, then run the installer again" \
  "/api/health|waiting" "web interface|waiting" "daemon|waiting" "/api/health|ready"; }

if [ "$MODE" = panel ]; then
  screen_init "$VERSION" "$CHANNEL" "$MODE" "$LOG" \
    "Checking this server" "Verifying the release" "Downloading TurboPanel" \
    "Installing orchestration runtime" "Installing TurboPanel database" \
    "Installing cache and message queue" "Installing instance" "Checking health"
else
  screen_init "$VERSION" "$CHANNEL" "$MODE" "$LOG" \
    "Checking this server" "Verifying the release" "Downloading TurboPanel" \
    "Installing orchestration runtime" "Tuning the kernel" "Installing instance" \
    "Enrolling this server" "Checking health"
fi

TOTAL=8
_n=1
while [ "$_n" -le "$TOTAL" ]; do
  "${MODE}_${_n}"
  _n=$((_n + 1))
done

if [ "$MODE" = panel ]; then
  screen_summary "Ready in"
  screen_summary_item "https://192.0.2.10:8443" "public"
  screen_summary_item "https://10.0.0.5:8443" "private"
  screen_summary_warn "port 8443 is open to the internet"
else
  screen_summary "Enrolled in"
  screen_summary_item "server-a.example.lan" "server"
  screen_summary_item "panel.example.net" "panel"
  screen_summary_warn "clock is 2.1 s off, time sync is on"
fi
screen_finish
