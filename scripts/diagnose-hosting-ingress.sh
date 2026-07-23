#!/bin/sh
# Diagnose TurboPanel hosting ingress on a daemon host (Caddy :80/:443 → loopback Traefik → containers).
# Run on the target host (e.g. louie.lan): sudo sh scripts/diagnose-hosting-ingress.sh

set -eu

# Same composition as scripts/lib/runtime-paths.sh (keep host diagnostics self-contained).
TURBOPANEL_HOME="${TURBOPANEL_HOME:-/opt/turbopanel}"
TURBOPANEL_RUNTIMES_DIR="${TURBOPANEL_RUNTIMES_DIR:-${TURBOPANEL_RUNTIME_DIR:-${TURBOPANEL_HOME}/vendor}}"

HOSTING_SERVICE="turbopanel-hosting-caddy.service"
HOSTING_DIR="/etc/turbopanel/hosting"
SITES_DIR="${HOSTING_DIR}/sites"
TRAEFIK_PROJECT="turbopanel-ingress"
TRAEFIK_HTTP_PORT="7080"
TRAEFIK_HTTPS_PORT="7443"

section() {
  printf '\n=== %s ===\n' "$1"
}

# Warn when Traefik ingress ports are bound outside loopback (127.0.0.1 / ::1).
warn_non_loopback_traefik_ports() {
  _listeners="$1"
  for _port in "$TRAEFIK_HTTP_PORT" "$TRAEFIK_HTTPS_PORT"; do
    echo "$_listeners" | grep -E ":${_port}[[:space:]]" | while IFS= read -r _line; do
      _local=$(echo "$_line" | awk '{print $4}')
      _host=${_local%:*}
      _host=${_host#[}
      _host=${_host%]}
      case "$_host" in
        127.0.0.1|127.*|::1) ;;
        *) echo "WARNING: traefik ${_port} bound on non-loopback (${_host})" ;;
      esac
    done
  done
}

section "listeners (80, 443 — hosting Caddy; 7080, 7443 — loopback Traefik only)"
if command -v ss >/dev/null 2>&1; then
  _ss_out=$(ss -tlnp 2>/dev/null || true)
  echo "$_ss_out" | grep -E ':80 |:443 ' || echo "(no listeners on 80/443)"
  echo "$_ss_out" | grep ':8080 ' && echo "WARNING: legacy traefik :8080 still bound" || true
  echo "$_ss_out" | grep "127.0.0.1:${TRAEFIK_HTTP_PORT} " || echo "missing loopback listener on 127.0.0.1:${TRAEFIK_HTTP_PORT}"
  echo "$_ss_out" | grep "127.0.0.1:${TRAEFIK_HTTPS_PORT} " || echo "missing loopback listener on 127.0.0.1:${TRAEFIK_HTTPS_PORT}"
  warn_non_loopback_traefik_ports "$_ss_out"
else
  _netstat_out=$(netstat -tlnp 2>/dev/null || true)
  echo "$_netstat_out" | grep -E ':80 |:443 ' || echo "(no listeners on 80/443)"
  echo "$_netstat_out" | grep "127.0.0.1:${TRAEFIK_HTTP_PORT} " || echo "missing loopback listener on 127.0.0.1:${TRAEFIK_HTTP_PORT}"
  echo "$_netstat_out" | grep "127.0.0.1:${TRAEFIK_HTTPS_PORT} " || echo "missing loopback listener on 127.0.0.1:${TRAEFIK_HTTPS_PORT}"
  warn_non_loopback_traefik_ports "$_netstat_out"
fi

section "hosting caddy systemd"
if command -v systemctl >/dev/null 2>&1; then
  systemctl is-active "${HOSTING_SERVICE}" 2>&1 || true
  systemctl is-enabled "${HOSTING_SERVICE}" 2>&1 || true
  systemctl status "${HOSTING_SERVICE}" --no-pager -l 2>&1 | head -20 || true
else
  echo "systemctl not available"
fi

section "hosting caddy unit file"
if [ -f "/etc/systemd/system/${HOSTING_SERVICE}" ]; then
  echo "installed: /etc/systemd/system/${HOSTING_SERVICE}"
elif [ -f "${HOSTING_DIR}/${HOSTING_SERVICE}" ]; then
  echo "generated but NOT installed: ${HOSTING_DIR}/${HOSTING_SERVICE}"
  echo "  fix: sudo install -m 0640 ${HOSTING_DIR}/${HOSTING_SERVICE} /etc/systemd/system/"
  echo "       sudo systemctl daemon-reload && sudo systemctl enable --now ${HOSTING_SERVICE}"
else
  echo "missing unit source and installed unit"
fi

section "hosting caddy config"
if [ -f "${HOSTING_DIR}/Caddyfile" ]; then
  echo "--- ${HOSTING_DIR}/Caddyfile ---"
  cat "${HOSTING_DIR}/Caddyfile"
else
  echo "missing ${HOSTING_DIR}/Caddyfile"
fi

section "hosting site snippets"
if [ -d "${SITES_DIR}" ]; then
  ls -la "${SITES_DIR}" 2>&1 || true
  for f in "${SITES_DIR}"/*.caddy; do
    [ -f "$f" ] || continue
    echo "--- $f ---"
    cat "$f"
  done
else
  echo "missing ${SITES_DIR}"
fi

section "caddy binary"
CADDY_BIN="${TURBOPANEL_RUNTIMES_DIR}/caddy/current/caddy"
if [ -x "${CADDY_BIN}" ]; then
  echo "present: ${CADDY_BIN}"
  "${CADDY_BIN}" version 2>&1 || true
else
  echo "missing: ${CADDY_BIN}"
fi

section "traefik ingress container"
if command -v docker >/dev/null 2>&1; then
  docker ps --filter "name=traefik" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" 2>&1 || true
  docker compose -p "${TRAEFIK_PROJECT}" ps 2>&1 || true
else
  echo "docker not available"
fi

section "deployed app containers (nginx etc.)"
if command -v docker >/dev/null 2>&1; then
  docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" 2>&1 | head -30 || true
fi

section "recent deploy / hosting logs"
LOG="/var/log/turbopanel/daemon.log"
if [ -f "${LOG}" ]; then
  grep -iE 'deploy|hosting|caddy|traefik|ingress' "${LOG}" 2>/dev/null | tail -30 || echo "(no matching log lines)"
else
  echo "missing ${LOG}"
fi

section "local curl probes"
for url in "http://127.0.0.1/" "https://127.0.0.1/" "http://127.0.0.1:${TRAEFIK_HTTP_PORT}/" "https://127.0.0.1:${TRAEFIK_HTTPS_PORT}/"; do
  printf '%s -> ' "$url"
  curl -sk --connect-timeout 2 -o /dev/null -w '%{http_code} (exit %{exitcode})\n' "$url" 2>&1 || echo "failed"
done
