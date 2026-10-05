#!/usr/bin/env bash
# Proof for the Docker gate: the control plane's `system.reconcile` restart of
# the shared ingress keeps Traefik on the gate's read-only socket and keeps
# routes working. Run as root on a managed host that has Docker, a running
# gate, the stage-3 switch on, and a shared Traefik on the gate:
#
#   sudo bash docker-gate-proof-reconcile.sh [seconds-to-wait-for-the-trigger]
#
# `system.reconcile` is a control-plane command, so this script cannot send it.
# It does the before and after halves and waits in the middle:
#   1. before: the shared Traefik mounts the read-only socket (no docker.sock),
#      a labelled test app is routed (plain HTTP and HTTPS), and the Traefik
#      container's identity and start time are recorded;
#   2. YOU trigger the restart: panel, server's system components, hosting
#      ingress, Restart (that enqueues `system.reconcile` with `action:
#      restart`; turning hosting off and on again also works). The script
#      waits up to the given number of seconds (default 600) for the shared
#      Traefik to start again; 0 skips the wait and only checks the current
#      state;
#   3. after: Traefik started again and is still on the read-only socket with
#      no docker.sock, no socket-proxy came back, the old app and a NEW app
#      are routed, Traefik logged no provider error after the restart, and the
#      gate refused it nothing.
#
# Exit 3 means the restart was not seen in time (not a failure of the gate).
# Throwaway containers `tpgate-proof-rec-*` only; nothing else is changed.
set -u

GATE_UNIT=turbopanel-docker-gate.service
GATE_DIR=/run/turbopanel-gate
RO_DIR="$GATE_DIR/ro"
RO_SOCKET="$RO_DIR/docker.sock"
INGRESS_SWITCH=/opt/turbopanel/lib/docker-gate/ingress-socket.on
HTTP_PORT=7080
HTTPS_PORT=7443
ROUTE_IMAGE=docker.io/library/busybox:1.37.0@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e
HOST_A=tpgate-proof-rec.invalid
HOST_B=tpgate-proof-rec-after.invalid
BODY=gate-proof-rec-ok
APP_A=tpgate-proof-rec-app
APP_B=tpgate-proof-rec-app-after
WAIT_SECS=${1:-600}
FAILED=0
SINCE=$(date '+%Y-%m-%d %H:%M:%S')

pass() {
  printf 'PASS  %s\n' "$1"
  return 0
}

fail() {
  printf 'FAIL  %s\n' "$1" >&2
  FAILED=$((FAILED + 1))
  return 0
}

cleanup() {
  docker rm -f "$APP_A" "$APP_B" >/dev/null 2>&1 || true
  return 0
}
trap cleanup EXIT

if [[ "$(id -u)" -ne 0 ]]; then
  echo "run as root" >&2
  exit 2
fi
if ! command -v docker >/dev/null 2>&1; then
  echo "docker is not installed" >&2
  exit 2
fi
if ! [[ "$WAIT_SECS" =~ ^[0-9]+$ ]]; then
  echo "usage: $0 [seconds-to-wait-for-the-trigger]" >&2
  exit 2
fi

start_app() {
  _app_name=$1
  _app_host=$2
  _app_net=$3
  docker run -d --name "$_app_name" --network "$_app_net" \
    --label traefik.enable=true \
    --label "traefik.docker.network=$_app_net" \
    --label "traefik.http.routers.$_app_name.rule=Host(\`$_app_host\`)" \
    --label "traefik.http.routers.$_app_name.entrypoints=web,websecure" \
    --label "traefik.http.services.$_app_name.loadbalancer.server.port=8080" \
    "$ROUTE_IMAGE" sh -c "mkdir -p /www && echo $BODY > /www/index.html && exec httpd -f -p 8080 -h /www" >/dev/null 2>&1
  return $?
}

# Caddy speaks PROXY protocol to Traefik: try a plain request, then a PROXY one.
http_body() {
  _hb_host=$1
  curl -s --max-time 2 -H "Host: $_hb_host" "http://127.0.0.1:$HTTP_PORT/" 2>/dev/null && return 0
  curl -s --max-time 2 --haproxy-protocol -H "Host: $_hb_host" "http://127.0.0.1:$HTTP_PORT/" 2>/dev/null
  return $?
}

https_body() {
  _sb_host=$1
  curl -sk --max-time 3 --resolve "$_sb_host:$HTTPS_PORT:127.0.0.1" "https://$_sb_host:$HTTPS_PORT/" 2>/dev/null && return 0
  curl -sk --max-time 3 --haproxy-protocol --resolve "$_sb_host:$HTTPS_PORT:127.0.0.1" "https://$_sb_host:$HTTPS_PORT/" 2>/dev/null
  return $?
}

# True once both entrypoints answer the app's body for this Host (60 s budget).
routed() {
  _rt_host=$1
  for _rt_try in $(seq 1 60); do
    if [[ "$(http_body "$_rt_host")" == "$BODY" && "$(https_body "$_rt_host")" == "$BODY" ]]; then return 0; fi
    sleep 1
  done
  echo "  (no HTTP+HTTPS answer for $_rt_host after $_rt_try tries)" >&2
  return 1
}

traefik_id() {
  docker ps -q --filter label=com.turbopanel.system.component=hosting-ingress | sed -n 1p
  return 0
}

mounts_of() {
  docker inspect --format '{{range .Mounts}}{{.Source}} {{end}}' "$1" 2>/dev/null
  return 0
}

check_on_gate() {
  _cg_id=$1
  _cg_when=$2
  if mounts_of "$_cg_id" | grep -q "$RO_DIR"; then pass "$_cg_when: the shared Traefik mounts $RO_DIR"; else fail "$_cg_when: the shared Traefik does not mount $RO_DIR"; fi
  if mounts_of "$_cg_id" | grep -q 'docker\.sock'; then fail "$_cg_when: the shared Traefik mounts a docker.sock"; else pass "$_cg_when: the shared Traefik mounts no docker.sock"; fi
  return 0
}

echo "== 1. before the restart"
if systemctl is-active --quiet "$GATE_UNIT"; then pass "gate unit is active"; else fail "gate unit is not active"; fi
_ping=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 --unix-socket "$RO_SOCKET" localhost/_ping)
if [[ "$_ping" == 200 ]]; then pass "read-only socket answers /_ping"; else fail "read-only socket /_ping answered '$_ping'"; fi
if [[ -f "$INGRESS_SWITCH" ]]; then pass "ingress switch file is present"; else fail "ingress switch file is absent ($INGRESS_SWITCH)"; fi
OLD_ID=$(traefik_id)
if [[ -z "$OLD_ID" ]]; then
  echo "RESULT: no shared Traefik is running (deploy an HTTP app once with the switch on); nothing was started" >&2
  exit 1
fi
OLD_START=$(docker inspect --format '{{.State.StartedAt}}' "$OLD_ID")
SHARED_NET=$(docker inspect --format '{{range $net, $cfg := .NetworkSettings.Networks}}{{$net}} {{end}}' "$OLD_ID" | awk '{print $1}')
PROXY_BEFORE=$(docker ps -q --filter ancestor=tecnativa/docker-socket-proxy | wc -l | tr -d ' ')
check_on_gate "$OLD_ID" before
if [[ "$FAILED" -ne 0 ]]; then
  echo "RESULT: $FAILED precondition(s) failed, nothing was started"
  exit 1
fi
if start_app "$APP_A" "$HOST_A" "$SHARED_NET" && routed "$HOST_A"; then pass "before: the test app is routed over HTTP and HTTPS"; else fail "before: the test app is not routed"; fi
if [[ "$FAILED" -ne 0 ]]; then
  echo "RESULT: the route was not working before the restart; not waiting for a trigger"
  exit 1
fi

if [[ "$WAIT_SECS" -gt 0 ]]; then
  echo "== 2. trigger the restart now"
  echo "Panel: this server, system components, hosting ingress, Restart (a system.reconcile with action restart)."
  echo "Waiting up to $WAIT_SECS s for the shared Traefik to start again (was started $OLD_START)..."
  _seen=false
  _waited=0
  while [[ "$_waited" -lt "$WAIT_SECS" ]]; do
    sleep 5
    _waited=$((_waited + 5))
    _id=$(traefik_id)
    if [[ -n "$_id" && "$(docker inspect --format '{{.State.StartedAt}}' "$_id")" != "$OLD_START" ]]; then
      _seen=true
      break
    fi
  done
  if [[ "$_seen" != true ]]; then
    echo "RESULT: the shared Traefik did not restart within $WAIT_SECS s; nothing proven (not a gate failure)"
    exit 3
  fi
  pass "the shared Traefik was restarted (new start time)"
else
  echo "== 2. no trigger wait requested: checking the current state"
fi
RESTART_AT=$(date +%s)

echo "== 3. after the restart"
NEW_ID=$(traefik_id)
if [[ -z "$NEW_ID" ]]; then
  fail "no shared Traefik is running after the restart"
else
  check_on_gate "$NEW_ID" after
  PROXY_AFTER=$(docker ps -q --filter ancestor=tecnativa/docker-socket-proxy | wc -l | tr -d ' ')
  if [[ "$PROXY_AFTER" -le "$PROXY_BEFORE" ]]; then pass "no socket-proxy container came back (before $PROXY_BEFORE, after $PROXY_AFTER)"; else fail "a socket-proxy container appeared (before $PROXY_BEFORE, after $PROXY_AFTER)"; fi
  if routed "$HOST_A"; then pass "after: the existing test app is still routed over HTTP and HTTPS"; else fail "after: the existing test app is no longer routed"; fi
  if start_app "$APP_B" "$HOST_B" "$SHARED_NET" && routed "$HOST_B"; then
    pass "after: an app started after the restart is routed (the restarted Traefik discovers over the gate)"
  else
    fail "after: an app started after the restart is not routed"
  fi
  _perr='Provider (connection )?error|Failed to retrieve information of the docker client|Error response from daemon|cannot connect to the Docker daemon'
  _tlog=$(docker logs --since "$RESTART_AT" "$NEW_ID" 2>&1)
  if printf '%s\n' "$_tlog" | grep -qiE "$_perr"; then
    fail "the restarted Traefik logged a Docker provider error (see below)"
    printf '%s\n' "$_tlog" | grep -iE "$_perr" | head -5
  else
    pass "the restarted Traefik logged no Docker provider error"
  fi
fi
if journalctl -u "$GATE_UNIT" --since "$SINCE" --no-pager -o cat 2>/dev/null | grep -q '"event":"docker-gate.ro-refused"'; then
  fail "the gate refused a read-only request during the proof"
  journalctl -u "$GATE_UNIT" --since "$SINCE" --no-pager -o cat | grep '"event":"docker-gate.ro-refused"' | head -3
else
  pass "no docker-gate.ro-refused line during the proof"
fi
_reconcile_lines=$(journalctl -u turbopaneld --since "$SINCE" --no-pager -o cat 2>/dev/null | grep -c 'system.reconcile')
echo "NOTE  daemon journal lines mentioning system.reconcile since the start: $_reconcile_lines (the command's own result is in the panel's command log)"

echo "== cleanup"
cleanup
if docker ps -a --format '{{.Names}}' | grep -q '^tpgate-proof-rec-'; then fail "proof containers are still present"; else pass "proof containers removed"; fi

if [[ "$FAILED" -ne 0 ]]; then
  echo "RESULT: $FAILED check(s) failed"
  exit 1
fi
echo "RESULT: all checks passed"
