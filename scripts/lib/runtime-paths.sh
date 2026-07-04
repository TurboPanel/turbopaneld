# TurboPanel vendored runtime root (POSIX sh).
# Source after paths are needed; override with TURBOPANEL_RUNTIMES_DIR.

TURBOPANEL_HOME="${TURBOPANEL_HOME:-/opt/turbopanel}"
TURBOPANEL_RUNTIMES_DIR="${TURBOPANEL_RUNTIMES_DIR:-${TURBOPANEL_RUNTIME_DIR:-${TURBOPANEL_HOME}/vendor}}"
RUNTIMES_DIR="${RUNTIMES_DIR:-$TURBOPANEL_RUNTIMES_DIR}"
export TURBOPANEL_HOME TURBOPANEL_RUNTIMES_DIR RUNTIMES_DIR

# #region agent log
if [ -n "${TURBOPANEL_DEBUG_LOG:-}" ]; then
  printf '{"sessionId":"56c179","hypothesisId":"A","location":"runtime-paths.sh","message":"runtime paths resolved","data":{"TURBOPANEL_RUNTIMES_DIR":"%s","RUNTIMES_DIR":"%s"},"timestamp":%s}\n' \
    "$TURBOPANEL_RUNTIMES_DIR" "$RUNTIMES_DIR" "$(date +%s)000" >> "$TURBOPANEL_DEBUG_LOG" 2>/dev/null || true
fi
# #endregion
