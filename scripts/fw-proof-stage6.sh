#!/usr/bin/env bash
# Canary proof for firewall stage 6 (fold TP-MANAGED-PUB into the managed rule
# set). READ-ONLY: it runs `iptables -S/-C/-L`, `iptables-save`, `ss` and
# `systemctl is-*`; it adds, changes and removes nothing. Run as root on a host
# with the daemon, in observe mode (nothing applied) or after an applied and
# confirmed ruleset:
#
#   sudo bash fw-proof-stage6.sh                 # check the host as it is now
#   sudo bash fw-proof-stage6.sh --save  /tmp/before.rules
#   ...  trigger an observe-mode reconcile from the panel  ...
#   sudo bash fw-proof-stage6.sh --compare /tmp/before.rules
#
# `--save` stores the filter-table rules (counters and comments of policy lines
# stripped); `--compare` proves an observe reconcile changed no rule, SSH and
# the control-plane port (8443, or 80/443) included.
#
# Prints PASS / FAIL / SKIP lines and exits 1 when any line is FAIL.
set -u

FAILED=0
CONFIG_DIR=${TURBOPANEL_CONFIG_DIR:-/etc/turbopanel}
RUN_DIR=${TURBOPANEL_RUN_DIR:-/run/turbopanel}
LIB_DIR=${TURBOPANEL_INSTALL_ROOT:-/opt/turbopanel}/lib
LEGACY_PARENT=TP-MANAGED-PUB
GUARD_TIMER=turbopanel-firewall-guard.timer
BOOT_UNIT=turbopanel-firewall.service

pass() {
  local message=$1
  printf 'PASS %s\n' "$message"
  return 0
}
skip() {
  local message=$1
  printf 'SKIP %s\n' "$message"
  return 0
}
fail() {
  local message=$1
  printf 'FAIL %s\n' "$message"
  FAILED=1
  return 0
}

ipt() {
  iptables -w 5 "$@"
  return $?
}
chain_exists() {
  local name=$1
  ipt -S "$name" >/dev/null 2>&1
  return $?
}
snapshot() {
  iptables-save -t filter 2>/dev/null | grep -v '^[#:]' | sed 's/ -m comment --comment "[^"]*"//'
  return 0
}

if [[ "$(id -u)" != "0" ]]; then
  echo "FAIL must run as root" >&2
  exit 1
fi
if ! command -v iptables >/dev/null 2>&1; then
  echo "FAIL iptables is not installed" >&2
  exit 1
fi

MODE=${1:-check}
FILE=${2:-}
case "$MODE" in
  --save)
    [[ -n "$FILE" ]] || { echo "usage: --save FILE" >&2; exit 2; }
    snapshot >"$FILE" && pass "saved $(wc -l <"$FILE") filter rules to $FILE"
    exit 0
    ;;
  --compare)
    [[ -f "${FILE:-}" ]] || { echo "usage: --compare FILE" >&2; exit 2; }
    if diff <(cat "$FILE") <(snapshot) >/dev/null; then
      pass "no filter rule changed since $FILE (SSH, 8443, tenant ports untouched)"
    else
      fail "filter rules differ from $FILE:"
      diff <(cat "$FILE") <(snapshot) | head -40
    fi
    exit "$FAILED"
    ;;
  check) ;;
  *)
    echo "usage: fw-proof-stage6.sh [--save FILE | --compare FILE]" >&2
    exit 2
    ;;
esac

# 1. Chains. Observe mode applies nothing, so the managed chains are absent
#    then; once a ruleset is applied both must exist and be hung.
APPLIED=0
if chain_exists TP-INPUT; then APPLIED=1; fi
if [[ "$APPLIED" = "1" ]]; then
  chain_exists TP-INPUT && pass "TP-INPUT present"
  if ipt -C INPUT -j TP-INPUT 2>/dev/null; then pass "INPUT jumps to TP-INPUT"; else fail "INPUT does not jump to TP-INPUT"; fi
  if chain_exists DOCKER-USER; then
    if chain_exists TP-FWD && ipt -C DOCKER-USER -j TP-FWD 2>/dev/null; then pass "TP-FWD present and hung off DOCKER-USER"; else fail "TP-FWD missing or not hung off DOCKER-USER"; fi
  else
    skip "DOCKER-USER absent (Docker not running): TP-FWD is re-hung when dockerd appears"
  fi
else
  pass "observe mode: no TurboPanel managed chains loaded (nothing applied)"
  if ipt -S INPUT 2>/dev/null | grep -q -- '-j TP-INPUT'; then fail "INPUT jumps to TP-INPUT although the chain is absent"; fi
fi

# TurboFabric's chain is not ours to fold: if it exists it must still be hung.
if chain_exists TP-FORWARD; then
  if ipt -S DOCKER-USER 2>/dev/null | grep -q -- '-j TP-FORWARD'; then pass "TurboFabric TP-FORWARD still hung (left alone)"; else skip "TP-FORWARD exists but is not hung (fabric off?)"; fi
else
  skip "no TurboFabric TP-FORWARD chain on this host"
fi

# 2. Legacy chain versus the managed rule set.
legacy_lines() {
  local child
  for child in $(ipt -S "$LEGACY_PARENT" 2>/dev/null | awk '$1=="-A"{print $4}' | grep -E '^TP-MGD-[a-z0-9]+$'); do
    ipt -S "$child" 2>/dev/null | grep '^-A '
  done
  return 0
}
field() {
  local line=$1 flag=$2
  printf '%s\n' "$line" | awk -v f="$flag" '{for(i=1;i<NF;i++) if($i==f){print $(i+1); exit}}'
  return 0
}
covered_source() {
  local rules=$1 port=$2 source=$3 line s
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    case "$line" in *"-j RETURN"*) ;; *) continue ;; esac
    [[ "$(field "$line" --ctorigdstport)" = "$port" ]] || continue
    s=$(field "$line" -s)
    if [[ "$s" = "$source" ]] || [[ "${s%/32}" = "${source%/32}" ]]; then return 0; fi
    if command -v python3 >/dev/null 2>&1 &&
      python3 -c 'import ipaddress,sys; sys.exit(0 if ipaddress.ip_network(sys.argv[2],False).subnet_of(ipaddress.ip_network(sys.argv[1],False)) else 1)' "$s" "$source" 2>/dev/null; then
      return 0
    fi
  done <<<"$rules"
  return 1
}
if chain_exists "$LEGACY_PARENT"; then
  LEGACY=$(legacy_lines)
  if [[ -z "$LEGACY" ]]; then
    pass "legacy $LEGACY_PARENT exists with no per-cluster rules"
  elif ! chain_exists TP-FWD; then
    pass "legacy $LEGACY_PARENT still protects managed listeners (TP-FWD not loaded: nothing folded, as intended)"
  else
    FWD=$(ipt -S TP-FWD 2>/dev/null)
    EQUIVALENT=1
    while IFS= read -r line; do
      [[ -n "$line" ]] || continue
      port=$(field "$line" --ctorigdstport)
      dest=$(field "$line" --ctorigdst)
      source=$(field "$line" -s)
      case "$line" in
        *"-j ACCEPT"*)
          if ! covered_source "$FWD" "$port" "$source"; then
            printf 'FAIL legacy admits %s to %s:%s but TP-FWD has no RETURN for it (kept legacy: fold will refuse)\n' "$source" "${dest:-*}" "$port"
            EQUIVALENT=0
          fi
          ;;
        *"-j DROP"*)
          if ! printf '%s\n' "$FWD" | grep -E -- "--ctorigdstport $port( |$)" | grep -q -- '-j DROP'; then
            printf 'FAIL legacy drops others on %s:%s but TP-FWD has no DROP for that port\n' "${dest:-*}" "$port"
            EQUIVALENT=0
          fi
          ;;
        *) ;;
      esac
    done <<<"$LEGACY"
    if [[ "$EQUIVALENT" = "1" ]]; then
      pass "derived TP-FWD is equivalent to legacy $LEGACY_PARENT (fold may remove it: turbopaneld firewall fold)"
    else
      FAILED=1
    fi
  fi
else
  pass "no legacy $LEGACY_PARENT chain (folded, or no public managed listener)"
fi

# 3. Rollback guard.
PENDING=$RUN_DIR/firewall-pending.json
if [[ -f "$PENDING" ]]; then
  if systemctl is-active --quiet "$GUARD_TIMER"; then pass "ruleset pending and $GUARD_TIMER is armed"; else fail "ruleset pending but $GUARD_TIMER is NOT active"; fi
else
  if systemctl is-active --quiet "$GUARD_TIMER"; then fail "$GUARD_TIMER is active with no pending ruleset"; else pass "no pending ruleset; guard timer idle (armed only during a confirm window)"; fi
fi
if [[ -x "$LIB_DIR/tp-firewall-guard" ]]; then pass "guard script installed at $LIB_DIR/tp-firewall-guard"; else fail "guard script missing at $LIB_DIR/tp-firewall-guard"; fi
if systemctl is-enabled --quiet "$BOOT_UNIT" 2>/dev/null; then pass "$BOOT_UNIT enabled (boot restore)"; else fail "$BOOT_UNIT not enabled"; fi

# 4. SSH and the control-plane port stay reachable. In observe mode no INPUT
#    rule of ours exists at all; applied, TP-INPUT must ACCEPT them.
SSH_PORTS=$(ss -Hltn 2>/dev/null | awk '{print $4}' | sed 's/.*://' | sort -u | grep -x -E '22|2222' || true)
[[ -n "$SSH_PORTS" ]] || SSH_PORTS=22
check_port_open() {
  local port=$1 label=$2
  if [[ "$APPLIED" = "1" ]]; then
    if ipt -S TP-INPUT 2>/dev/null | grep -E -- "--dport $port( |$)" | grep -q -- '-j ACCEPT'; then
      pass "$label port $port is ACCEPTed by TP-INPUT"
    else
      fail "$label port $port has no ACCEPT in TP-INPUT"
    fi
  elif ipt -S INPUT 2>/dev/null | grep -E -- "--dport $port( |$)" | grep -q -E -- '-j (DROP|REJECT)'; then
    fail "$label port $port is blocked by an INPUT rule"
  else
    pass "$label port $port: no TurboPanel rule touches it (observe mode)"
  fi
  return 0
}
for port in $SSH_PORTS; do check_port_open "$port" "SSH"; done
if systemctl is-active --quiet turbopanel-instance.service; then
  if ss -Hltn 2>/dev/null | awk '{print $4}' | grep -q ':8443$'; then check_port_open 8443 "control-plane"; else skip "co-located panel is not on 8443 (80/443 under Let's Encrypt)"; fi
else
  skip "no co-located control plane on this host"
fi

exit "$FAILED"
