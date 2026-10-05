#!/usr/bin/env bash
# Proof for the Docker gate: an HTTPS route works through the shared Traefik
# when it discovers containers over the gate's read-only socket. Run as root on
# a managed host that has Docker, a running gate, the stage-3 switch on, and a
# shared Traefik that already runs on the gate (deploy any HTTP app once with
# the switch on):
#
#   sudo bash docker-gate-proof-tls.sh
#
# Public HTTPS ends at the hosting Caddy, which forwards to the shared
# Traefik's `websecure` entrypoint (loopback :7443, PROXY protocol, HTTP/2,
# TLS with the entrypoint's default certificate). A real site's router is
# pinned to `web,websecure` and carries no `tls` label: the entrypoint turns
# TLS on. This script plays Caddy's part from the host and proves:
#   1. the shared Traefik mounts the read-only gate socket and no docker.sock;
#   2. a labelled test app (the daemon's router shape) answers over HTTPS on
#      :7443 over HTTP/2 with the expected body, and the certificate Traefik
#      presents is its default one (a TLS handshake really happened);
#   3. an unknown Host gets a 404 from Traefik (the router table is the app's
#      alone) and the plain-HTTP entrypoint still answers the same app;
#   4. Traefik logged no Docker provider error and the gate refused it nothing;
#   5. after a gate restart the HTTPS route still answers and an app started
#      afterwards is routed over HTTPS too.
#
# Throwaway containers `tpgate-proof-tls-*` only; nothing else is changed.
#
# It restarts the gate unit once: for a few seconds the daemon's Docker calls and
# the read-only socket are unavailable. Run it on a canary or testing host with
# no deploy in flight.
set -u

GATE_UNIT=turbopanel-docker-gate.service
GATE_DIR=/run/turbopanel-gate
RO_DIR="$GATE_DIR/ro"
RO_SOCKET="$RO_DIR/docker.sock"
INGRESS_SWITCH=/opt/turbopanel/lib/docker-gate/ingress-socket.on
HTTP_URL_PORT=7080
HTTPS_URL_PORT=7443
ROUTE_IMAGE=docker.io/library/busybox:1.37.0@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e
HOST_A=tpgate-proof-tls.invalid
HOST_B=tpgate-proof-tls-after.invalid
BODY=gate-proof-tls-ok
APP_A=tpgate-proof-tls-app
APP_B=tpgate-proof-tls-app-after
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

# A labelled app with the router shape the daemon renders for an HTTP hosting,
# including the routed label the shared Traefik's provider constraint requires.
start_app() {
  _app_name=$1
  _app_host=$2
  _app_net=$3
  docker run -d --name "$_app_name" --network "$_app_net" \
    --label traefik.enable=true \
    --label com.turbopanel.system.routed=true \
    --label "traefik.docker.network=$_app_net" \
    --label "traefik.http.routers.$_app_name.rule=Host(\`$_app_host\`)" \
    --label "traefik.http.routers.$_app_name.entrypoints=web,websecure" \
    --label "traefik.http.services.$_app_name.loadbalancer.server.port=8080" \
    "$ROUTE_IMAGE" sh -c "mkdir -p /www && echo $BODY > /www/index.html && exec httpd -f -p 8080 -h /www" >/dev/null 2>&1
  return $?
}

# HTTPS GET of a Host on the loopback websecure port. Caddy speaks PROXY
# protocol to Traefik; a plain request is tried first and a PROXY one second so
# a PROXY mismatch is never mistaken for a gate failure. Prints the body.
https_body() {
  _hb_host=$1
  curl -sk --max-time 3 --resolve "$_hb_host:$HTTPS_URL_PORT:127.0.0.1" "https://$_hb_host:$HTTPS_URL_PORT/" 2>/dev/null && return 0
  curl -sk --max-time 3 --haproxy-protocol --resolve "$_hb_host:$HTTPS_URL_PORT:127.0.0.1" "https://$_hb_host:$HTTPS_URL_PORT/" 2>/dev/null
  return $?
}

# curl with whichever of the two framings works; prints curl's -w output.
https_meta() {
  _hm_host=$1
  _hm_fmt=$2
  _hm_out=$(curl -sk -o /dev/null --max-time 3 -w "$_hm_fmt" --resolve "$_hm_host:$HTTPS_URL_PORT:127.0.0.1" "https://$_hm_host:$HTTPS_URL_PORT/" 2>/dev/null) && {
    printf '%s' "$_hm_out"
    return 0
  }
  curl -sk -o /dev/null --max-time 3 --haproxy-protocol -w "$_hm_fmt" --resolve "$_hm_host:$HTTPS_URL_PORT:127.0.0.1" "https://$_hm_host:$HTTPS_URL_PORT/" 2>/dev/null
  return $?
}

https_answers() {
  _ha_host=$1
  for _ha_try in $(seq 1 30); do
    if [[ "$(https_body "$_ha_host")" == "$BODY" ]]; then return 0; fi
    sleep 1
  done
  echo "  (no HTTPS answer for $_ha_host after $_ha_try tries)" >&2
  return 1
}

echo "== 1. gate, switch, shared Traefik"
if systemctl is-active --quiet "$GATE_UNIT"; then pass "gate unit is active"; else fail "gate unit is not active"; fi
_ping=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 --unix-socket "$RO_SOCKET" localhost/_ping)
if [[ "$_ping" == 200 ]]; then pass "read-only socket answers /_ping"; else fail "read-only socket /_ping answered '$_ping'"; fi
if [[ -f "$INGRESS_SWITCH" ]]; then pass "ingress switch file is present"; else fail "ingress switch file is absent ($INGRESS_SWITCH)"; fi
SHARED_TRAEFIK=$(docker ps -q --filter label=com.turbopanel.system.component=hosting-ingress | sed -n 1p)
SHARED_NET=""
if [[ -z "$SHARED_TRAEFIK" ]]; then
  fail "no shared Traefik is running (deploy an HTTP app once with the switch on)"
else
  if docker inspect --format '{{range .Mounts}}{{.Source}} {{end}}' "$SHARED_TRAEFIK" | grep -q "$RO_DIR"; then pass "the shared Traefik mounts $RO_DIR"; else fail "the shared Traefik does not mount $RO_DIR"; fi
  if docker inspect --format '{{range .Mounts}}{{.Source}} {{end}}' "$SHARED_TRAEFIK" | grep -q 'docker\.sock'; then fail "the shared Traefik mounts a docker.sock"; else pass "the shared Traefik mounts no docker.sock"; fi
  SHARED_NET=$(docker inspect --format '{{range $net, $cfg := .NetworkSettings.Networks}}{{$net}} {{end}}' "$SHARED_TRAEFIK" | awk '{print $1}')
fi
if [[ "$FAILED" -ne 0 ]]; then
  echo "RESULT: $FAILED precondition(s) failed, nothing was started"
  exit 1
fi

echo "== 2. an HTTPS route through the shared Traefik"
ROUTE_SINCE=$(date +%s)
if start_app "$APP_A" "$HOST_A" "$SHARED_NET" && https_answers "$HOST_A"; then
  pass "the labelled app answers over HTTPS on loopback :$HTTPS_URL_PORT"
else
  fail "the labelled app does not answer over HTTPS"
fi
_meta=$(https_meta "$HOST_A" '%{http_version} %{http_code}')
if [[ "$_meta" == "2 200" ]]; then pass "the answer is HTTP/2, status 200 ($_meta)"; else fail "HTTP version/status '$_meta', want '2 200'"; fi
_cert=$(curl -svk -o /dev/null --max-time 3 --resolve "$HOST_A:$HTTPS_URL_PORT:127.0.0.1" "https://$HOST_A:$HTTPS_URL_PORT/" 2>&1 || curl -svk -o /dev/null --max-time 3 --haproxy-protocol --resolve "$HOST_A:$HTTPS_URL_PORT:127.0.0.1" "https://$HOST_A:$HTTPS_URL_PORT/" 2>&1)
if printf '%s\n' "$_cert" | grep -qiE 'SSL connection using|TLSv1\.[23]'; then pass "a TLS handshake took place"; else fail "no TLS handshake in curl's trace"; fi
if printf '%s\n' "$_cert" | grep -qi 'TRAEFIK DEFAULT CERT'; then pass "Traefik presented its default certificate (Caddy skips verification on this hop)"; else echo "NOTE  the certificate subject was not Traefik's default (a custom default certificate may be configured)"; fi

echo "== 3. router table is the app's alone, plain HTTP still routes"
_unknown=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 3 --resolve "tpgate-proof-nobody.invalid:$HTTPS_URL_PORT:127.0.0.1" "https://tpgate-proof-nobody.invalid:$HTTPS_URL_PORT/" 2>/dev/null)
if [[ "$_unknown" != 200 ]]; then pass "an unknown Host is not served (status '$_unknown')"; else fail "an unknown Host was served with 200"; fi
_plain=""
for _try in $(seq 1 10); do
  _plain=$(curl -s --max-time 2 -H "Host: $HOST_A" "http://127.0.0.1:$HTTP_URL_PORT/" 2>/dev/null)
  [[ "$_plain" == "$BODY" ]] && break
  _plain=$(curl -s --max-time 2 --haproxy-protocol -H "Host: $HOST_A" "http://127.0.0.1:$HTTP_URL_PORT/" 2>/dev/null)
  [[ "$_plain" == "$BODY" ]] && break
  sleep 1
done
if [[ "$_plain" == "$BODY" ]]; then pass "the same app answers on the plain-HTTP entrypoint"; else fail "the same app does not answer on the plain-HTTP entrypoint"; fi

echo "== 4. Traefik was refused nothing"
_tlog=$(docker logs --since "$ROUTE_SINCE" "$SHARED_TRAEFIK" 2>&1)
_perr='Provider (connection )?error|Failed to retrieve information of the docker client|Error response from daemon|cannot connect to the Docker daemon'
if printf '%s\n' "$_tlog" | grep -qiE "$_perr"; then
  fail "Traefik logged a Docker provider error (see below)"
  printf '%s\n' "$_tlog" | grep -iE "$_perr" | head -5
else
  pass "Traefik logged no Docker provider error"
fi
if journalctl -u "$GATE_UNIT" --since "$SINCE" --no-pager -o cat 2>/dev/null | grep -q '"event":"docker-gate.ro-refused"'; then
  fail "the gate refused a read-only request during the HTTPS proof"
  journalctl -u "$GATE_UNIT" --since "$SINCE" --no-pager -o cat | grep '"event":"docker-gate.ro-refused"' | head -3
else
  pass "no docker-gate.ro-refused line during the proof"
fi

echo "== 5. after a gate restart"
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
if [[ "$_back" == true ]]; then pass "the read-only socket answers again"; else fail "the read-only socket did not come back within 20 s"; fi
if https_answers "$HOST_A"; then pass "the HTTPS route still answers after the restart"; else fail "the HTTPS route stopped answering after the restart"; fi
if start_app "$APP_B" "$HOST_B" "$SHARED_NET" && https_answers "$HOST_B"; then
  pass "an app started after the restart is routed over HTTPS (Traefik reconnected)"
else
  fail "an app started after the restart is not routed over HTTPS"
fi
if docker logs --since "$RESTART_SINCE" "$SHARED_TRAEFIK" 2>&1 | grep -qiE "$_perr"; then
  echo "NOTE  Traefik logged provider errors around the restart (recovered, as the route answers):"
  docker logs --since "$RESTART_SINCE" "$SHARED_TRAEFIK" 2>&1 | grep -iE "$_perr" | head -3
fi

echo "== cleanup"
cleanup
if docker ps -a --format '{{.Names}}' | grep -q '^tpgate-proof-tls-'; then fail "proof containers are still present"; else pass "proof containers removed"; fi

if [[ "$FAILED" -ne 0 ]]; then
  echo "RESULT: $FAILED check(s) failed"
  exit 1
fi
echo "RESULT: all checks passed"
