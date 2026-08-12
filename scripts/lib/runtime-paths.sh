# TurboPanel vendored runtime root (POSIX sh).
# Source after paths are needed; override with TURBOPANEL_RUNTIMES_DIR.

TURBOPANEL_HOME="${TURBOPANEL_HOME:-/opt/turbopanel}"
TURBOPANEL_RUNTIMES_DIR="${TURBOPANEL_RUNTIMES_DIR:-${TURBOPANEL_HOME}/vendor}"
RUNTIMES_DIR="${RUNTIMES_DIR:-$TURBOPANEL_RUNTIMES_DIR}"
export TURBOPANEL_HOME TURBOPANEL_RUNTIMES_DIR RUNTIMES_DIR

# Apple Silicon hypervisors (UTM/Parallels) often advertise SVE2 without
# implementing it; cryptography 47+ / OpenSSL then SIGILL on ansible-playbook.
# Match daemon runtimeEnv() — harmless on real aarch64 and x86_64. Keep this in
# the shared paths lib so sudo/root ansible wrappers inherit it even when the
# caller profile is stripped (sudo env_reset).
export OPENSSL_armcap="${OPENSSL_armcap:-0}"
