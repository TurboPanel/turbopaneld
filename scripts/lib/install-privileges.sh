# POSIX privilege helpers for TurboPanel daemon install scripts.
# Piped entrypoints (run.sh, install.sh, daemon-install.sh) duplicate this logic
# inline because curl | sh has no checkout path to source from.

tp_is_root() {
	[ "$(id -u)" = "0" ]
}

tp_user_in_sudo_group() {
	_groups="$(id -nG 2>/dev/null)" || return 1
	for _g in $_groups; do
		case "$_g" in
		sudo | wheel | admin) return 0 ;;
		esac
	done
	return 1
}

tp_sudo_installed() {
	command -v sudo >/dev/null 2>&1
}

tp_install_privilege_denied() {
	_script="$1"
	if tp_user_in_sudo_group; then
		echo "$_script: run as root (su -); sudo is not installed yet — the daemon installer will install it" >&2
	else
		echo "$_script: must run as root or as a user in the sudo group" >&2
	fi
	exit 1
}

# Re-exec a curl | sh entrypoint under sudo when the invoking user is sudo-capable.
tp_reexec_piped_under_sudo() {
	_script="$1"
	_url="$2"
	shift 2

	if tp_is_root; then
		return 0
	fi
	if tp_user_in_sudo_group && tp_sudo_installed; then
		# shellcheck disable=SC2068
		exec curl -fsSL "$_url" | sudo sh -s -- "$@"
	fi
	tp_install_privilege_denied "$_script"
}
