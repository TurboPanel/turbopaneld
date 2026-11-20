#!/usr/bin/env bash
# Proof that container image builds run under the image-build CPU slice and that
# its quota is honoured. Run as root on a managed host with Docker:
#
#   sudo bash image-build-cgroup-proof.sh [CORES]
#
# CORES defaults to 1. It calls `tp-host image-build-slice CORES`, then builds a
# throwaway image whose RUN step burns CPU on every core, with the same
# `--cgroup-parent` the daemon passes, and proves, exiting non-zero on failure:
#   1. the verb prints the slice's cgroup path and the slice's cpu.max is
#      CORES * 100000 per 100000 microseconds (and a second call changes
#      nothing, so the verb is idempotent);
#   2. while the RUN step runs, its process sits below that cgroup (read from
#      the host's /proc/<pid>/cgroup; inside the build the cgroup is hidden);
#   3. the quota is honoured: the CPU time the slice used over the sample window
#      stays within 25 percent of CORES * the window.
set -u

TP_HOST=${TP_HOST:-/opt/turbopanel/lib/tp-host}
CORES=${1:-1}
SLICE_CGROUP=/turbopanel.slice/turbopanel-imagebuild.slice
SLICE_DIR=/sys/fs/cgroup$SLICE_CGROUP
WINDOW_SECONDS=8
FAILED=0
WORK=""
BUILD_PID=""

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
  return 0
}
trap cleanup EXIT

if [[ "$(id -u)" -ne 0 ]]; then
  echo "run as root" >&2
  exit 2
fi
if [[ ! -x "$TP_HOST" ]]; then
  echo "tp-host not found at $TP_HOST (set TP_HOST)" >&2
  exit 2
fi

echo "== 1. the slice and its quota"
printed=$("$TP_HOST" image-build-slice "$CORES")
if [[ "$printed" = "$SLICE_CGROUP" ]]; then pass "verb printed $printed"; else fail "verb printed '$printed'"; fi
want="$((CORES * 100000)) 100000"
got=$(cat "$SLICE_DIR/cpu.max" 2>/dev/null)
if [[ "$got" = "$want" ]]; then pass "cpu.max is '$got'"; else fail "cpu.max is '$got', expected '$want'"; fi
"$TP_HOST" image-build-slice "$CORES" >/dev/null
if [[ "$(cat "$SLICE_DIR/cpu.max" 2>/dev/null)" = "$want" ]]; then pass "a second call changes nothing"; else fail "a second call changed cpu.max"; fi

echo "== 2. a build lands in the slice"
WORK=$(mktemp -d "${HOME:-/root}/image-build-proof.XXXXXX")
workers=$(nproc)
cat >"$WORK/Dockerfile" <<DOCKERFILE
FROM busybox
RUN for i in \$(seq $workers); do (while :; do :; done) & done; sleep 30; kill \$(jobs -p)
DOCKERFILE
docker buildx build --builder default --no-cache --cgroup-parent "$SLICE_CGROUP" \
  --tag tp-image-build-cgroup-proof "$WORK" >"$WORK/build.log" 2>&1 &
BUILD_PID=$!
found=""
for _ in $(seq 40); do
  pid=$(pgrep -f 'sleep 30' | head -n 1)
  if [[ -n "$pid" ]] && grep -q "turbopanel-imagebuild.slice" "/proc/$pid/cgroup" 2>/dev/null; then
    found=$(cat "/proc/$pid/cgroup")
    break
  fi
  sleep 1
done
if [[ -n "$found" ]]; then pass "RUN process cgroup: $found"; else fail "no RUN process under the image-build slice"; fi

echo "== 3. the quota is honoured"
start=$(awk '$1 == "usage_usec" { print $2 }' "$SLICE_DIR/cpu.stat")
sleep "$WINDOW_SECONDS"
end=$(awk '$1 == "usage_usec" { print $2 }' "$SLICE_DIR/cpu.stat")
used=$((end - start))
limit=$((CORES * WINDOW_SECONDS * 1000000))
printf 'used %s us over %s s, quota allows %s us (host has %s cores)\n' "$used" "$WINDOW_SECONDS" "$limit" "$workers"
if [[ "$used" -gt 0 && "$used" -le $((limit * 125 / 100)) ]]; then
  pass "CPU time stays within the quota"
else
  fail "CPU time $used us is outside 0..$((limit * 125 / 100)) us"
fi

if [[ "$FAILED" -gt 0 ]]; then
  echo "$FAILED check(s) failed" >&2
  exit 1
fi
echo "all checks passed"
