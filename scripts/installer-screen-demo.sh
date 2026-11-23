#!/bin/sh
# installer-screen-demo.sh - a simulated install that drives the installer screen.
#
# MOCKUP: nothing here touches the host. Every "step" is a short sleep and a fake
# line sent to the log file, so the screen can be looked at and recorded.
#
#   sh scripts/installer-screen-demo.sh --mode daemon
#   sh scripts/installer-screen-demo.sh --mode panel
#   sh scripts/installer-screen-demo.sh --mode panel --fail-at 4
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

TOTAL=8
AREA=0

# One simulated sub-step: show it, run a stand-in command whose output goes
# to the log file.
step() {
  screen_sub "$1"
  if [ "$FAST" = 1 ]; then
    screen_run sh -c 'printf "%s\n" "demo step: $0"' "$1"
  else
    screen_run sh -c 'printf "%s\n" "demo step: $0"; sleep "$1"' "$1" "${2:-0.7}"
  fi
}

# area <name> <result detail> <failure reason>, then the sub-steps on stdin
# are read from the positional list set by the caller via steps().
area() {
  AREA=$((AREA + 1))
  _name=$1
  _detail=$2
  _why=$3
  screen_area_start "$_name"
  shift 3
  for _s in "$@"; do
    step "$_s"
  done
  if [ "$AREA" -eq "$FAIL_AT" ]; then
    screen_area_fail "$_why"
    exit 1
  fi
  screen_area_done "$_detail"
}

daemon_1() { area "Preflight" "Debian 13, amd64, 4 CPU, 8 GiB RAM" "Only 2.1 GiB free on /opt, 10 GiB needed" \
  "Checking host operating system" "Checking host prerequisites" "Checking the install command against the panel's key"; }
daemon_2() { area "Release" "channel $CHANNEL, signature verified" "The release manifest signature did not verify" \
  "Fetching release manifest" "Verifying the manifest signature" "Fetching the Platform CA"; }
daemon_3() { area "Download" "turbopaneld $VERSION, native, 61 MiB" "SHA-256 of turbopaneld does not match the manifest" \
  "Downloading daemon release (amd64)" "Verifying SHA-256 of the archive" "Probing native daemon binary"; }
daemon_4() { area "Runtimes" "Deno 2.9.8, uv 0.11.21" "Deno 2.9.8 did not unpack: no space left on device" \
  "Installing Deno 2.9.8" "Installing uv 0.11.21" "Checking runtime digests"; }
daemon_5() { area "Ansible" "Ansible 2.20, 41 tasks, 0 failed" "Task daemon-config: write env failed" \
  "Installing Ansible 2.20" "Installing collections" "Running the install playbook" "Applying role daemon-config" "Applying role daemon-launch"; }
daemon_6() { area "Services" "turbopaneld active, update guard armed" "turbopaneld.service exited with status 1" \
  "Writing turbopaneld.service" "Arming the update guard" "Starting turbopaneld.service"; }
daemon_7() { area "Enrolment" "enrolled as server-a.example.lan" "No answer from panel.example.net after 120 s" \
  "Waiting for the control plane to accept this server" "Handshake with panel.example.net" "Receiving the first configuration"; }
daemon_8() { area "Kernel" "cgroup v2, user namespaces" "Kernel feature check failed" \
  "Checking cgroup v2" "Checking user namespaces"; }

panel_1() { area "Preflight" "Debian 13, amd64, 4 CPU, 8 GiB RAM" "Only 2.1 GiB free on /opt, 10 GiB needed" \
  "Checking host operating system" "Checking host prerequisites" "Checking ports 80, 443 and 8443"; }
panel_2() { area "Release" "channel $CHANNEL, signature verified" "The release manifest signature did not verify" \
  "Fetching release manifest" "Finding the control plane release (channel $CHANNEL)" "Finding the web app release"; }
panel_3() { area "Download" "control plane $VERSION, web app $VERSION" "SHA-256 of the control plane package does not match" \
  "Downloading control plane package (amd64)" "Downloading UI export" "Unpacking under /opt/turbopanel"; }
panel_4() { area "Runtimes" "Postgres 18, Redis 8, RabbitMQ 4" "Postgres 18 did not start: port 5432 is in use" \
  "Installing Postgres 18" "Installing Redis 8" "Installing RabbitMQ 4" "Installing Caddy 2.11.4"; }
panel_5() { area "Ansible" "Ansible 2.20, 63 tasks, 0 failed" "Task instance-user: create account failed" \
  "Installing Ansible 2.20" "Running the install playbook" "Applying role instance-launch" "Applying role instance-certs"; }
panel_6() { area "Database" "schema is up to date" "A migration failed: see the log" \
  "Creating database roles" "Running migrations" "Checking the schema"; }
panel_7() { area "Services" "control plane, Caddy and daemon active" "turbopanel.service exited with status 1" \
  "Starting the control plane" "Starting Caddy" "Starting the co-located daemon"; }
panel_8() { area "Health" "healthy in 4 s" "The control plane did not answer /api/health in 60 s" \
  "Waiting for /api/health" "Checking the web interface" "Enrolling the co-located daemon"; }

screen_init "$VERSION" "$CHANNEL" "$MODE" "$TOTAL" "$LOG"

_n=1
while [ "$_n" -le "$TOTAL" ]; do
  "${MODE}_${_n}"
  _n=$((_n + 1))
done

if [ "$MODE" = panel ]; then
  screen_summary "Control plane is ready"
  screen_summary_item "Public" "https://192.0.2.10:8443"
  screen_summary_item "Private" "https://10.0.0.5:8443"
  screen_summary_item "Next" "open a URL and create the first administrator"
  screen_summary_warn "Port 8443 is open to the internet: limit it in your firewall"
  screen_summary_warn "No swap is configured: add 2 GiB before hosting databases"
else
  screen_summary "Server enrolled"
  screen_summary_item "Server" "server-a.example.lan"
  screen_summary_item "Panel" "panel.example.net"
  screen_summary_item "Channel" "$CHANNEL"
  screen_summary_warn "Clock is 2.1 s off: time sync was enabled, check it in a minute"
fi
screen_finish
