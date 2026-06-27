# POSIX privilege helpers for TurboPanel daemon install scripts.
# Piped entrypoints (run.sh, the instance daemon-install.sh shim) duplicate this
# logic inline because curl | sh has no checkout path to source from.

tp_is_root() {
	[ "$(id -u)" = "0" ]
}

# True when prompts can use the controlling terminal (including curl | sh from a TTY).
tp_is_interactive() {
	if [ -t 0 ]; then
		return 0
	fi
	[ -r /dev/tty ] && [ -w /dev/tty ] 2>/dev/null
}

tp_sudo_installed() {
	command -v sudo >/dev/null 2>&1
}

# Validate real sudo capability (not group-name membership).
# Returns 0 when sudo works, 1 when sudo is installed but validation failed,
# 2 when sudo is not installed (first-install root fallback).
tp_validate_sudo() {
	if ! tp_sudo_installed; then
		return 2
	fi
	if sudo -n true 2>/dev/null; then
		return 0
	fi
	if tp_is_interactive; then
		if sudo -v 2>/dev/null; then
			return 0
		fi
	fi
	return 1
}

tp_install_privilege_denied() {
	_script="$1"
	_reason="${2:-}"
	case "$_reason" in
	no_sudo)
		echo "$_script: run as root (su -); sudo is not installed yet — the daemon installer will install it" >&2
		;;
	sudo_failed)
		echo "$_script: sudo validation failed — run as root or enter a valid sudo password" >&2
		;;
	*)
		echo "$_script: must run as root or have sudo privileges" >&2
		;;
	esac
	exit 1
}

# Re-exec a curl | sh entrypoint under sudo after validating real sudo access.
tp_reexec_piped_under_sudo() {
	_script="$1"
	_url="$2"
	shift 2

	if tp_is_root; then
		return 0
	fi
	_sudo_rc=0
	tp_validate_sudo || _sudo_rc=$?
	if [ "$_sudo_rc" -eq 2 ]; then
		tp_install_privilege_denied "$_script" no_sudo
	fi
	if [ "$_sudo_rc" -ne 0 ]; then
		tp_install_privilege_denied "$_script" sudo_failed
	fi
	# shellcheck disable=SC2068
	exec curl -fsSL "$_url" | sudo sh -s -- "$@"
}
