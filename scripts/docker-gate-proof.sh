#!/usr/bin/env bash
# Canary proof for the Docker gate, stage 1 (observe mode). Run as root on a
# managed host that has Docker:
#
#   sudo bash docker-gate-proof.sh
#
# It proves four things and exits non-zero if any fails:
#   1. the gate service is active, its socket is root:tp 0660 in a root-owned
#      directory, and the daemon account can open it but is still in `docker`;
#   2. real Docker traffic flows through it unchanged: run, exec -i, logs,
#      events, and a Compose deploy;
#   3. the strict profile would refuse the root-equivalent shapes (privileged,
#      a host-root bind, the Docker socket, host networking, an added
#      capability): each is LOGGED as docker-gate.would-deny, and each still
#      runs (observe mode refuses nothing);
#   4. nothing routes through the gate by default: the daemon's environment has
#      no DOCKER_HOST / TURBOPANEL_DOCKER_SOCKET.
#
# Stage 2 adds: the ownership observation (a container nothing stamped is
# logged as unowned-container when stopped through the gate), a rejected signed
# approval (approvals are off on a default install, so any token is refused and
# the finding stands), and, when buildx is installed, a summary that shows both
# BuildKit upgrades (`grpc` and `session`).
#
# Stage 3 adds: the read-only listener Traefik may mount (root:root, its own
# directory) answers ping / version / container list and inspect, and refuses
# info, images and a create with a 403; the daemon account cannot open it; and when the
# switch file is on, the shared Traefik mounts it and no socket-proxy remains.
#
# The containers are `true` / `echo` on a pinned Alpine image and are removed.
# A BuildKit upgrade (Compose `build:`) is exercised when the buildx plugin is
# installed; the summary then shows `grpc` and `session` upgrades.
set -u

GATE_UNIT=turbopanel-docker-gate.service
GATE_DIR=/run/turbopanel-gate
GATE_SOCKET="$GATE_DIR/docker.sock"
RO_DIR="$GATE_DIR/ro"
RO_SOCKET="$RO_DIR/docker.sock"
INGRESS_SWITCH=/opt/turbopanel/lib/docker-gate/ingress-socket.on
STAT_FMT='%U:%G %a'
DAEMON_ACCOUNT=tp
DAEMON_ENV=/etc/turbopanel/daemon.env
IMAGE=docker.io/library/alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8
PROJECT=tpgateproof
WORK=$(mktemp -d /tmp/tpgate-proof.XXXXXX)
FAILED=0
SINCE=$(date '+%Y-%m-%d %H:%M:%S')

pass() {
  _pass_label=$1
  printf 'PASS  %s\n' "$_pass_label"
  return 0
}

fail() {
  _fail_label=$1
  printf 'FAIL  %s\n' "$_fail_label" >&2
  FAILED=$((FAILED + 1))
  return 0
}

check() {
  _check_label=$1
  shift
  if "$@" >/dev/null 2>&1; then
    pass "$_check_label"
  else
    fail "$_check_label"
  fi
  return 0
}

# docker through the gate, as the daemon account (what a stage-4 daemon does).
gate_docker() {
  sudo -n -u "$DAEMON_ACCOUNT" env "DOCKER_HOST=unix://$GATE_SOCKET" docker "$@"
  return $?
}

# docker through the read-only socket (what a Traefik on the gate sees).
ro_docker() {
  docker -H "unix://$RO_SOCKET" "$@"
  return $?
}

cleanup() {
  gate_docker compose -p "$PROJECT" down -v >/dev/null 2>&1 || true
  rm -rf "$WORK"
  return 0
}
trap cleanup EXIT

if [[ "$(id -u)" -ne 0 ]]; then
  echo "run as root" >&2
  exit 2
fi

echo "== 1. service, socket, accounts"
check "gate unit is active" systemctl is-active --quiet "$GATE_UNIT"
check "gate unit is enabled" systemctl is-enabled --quiet "$GATE_UNIT"
_mode=$(stat -c "$STAT_FMT" "$GATE_SOCKET" 2>/dev/null)
if [[ "$_mode" == "root:$DAEMON_ACCOUNT 660" ]]; then pass "socket is $_mode"; else fail "socket is '$_mode', want root:$DAEMON_ACCOUNT 660"; fi
_dir=$(stat -c "$STAT_FMT" "$GATE_DIR" 2>/dev/null)
if [[ "$_dir" == "root:$DAEMON_ACCOUNT 750" ]]; then pass "socket directory is $_dir"; else fail "socket directory is '$_dir', want root:$DAEMON_ACCOUNT 750"; fi
check "daemon account can use Docker through the gate" gate_docker version
check "daemon account is still in the docker group (stage 1 changes nothing)" sh -c "id -nG $DAEMON_ACCOUNT | tr ' ' '\n' | grep -qx docker"
GATE_MAIN=/opt/turbopanel/lib/docker-gate/main.ts
if [[ "$(stat -c %U "$GATE_MAIN" 2>/dev/null)" == root ]] && ! sudo -n -u "$DAEMON_ACCOUNT" test -w "$GATE_MAIN"; then
  pass "gate source is root-owned and not writable by the daemon"
else
  fail "gate source is root-owned and not writable by the daemon"
fi

echo "== 2. ordinary traffic through the gate"
check "pull the pinned image" gate_docker pull "$IMAGE"
check "docker run" gate_docker run --rm --network none "$IMAGE" true
_out=$(printf 'proof-line\n' | gate_docker run --rm -i --network none "$IMAGE" cat 2>/dev/null)
if [[ "$_out" == "proof-line" ]]; then pass "docker run -i (stdin over the upgraded stream)"; else fail "docker run -i echoed '$_out'"; fi
gate_docker run -d --name tpgate-proof-c --network none "$IMAGE" sleep 120 >/dev/null 2>&1
_out=$(gate_docker exec tpgate-proof-c echo exec-ok 2>/dev/null)
if [[ "$_out" == "exec-ok" ]]; then pass "docker exec"; else fail "docker exec printed '$_out'"; fi
check "docker logs" gate_docker logs tpgate-proof-c
check "docker events (bounded)" gate_docker events --since 1m --until 0s
gate_docker rm -f tpgate-proof-c >/dev/null 2>&1

mkdir -p "$WORK/proj"
cat >"$WORK/proj/Dockerfile" <<EOF
FROM $IMAGE
RUN echo built > /built.txt
CMD ["cat", "/built.txt"]
EOF
cat >"$WORK/proj/compose.yml" <<'EOF'
services:
  web:
    build: .
    image: tpgate-proof-web:test
EOF
chmod -R a+rX "$WORK"
if gate_docker compose -f "$WORK/proj/compose.yml" -p "$PROJECT" up --build 2>&1 | grep -q 'built'; then
  pass "compose up --build"
else
  fail "compose up --build"
fi
gate_docker rmi tpgate-proof-web:test >/dev/null 2>&1

echo "== 3. the strict profile would refuse these (logged, still run)"
if gate_docker run --rm --privileged --network none "$IMAGE" true >/dev/null 2>&1; then pass "privileged ran (observe)"; else fail "privileged did not run: observe mode must not refuse"; fi
if gate_docker run --rm --network none -v /:/host:ro "$IMAGE" true >/dev/null 2>&1; then pass "host-root bind ran (observe)"; else fail "host-root bind did not run"; fi
if gate_docker run --rm --network none -v /var/run/docker.sock:/s:ro "$IMAGE" true >/dev/null 2>&1; then pass "docker.sock bind ran (observe)"; else fail "docker.sock bind did not run"; fi
if gate_docker run --rm --network host "$IMAGE" true >/dev/null 2>&1; then pass "host network ran (observe)"; else fail "host network did not run"; fi
if gate_docker run --rm --network none --cap-add SYS_ADMIN "$IMAGE" true >/dev/null 2>&1; then pass "cap-add ran (observe)"; else fail "cap-add did not run"; fi

# Stage 2: ownership and approvals (still observe: nothing is refused).
gate_docker run -d --name tpgate-proof-human --network none "$IMAGE" sleep 120 >/dev/null 2>&1
if gate_docker stop -t 1 tpgate-proof-human >/dev/null 2>&1; then pass "stop of an unlabeled container ran (observe)"; else fail "stop of an unlabeled container did not run"; fi
gate_docker rm -f tpgate-proof-human >/dev/null 2>&1
if gate_docker run --rm --privileged --network none --label com.turbopanel.approval=v1.bm90LWEtdG9rZW4.bm90LWEtc2lnbmF0dXJl "$IMAGE" true >/dev/null 2>&1; then pass "privileged with a bogus approval ran (observe)"; else fail "privileged with a bogus approval did not run"; fi

sleep 1
_log=$(journalctl -u "$GATE_UNIT" --since "$SINCE" --no-pager -o cat 2>/dev/null)
for _rule in privileged bind-host-root bind-docker-socket network-mode-host cap-add; do
  if printf '%s\n' "$_log" | grep -q "\"rule\":\"$_rule\""; then pass "journal has would-deny $_rule"; else fail "journal has no would-deny $_rule"; fi
done
for _needle in '"rule":"unlabeled-create"' '"rule":"unowned-container"'; do
  if printf '%s\n' "$_log" | grep -q "$_needle"; then pass "journal has $_needle"; else fail "journal has no $_needle"; fi
done
if printf '%s\n' "$_log" | grep '"event":"docker-gate.approval"' | grep -q '"result":"rejected"'; then pass "journal has a rejected approval (approvals are off by default)"; else fail "journal has no rejected approval"; fi
if printf '%s\n' "$_log" | grep -q 'bm90LWEtdG9rZW4'; then fail "an approval token reached the journal"; else pass "approval token is never logged"; fi
if printf '%s\n' "$_log" | grep -q '"level":"error"'; then fail "the gate logged an error (see below)"; printf '%s\n' "$_log" | grep '"level":"error"' | head -5; else pass "no error-level gate log lines"; fi

echo "== 4. nothing routes through the gate by default"
if grep -Eq '^(export )?(DOCKER_HOST|TURBOPANEL_DOCKER_SOCKET)=' "$DAEMON_ENV" 2>/dev/null; then
  echo "NOTE  $DAEMON_ENV sets DOCKER_HOST / TURBOPANEL_DOCKER_SOCKET (an opt-in canary flip, not the default)"
else
  pass "$DAEMON_ENV sets neither DOCKER_HOST nor TURBOPANEL_DOCKER_SOCKET"
fi

echo "== 5. stage 3: the read-only socket for Traefik"
if [[ "$(stat -c "$STAT_FMT" "$RO_DIR" 2>/dev/null)" == "root:root 750" ]]; then pass "$RO_DIR is root:root 0750"; else fail "$RO_DIR is not root:root 0750"; fi
if [[ "$(stat -c "$STAT_FMT" "$RO_SOCKET" 2>/dev/null)" == "root:root 660" ]]; then pass "$RO_SOCKET is root:root 0660"; else fail "$RO_SOCKET is not root:root 0660"; fi
check "read-only socket answers docker version (ping + version)" ro_docker version
check "read-only socket answers docker ps (container list)" ro_docker ps -a
_ro_any=$(docker ps -aq | sed -n 1p)
if [[ -n "$_ro_any" ]]; then check "read-only socket answers docker inspect (container inspect)" ro_docker inspect --type container "$_ro_any"; fi
for _refused in info images "run --rm $IMAGE true"; do
  # Word splitting on purpose: each entry is one docker command line.
  read -r -a _ro_argv <<<"$_refused"
  if ro_docker "${_ro_argv[@]}" >/dev/null 2>&1; then fail "read-only socket allowed docker $_refused"; else pass "read-only socket refuses docker $_refused"; fi
done
if journalctl -u "$GATE_UNIT" --since "$SINCE" --no-pager -o cat | grep -q '"event":"docker-gate.ro-refused"'; then pass "journal has docker-gate.ro-refused"; else fail "journal has no docker-gate.ro-refused"; fi
if sudo -n -u "$DAEMON_ACCOUNT" docker -H "unix://$RO_SOCKET" version >/dev/null 2>&1; then fail "the daemon account can open the read-only socket"; else pass "the daemon account cannot open the read-only socket"; fi
if [[ -f "$INGRESS_SWITCH" ]]; then
  if docker ps -q | xargs -r docker inspect --format '{{range .Mounts}}{{.Source}} {{end}}' | grep -q "$RO_DIR"; then pass "a Traefik mounts $RO_DIR (switch on)"; else fail "switch on but no container mounts $RO_DIR (deploy once to re-render ingress)"; fi
  if docker ps --format '{{.Image}}' | grep -q 'docker-socket-proxy'; then echo "NOTE  the socket-proxy is still running: a TCP/UDP service Traefik rendered before the switch still uses it (redeploy that service)"; else pass "no socket-proxy container is running"; fi
else
  echo "NOTE  $INGRESS_SWITCH is absent: Traefik still uses the socket-proxy (the default)"
fi

echo "== gate summary (final counters are written when the unit stops or every summary interval)"
systemctl kill --signal=SIGTERM "$GATE_UNIT" >/dev/null 2>&1
_came_back=false
for _attempt in 1 2 3 4 5 6 7 8 9 10; do
  sleep 1
  if [[ "$_attempt" -ge 3 ]] && systemctl is-active --quiet "$GATE_UNIT" && [[ -S "$GATE_SOCKET" ]]; then
    _came_back=true
    break
  fi
done
_summary=$(journalctl -u "$GATE_UNIT" --since "$SINCE" --no-pager -o cat | grep '"event":"docker-gate.summary"' | tail -1)
printf '%s\n' "$_summary"
if docker buildx version >/dev/null 2>&1; then
  if printf '%s\n' "$_summary" | grep -q '"grpc":' && printf '%s\n' "$_summary" | grep -q '"session":'; then pass "summary shows the BuildKit grpc and session upgrades"; else fail "summary shows no grpc/session upgrade (compose build did not go through the gate?)"; fi
else
  echo "NOTE  buildx is not installed: grpc/session upgrades not exercised"
fi
if [[ "$_came_back" == true ]]; then pass "unit restarted itself after the stop (Restart=always)"; else fail "unit did not come back within 10 s"; fi

if [[ "$FAILED" -ne 0 ]]; then
  echo "RESULT: $FAILED check(s) failed"
  exit 1
fi
echo "RESULT: all checks passed"
