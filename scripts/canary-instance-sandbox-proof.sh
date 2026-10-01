#!/usr/bin/env bash
# Canary proof for the instance unit's systemd sandbox and prompt SIGTERM exit.
# Run as root on a managed host (the canary) AFTER the host has converged to a
# turbopaneld build that carries the sandbox and an instance build that carries
# instance-shutdown.ts:
#
#   sudo bash canary-instance-sandbox-proof.sh
#
# It restarts turbopanel-instance once, then proves, exiting non-zero on any
# failure:
#   1. the running unit really has the sandbox (systemctl show), and the unit
#      file does NOT set NoNewPrivileges;
#   2. the instance is active, answers /api/health with 200 on its socket, and
#      its journal since the restart has no permission, read-only-filesystem,
#      NotCapable or namespace errors;
#   3. metrics still write: files under the metrics dir are newer than the
#      start of the unit (the DuckDB store opens and stamps schema-version);
#   4. the sandbox did not take sudo away: inside a transient unit that carries
#      the instance's own sandbox lines and runs as the instance user,
#      `sudo -n -l` lists the pamtester and systemctl-restart grants, a real
#      pamtester call for a user that does not exist is refused by PAM (not by
#      sudo), and outbound TCP and DNS still work;
#   5. stop is prompt: `systemctl stop` returns in under 5 s with no SIGTERM
#      timeout or SIGKILL in the journal (it used to take the full 10 s and end
#      in SIGKILL), and the unit starts again with health 200.
#
# Still manual (it changes the host): click Update in the panel and watch the
# instance restart through `sudo systemctl restart` and come back healthy.
set -u

UNIT=turbopanel-instance.service
INSTANCE_USER=tpctrl
INSTANCE_GROUP=tp
SOCKET=/run/turbopanel/instance.sock
METRICS_DIR=/var/lib/turbopanel/metrics
STOP_BUDGET_SECONDS=5
FAILED=0

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

health_status() {
  curl -s -o /dev/null -w '%{http_code}' --max-time 5 --unix-socket "$SOCKET" http://localhost/api/health 2>/dev/null
  return 0
}

wait_healthy() {
  _wait_tries=${1:-30}
  while [[ "$_wait_tries" -gt 0 ]]; do
    if [[ "$(health_status)" = 200 ]]; then
      return 0
    fi
    _wait_tries=$((_wait_tries - 1))
    sleep 1
  done
  return 1
}

if [[ "$(id -u)" -ne 0 ]]; then
  echo "run as root" >&2
  exit 2
fi

echo "== restart $UNIT"
since=$(date '+%Y-%m-%d %H:%M:%S')
reference=$(mktemp)
systemctl restart "$UNIT"
if wait_healthy 40; then pass "health 200 after restart"; else fail "health did not reach 200 after restart"; fi

echo "== 1. sandbox is applied"
for pair in ProtectSystem=strict ProtectHome=yes PrivateTmp=yes PrivateDevices=yes ProtectKernelTunables=yes ProtectKernelModules=yes ProtectKernelLogs=yes ProtectControlGroups=yes RestrictSUIDSGID=yes; do
  prop=${pair%%=*}
  want=${pair#*=}
  have=$(systemctl show -p "$prop" --value "$UNIT")
  if [[ "$have" = "$want" ]]; then pass "$prop=$want"; else fail "$prop is '$have', expected '$want'"; fi
done
families=$(systemctl show -p RestrictAddressFamilies --value "$UNIT")
case "$families" in
  *AF_UNIX*AF_INET*AF_NETLINK* | *AF_UNIX*AF_NETLINK*AF_INET*) pass "RestrictAddressFamilies: $families" ;;
  *) fail "RestrictAddressFamilies is '$families'" ;;
esac
if systemctl cat "$UNIT" | grep -q '^NoNewPrivileges='; then
  fail "NoNewPrivileges is set (breaks sudo)"
else
  pass "NoNewPrivileges not set"
fi
nnp=$(grep NoNewPrivs "/proc/$(systemctl show -p MainPID --value "$UNIT")/status" | awk '{print $2}')
if [[ "$nnp" = 0 ]]; then pass "process NoNewPrivs=0"; else fail "process NoNewPrivs=$nnp"; fi

echo "== 2. clean journal"
errors=$(journalctl -u "$UNIT" --since "$since" --no-pager 2>/dev/null |
  grep -Ei 'NotCapable|Permission denied|Read-only file system|EROFS|Operation not permitted|status=2[0-9][0-9]|Failed at step|Failed to set up mount namespacing' || true)
if [[ -z "$errors" ]]; then
  pass "journal clean since $since"
else
  fail "journal has errors since $since"
  printf '%s\n' "$errors" >&2
fi
if [[ "$(systemctl show -p ActiveState --value "$UNIT")" = active ]]; then pass "unit active"; else fail "unit not active"; fi

echo "== 3. metrics still write"
if [[ -d "$METRICS_DIR" ]]; then
  newer=$(find "$METRICS_DIR" -maxdepth 2 -newer "$reference" -type f 2>/dev/null | head -3)
  if [[ -n "$newer" ]]; then pass "files written under $METRICS_DIR since the restart"; else fail "nothing under $METRICS_DIR written since the restart"; fi
else
  fail "$METRICS_DIR missing"
fi
rm -f "$reference"

echo "== 4. sudo, PAM and outbound network under the same sandbox"
props=()
while IFS= read -r line; do
  props+=(-p "$line")
done < <(systemctl cat "$UNIT" | grep -E '^(PrivateTmp|PrivateDevices|ProtectSystem|ProtectHome|ProtectKernelTunables|ProtectKernelModules|ProtectKernelLogs|ProtectControlGroups|ProtectClock|ProtectHostname|ReadWritePaths|RestrictAddressFamilies|RestrictNamespaces|RestrictRealtime|RestrictSUIDSGID|LockPersonality|CapabilityBoundingSet)=')
probe() {
  _probe_script=$1
  systemd-run --quiet --wait --pipe --collect -p "User=$INSTANCE_USER" -p "Group=$INSTANCE_GROUP" "${props[@]}" /bin/sh -c "$_probe_script" 2>&1
  return 0
}
listing=$(probe 'sudo -n -l')
case "$listing" in
  *pamtester*) pass "sudo -l lists the pamtester grant" ;;
  *) fail "sudo -l does not list pamtester: $listing" ;;
esac
case "$listing" in
  *"systemctl restart"*) pass "sudo -l lists the service-restart grants" ;;
  *) fail "sudo -l does not list systemctl restart: $listing" ;;
esac
pam=$(probe 'printf "x\n" | sudo -n /usr/bin/pamtester login tp-sandbox-proof-nouser authenticate; echo rc=$?')
case "$pam" in
  *"sudo:"*) fail "sudo itself refused the pamtester call: $pam" ;;
  *rc=0*) fail "pamtester accepted a user that does not exist: $pam" ;;
  *pamtester:*) pass "pamtester ran under sudo and PAM refused the unknown user" ;;
  *) fail "unexpected pamtester result: $pam" ;;
esac
net=$(probe 'exec 3<>/dev/tcp/github.com/443 && echo tcp-ok')
case "$net" in
  *tcp-ok*) pass "outbound DNS + TCP (github.com:443)" ;;
  *) fail "outbound TCP failed: $net" ;;
esac

echo "== 5. prompt stop"
start_ns=$(date +%s%N)
systemctl stop "$UNIT"
elapsed_ms=$((($(date +%s%N) - start_ns) / 1000000))
if [[ "$elapsed_ms" -lt $((STOP_BUDGET_SECONDS * 1000)) ]]; then
  pass "stop took ${elapsed_ms} ms"
else
  fail "stop took ${elapsed_ms} ms (budget ${STOP_BUDGET_SECONDS} s)"
fi
if journalctl -u "$UNIT" --since "$since" --no-pager 2>/dev/null | grep -Ei "stop-sigterm.*timed out|Killing process|SIGKILL|Failed with result 'timeout'"; then
  fail "stop was killed or timed out"
else
  pass "no SIGTERM timeout or SIGKILL in the journal"
fi
systemctl start "$UNIT"
if wait_healthy 40; then pass "health 200 after start"; else fail "health did not reach 200 after start"; fi

echo
if [[ "$FAILED" -eq 0 ]]; then
  echo "ALL PASS. Remaining manual step: click Update in the panel and watch the restart come back healthy."
  exit 0
fi
echo "$FAILED check(s) FAILED. Roll back: remove the sandbox block from turbopanel-instance.service.j2 and converge." >&2
exit 1
