#!/usr/bin/env bash
# Check whether container image build steps run under their build's CPU slice
# and stay within its quota. Run as root on a managed host with Docker:
#
#   sudo bash image-build-cgroup-proof.sh [CORES]
#
# THIS CHECK FAILS TODAY, BY DESIGN. The pinned Railpack frontend ignores
# `--cgroup-parent`, so its build steps land in the Engine's own cgroup and are
# not CPU limited. It exits non-zero until that is fixed, and is the check to
# re-run when the build-step cap work resumes. Do not weaken it to pass.
#
# It builds through the same path the daemon uses: the Railpack CLI makes a
# plan, then `docker buildx build` runs with the daemon's exact argv (see
# imageBuildBuildxArgs in src/deploy/release/image-build.ts) and the pinned
# frontend. The build id is per run, so the slice is the build's own one.
#
# Environment:
#   TP_HOST        tp-host path (default /opt/turbopanel/lib/tp-host)
#   RAILPACK       the Railpack CLI (default: railpack on PATH), same version as
#                  the frontend
#   FRONTEND_REF   the frontend reference, ideally the pinned
#                  ghcr.io/railwayapp/railpack-frontend:v0.9.0@sha256:<digest>
#
# Exits 0 only when every check passes, 1 when one fails, 2 when it cannot run.
#   1. the slice exists with cpu.max = CORES * 100000 per 100000 (fractional
#      cores work) and a second call changes nothing;
#   2. while the build step runs, its process sits below the build's slice
#      (read from the host's /proc/<pid>/cgroup; inside the build it is hidden).
#      The cgroup it ran in is always printed;
#   3. the CPU time the slice used over the sample window stays within 25
#      percent of CORES * the window.
set -u

TP_HOST=${TP_HOST:-/opt/turbopanel/lib/tp-host}
RAILPACK=${RAILPACK:-railpack}
FRONTEND_REF=${FRONTEND_REF:-ghcr.io/railwayapp/railpack-frontend:v0.9.0}
CORES=${1:-1}
BUILD_ID="proof-$(date +%Y%m%d-%H%M%S)"
WINDOW_SECONDS=8
FAILED=0
WORK=""
BUILD_PID=""
SLICE_DIR=""

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
  [[ -n "$BUILD_PID" ]] && kill "$BUILD_PID" 2>/dev/null
  [[ -n "$WORK" ]] && rm -rf "$WORK"
  docker image rm -f tp-image-build-cgroup-proof >/dev/null 2>&1
  "$TP_HOST" image-build-slice-remove "$BUILD_ID" >/dev/null 2>&1
  return 0
}
trap cleanup EXIT

if [[ "$(id -u)" -ne 0 ]]; then
  echo "run as root" >&2
  exit 2
fi
for tool in "$TP_HOST" "$(command -v "$RAILPACK" || true)"; do
  if [[ -z "$tool" || ! -x "$tool" ]]; then
    echo "missing tool (set TP_HOST and RAILPACK): '$tool'" >&2
    exit 2
  fi
done

echo "== 1. the build's slice and its quota"
printed=$("$TP_HOST" image-build-slice "$BUILD_ID" "$CORES") || {
  echo "image-build-slice failed" >&2
  exit 2
}
cgroup=$(printf '%s\n' "$printed" | tail -n 2 | head -n 1)
SLICE_DIR=/sys/fs/cgroup$cgroup
case "$cgroup" in
  /turbopanel.slice/turbopanel-imagebuild.slice/turbopanel-imagebuild-*.slice) pass "verb printed $cgroup" ;;
  *) fail "verb printed an unexpected cgroup '$cgroup'" ;;
esac
want=$(awk -v c="$CORES" 'BEGIN { printf "%d 100000", c * 100000 + 0.5 }')
got=$(cat "$SLICE_DIR/cpu.max" 2>/dev/null)
if [[ "$got" = "$want" ]]; then pass "cpu.max is '$got'"; else fail "cpu.max is '$got', expected '$want'"; fi
"$TP_HOST" image-build-slice "$BUILD_ID" "$CORES" >/dev/null
if [[ "$(cat "$SLICE_DIR/cpu.max" 2>/dev/null)" = "$want" ]]; then pass "a second call changes nothing"; else fail "a second call changed cpu.max"; fi

echo "== 2. the build step lands in the slice"
WORK=$(mktemp -d "${HOME:-/root}/image-build-proof.XXXXXX")
workers=$(nproc)
cat >"$WORK/railpack.json" <<JSON
{"provider":"shell","steps":{"burn":{"commands":[{"cmd":"sh -c \"for i in \$(seq $workers); do (while :; do :; done) & done; sleep 25\""}]}},"deploy":{"inputs":[{"step":"burn"}]}}
JSON
printf '#!/bin/sh\nexit 0\n' >"$WORK/start.sh"
(cd "$WORK" && "$RAILPACK" prepare . --plan-out "$WORK/plan.json") >"$WORK/prepare.log" 2>&1 || {
  echo "railpack prepare failed:" >&2
  cat "$WORK/prepare.log" >&2
  exit 2
}
docker buildx build --builder default --progress=plain \
  --cgroup-parent "$cgroup" \
  --provenance=false --sbom=false \
  --build-arg "BUILDKIT_SYNTAX=$FRONTEND_REF" \
  --build-arg "cache-key=$BUILD_ID" \
  --file "$WORK/plan.json" --tag tp-image-build-cgroup-proof --load "$WORK" \
  >"$WORK/build.log" 2>&1 &
BUILD_PID=$!
found=""
for _ in $(seq 60); do
  pid=$(pgrep -fx 'sleep 25' | head -n 1)
  if [[ -n "$pid" ]]; then
    found=$(cat "/proc/$pid/cgroup" 2>/dev/null)
    break
  fi
  sleep 1
done
if [[ -z "$found" ]]; then
  fail "the build step never started (see $WORK/build.log)"
else
  printf 'build step ran in: %s\n' "$found"
  case "$found" in
    *"$cgroup"*) pass "the build step is below the build's slice" ;;
    *) fail "the build step is NOT below $cgroup: image build steps are not CPU limited" ;;
  esac
fi

echo "== 3. the quota is honoured"
start=$(awk '$1 == "usage_usec" { print $2 }' "$SLICE_DIR/cpu.stat")
sleep "$WINDOW_SECONDS"
end=$(awk '$1 == "usage_usec" { print $2 }' "$SLICE_DIR/cpu.stat")
used=$((end - start))
limit=$(awk -v c="$CORES" -v w="$WINDOW_SECONDS" 'BEGIN { printf "%d", c * w * 1000000 }')
ceiling=$((limit * 125 / 100))
printf 'slice used %s us over %s s, quota allows %s us (host has %s cores)\n' "$used" "$WINDOW_SECONDS" "$limit" "$workers"
if [[ "$used" -gt 0 && "$used" -le "$ceiling" ]]; then
  pass "CPU time stays within the quota"
else
  fail "slice CPU time $used us is outside 1..$ceiling us"
fi

if [[ "$FAILED" -gt 0 ]]; then
  echo "$FAILED check(s) failed: image build steps are not CPU limited yet" >&2
  exit 1
fi
echo "all checks passed"
