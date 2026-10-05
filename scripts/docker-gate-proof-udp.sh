#!/usr/bin/env bash
# Proof for the Docker gate: a raw UDP route works with Traefik on the gate's
# read-only socket. Run as root on a managed host that has Docker, a running
# gate, and the stage-3 switch on:
#
#   sudo bash docker-gate-proof-udp.sh
#
# It mirrors what the daemon renders for a `udp` hosting (a per-service
# Traefik restricted by `com.turbopanel.service` + `com.turbopanel.raw-port`
# labels, one `udp<port>` entrypoint, a published loopback port) and proves:
#   1. the read-only socket is up and the switch file is on;
#   2. a Traefik started against that socket (and not docker.sock) discovers a
#      labelled UDP backend: a datagram sent to the published port reaches it;
#   3. Traefik was refused nothing: no docker-gate.ro-refused line and no
#      Docker provider error appears while it runs;
#   4. after the gate restarts, a NEW backend (the old one removed) is
#      discovered and receives a datagram (Traefik reconnected and its event
#      stream resumed);
#   5. the proof's own containers and network are removed.
#
# The containers are throwaway (`tpgate-proof-udp-*`). The backend is Alpine's
# busybox `nc -u -l` writing what it receives to a file; the probe is bash's
# /dev/udp, so the host needs no nc. Nothing here changes the gate, the
# switch, the daemon or any real route.
set -u

GATE_UNIT=turbopanel-docker-gate.service
GATE_DIR=/run/turbopanel-gate
RO_DIR="$GATE_DIR/ro"
RO_SOCKET="$RO_DIR/docker.sock"
INGRESS_SWITCH=/opt/turbopanel/lib/docker-gate/ingress-socket.on
TRAEFIK_IMAGE=traefik:v3.6.6
IMAGE=docker.io/library/alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8
PROOF_SERVICE=tpgateproofudp
NET=tpgate-proof-udp-net
TRAEFIK=tpgate-proof-udp-traefik
APP1=tpgate-proof-udp-app1
APP2=tpgate-proof-udp-app2
PORT=${PROOF_UDP_PORT:-29971}
BACKEND_PORT=9000
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
  docker rm -f "$TRAEFIK" "$APP1" "$APP2" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
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

# Start a UDP backend carrying the daemon's service labels for the one UDP router.
start_backend() {
  _be_name=$1
  docker run -d --name "$_be_name" --network "$NET" \
    --label traefik.enable=true \
    --label "com.turbopanel.service=$PROOF_SERVICE" \
    --label com.turbopanel.raw-port=true \
    --label "traefik.udp.routers.$PROOF_SERVICE.entrypoints=udp$PORT" \
    --label "traefik.udp.services.$PROOF_SERVICE.loadbalancer.server.port=$BACKEND_PORT" \
    "$IMAGE" sh -c "nc -u -l -p $BACKEND_PORT >/got; sleep 600" >/dev/null 2>&1
  return $?
}

# True once a datagram sent to the published port lands in the backend's file (30 s).
datagram_arrives() {
  _da_name=$1
  _da_tag=$2
  for _da_try in $(seq 1 30); do
    # A fresh socket per try: Traefik keeps one UDP session per client address.
    printf '%s-%s' "$_da_tag" "$_da_try" >"/dev/udp/127.0.0.1/$PORT" 2>/dev/null
    sleep 1
    if docker exec "$_da_name" cat /got 2>/dev/null | grep -q "$_da_tag"; then return 0; fi
  done
  echo "  (no datagram reached $_da_name after $_da_try tries)" >&2
  return 1
}

echo "== 1. gate, read-only socket, switch"
if systemctl is-active --quiet "$GATE_UNIT"; then pass "gate unit is active"; else fail "gate unit is not active"; fi
_ping=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 --unix-socket "$RO_SOCKET" localhost/_ping)
if [[ "$_ping" == 200 ]]; then pass "read-only socket answers /_ping"; else fail "read-only socket /_ping answered '$_ping'"; fi
if [[ -f "$INGRESS_SWITCH" ]]; then
  pass "ingress switch file is present"
else
  fail "ingress switch file is absent ($INGRESS_SWITCH): the daemon would not use the gate for Traefik on this host"
fi
if ss -lun | awk '{print $5}' | grep -Eq "[:.]$PORT\$"; then
  echo "UDP port $PORT is already in use; set PROOF_UDP_PORT to a free port" >&2
  exit 2
fi
if [[ "$FAILED" -ne 0 ]]; then
  echo "RESULT: $FAILED precondition(s) failed, nothing was started"
  exit 1
fi

echo "== 2. a UDP route through Traefik on the read-only socket"
docker image inspect "$TRAEFIK_IMAGE" >/dev/null 2>&1 || docker pull "$TRAEFIK_IMAGE" >/dev/null 2>&1
check_ok=true
docker network create "$NET" >/dev/null 2>&1 || check_ok=false
# The same shape as serviceTraefikCompose: the gate directory read-only, the unix
# endpoint, no docker.sock, the service + raw-port constraint, one udp entrypoint.
docker run -d --name "$TRAEFIK" --network "$NET" \
  --label turbopanel.role=ingress \
  -v "$RO_DIR:/var/run/turbopanel-gate:ro" \
  -p "127.0.0.1:$PORT:$PORT/udp" \
  "$TRAEFIK_IMAGE" \
  --providers.docker=true \
  --providers.docker.endpoint=unix:///var/run/turbopanel-gate/docker.sock \
  --providers.docker.exposedbydefault=false \
  "--providers.docker.network=$NET" \
  "--providers.docker.constraints=Label(\`com.turbopanel.service\`,\`$PROOF_SERVICE\`) && Label(\`com.turbopanel.raw-port\`,\`true\`)" \
  "--entrypoints.udp$PORT.address=:$PORT/udp" >/dev/null 2>&1 || check_ok=false
if [[ "$check_ok" == true ]]; then pass "Traefik started on the read-only socket"; else fail "could not start the proof's network or Traefik"; fi
if docker inspect --format '{{range .Mounts}}{{.Source}} {{end}}' "$TRAEFIK" 2>/dev/null | grep -q 'docker\.sock'; then
  fail "the proof's Traefik mounts a docker.sock"
else
  pass "the proof's Traefik mounts no docker.sock"
fi
ROUTE_SINCE=$(date +%s)
if start_backend "$APP1" && datagram_arrives "$APP1" udp-before; then
  pass "a datagram sent to the published UDP port reached the labelled backend"
else
  fail "no datagram reached the labelled backend through Traefik"
fi

echo "== 3. Traefik was refused nothing"
_tlog=$(docker logs --since "$ROUTE_SINCE" "$TRAEFIK" 2>&1)
_perr='Provider (connection )?error|Failed to retrieve information of the docker client|Error response from daemon|cannot connect to the Docker daemon'
if printf '%s\n' "$_tlog" | grep -qiE "$_perr"; then
  fail "Traefik logged a Docker provider error (see below)"
  printf '%s\n' "$_tlog" | grep -iE "$_perr" | head -5
else
  pass "Traefik logged no Docker provider error"
fi
if journalctl -u "$GATE_UNIT" --since "$SINCE" --no-pager -o cat 2>/dev/null | grep -q '"event":"docker-gate.ro-refused"'; then
  fail "the gate refused a read-only request while the UDP route was built (an endpoint Traefik needs?)"
  journalctl -u "$GATE_UNIT" --since "$SINCE" --no-pager -o cat | grep '"event":"docker-gate.ro-refused"' | head -3
else
  pass "no docker-gate.ro-refused line during the proof"
fi

echo "== 4. after a gate restart a new backend is discovered"
RESTART_SINCE=$(date +%s)
systemctl restart "$GATE_UNIT"
_back=false
for _attempt in $(seq 1 20); do
  sleep 1
  if [[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 --unix-socket "$RO_SOCKET" localhost/_ping)" == 200 ]]; then
    _back=true
    break
  fi
done
if [[ "$_back" == true ]]; then pass "the read-only socket answers again after the restart"; else fail "the read-only socket did not come back within 20 s"; fi
docker rm -f "$APP1" >/dev/null 2>&1
if start_backend "$APP2" && datagram_arrives "$APP2" udp-after; then
  pass "a backend started after the restart receives datagrams (Traefik reconnected)"
else
  fail "a backend started after the restart is not routed (Traefik did not reconnect)"
fi
_tlog=$(docker logs --since "$RESTART_SINCE" "$TRAEFIK" 2>&1)
if printf '%s\n' "$_tlog" | grep -qiE "$_perr"; then
  # Provider errors during the restart window are expected and retried; what
  # matters is the route recovered (checked above), so this is information only.
  echo "NOTE  Traefik logged provider errors around the restart (recovered):"
  printf '%s\n' "$_tlog" | grep -iE "$_perr" | head -3
fi

echo "== 5. cleanup"
cleanup
if docker ps -a --format '{{.Names}}' | grep -q '^tpgate-proof-udp-'; then fail "proof containers are still present"; else pass "proof containers removed"; fi
if docker network ls --format '{{.Name}}' | grep -qx "$NET"; then fail "proof network is still present"; else pass "proof network removed"; fi

if [[ "$FAILED" -ne 0 ]]; then
  echo "RESULT: $FAILED check(s) failed"
  exit 1
fi
echo "RESULT: all checks passed"
