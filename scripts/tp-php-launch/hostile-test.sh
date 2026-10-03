#!/usr/bin/env bash
# Hostile tests for tp-php-launch: argv, environment, registry tampering,
# symlinks, wrong caller, non-socket stdin, target-user and lsphp-tree abuse.
#
# DESTRUCTIVE: run only as root on a disposable Linux machine (a CI runner or
# a privileged container). It creates accounts (tpols, alice, bob, tpevil, …),
# /srv/users, /etc/turbopanel-php-sites and /opt/turbopanel/{lib,vendor}.
#
#   sudo bash scripts/tp-php-launch/hostile-test.sh [LAUNCHER]
#
# LAUNCHER is a prebuilt binary to test (the release build from
# scripts/build-tp-php-launch.sh); without it the source is compiled with cc.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HERE="$ROOT/scripts/tp-php-launch"
[[ "$(id -u)" == 0 ]] || { echo "hostile-test: run as root on a disposable host" >&2; exit 2; }
[[ "${TP_PHP_LAUNCH_DISPOSABLE:-}" == 1 ]] || {
	echo "hostile-test: set TP_PHP_LAUNCH_DISPOSABLE=1 to confirm this host is disposable" >&2
	exit 2
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
CFLAGS=(-std=c11 -O2 -Wall -Wextra -Werror)
cc "${CFLAGS[@]}" -o "$WORK/sockwrap" "$HERE/sockwrap.c"
cc "${CFLAGS[@]}" -o "$WORK/fake-lsphp" "$HERE/fake-lsphp.c"
if [[ -n "${1:-}" ]]; then
	cp "$1" "$WORK/tp-php-launch"
else
	cc "${CFLAGS[@]}" -Wconversion -Wshadow -o "$WORK/tp-php-launch" "$ROOT/orchestration/scripts/tp-php-launch.c"
fi
chmod 0755 "$WORK" "$WORK/sockwrap"

LAUNCH=/opt/turbopanel/lib/tp-php-launch
REG=/etc/turbopanel-php-sites
VENDOR=/opt/turbopanel/vendor/lsphp
SITE=shop-1
CONF=/etc/turbopanel/php/sites/$SITE
SOCK=/run/tp-php-launch-test/lsphp.sock
REPORT=tp-php-launch-report
FAIL=0
PASS=0

# --- accounts (idempotent) ------------------------------------------------------
group() { getent group "$1" >/dev/null || groupadd -g "$2" "$1"; }
account() { # name uid group home
	getent passwd "$1" >/dev/null || useradd -u "$2" -g "$3" -d "$4" -M -s /usr/sbin/nologin "$1"
}
group tpphplaunch 9981
group tpols 9990
account tpols 9990 tpols /nonexistent
group tpnginx 9992
account tpnginx 9992 tpnginx /nonexistent
usermod -a -G tpphplaunch tpols
# A second member, only so the caller check itself is exercised.
usermod -a -G tpphplaunch tpnginx
group tp 9999
account tp 9999 tp /nonexistent
group tpphp83 9901
group tpphp84 9902
for spec in alice:15001 bob:15002 tpevil:15003 carol:15004; do
	name="${spec%%:*}"
	id="${spec#*:}"
	group "$name-grp" "$id"
	account "$name" "$id" "$name-grp" "/srv/users/$name/home"
done
for u in alice tpevil carol; do usermod -a -G tpphp84 "$u"; done

# --- the good world, rebuilt before every case ------------------------------------
registry() { # [key=value ...] overrides, written in the canonical order
	local kv out=""
	local -A v=(
		[version]=1 [site]="$SITE" [mode]=lsphp-attached [user]=alice [uid]=15001
		[group]=alice-grp [gid]=15001 [home]=/srv/users/alice/home
		[tmp]=/srv/users/alice/tmp [php]=8.4 [bin]="$VENDOR/8.4/current/bin/lsphp"
		[ini]="/etc/turbopanel/php/sites/$SITE/php.ini" [children]=10
	)
	for kv in "$@"; do v[${kv%%=*}]="${kv#*=}"; done
	for k in version site mode user uid group gid home tmp php bin ini children; do
		[[ -n "${v[$k]+x}" && "${v[$k]}" != "<unset>" ]] && out+="$k=${v[$k]}"$'\n'
	done
	printf '%s' "$out"
}

reset_world() {
	rm -rf "$REG" /srv/users /opt/turbopanel "${SOCK%/*}" /etc/turbopanel
	install -d -m 1777 "${SOCK%/*}"
	# tp's config tree (tp:tp 0750, so the owner cannot traverse it) holding
	# the site's root:<owner>-grp config directory, as tp-host lays it out.
	install -d -m 0750 -o tp -g tp /etc/turbopanel
	install -d -m 0600 -o tp -g tp /etc/turbopanel/secrets
	install -d -m 0755 -o root -g root /etc/turbopanel/php /etc/turbopanel/php/sites
	install -d -m 0750 -o root -g alice-grp "$CONF"
	printf 'memory_limit = 128M\n' > "$CONF/php.ini"
	chown root:alice-grp "$CONF/php.ini"
	chmod 0640 "$CONF/php.ini"
	install -d -m 0755 -o root -g root /srv/users /opt/turbopanel /opt/turbopanel/lib \
		/opt/turbopanel/vendor "$VENDOR" "$REG"
	for u in alice bob tpevil carol; do
		install -d -m 0755 -o root -g root "/srv/users/$u"
		install -d -m 0750 -o "$u" -g "$u-grp" "/srv/users/$u/home"
		install -d -m 0700 -o "$u" -g "$u-grp" "/srv/users/$u/tmp"
	done
	install -d -m 0750 -o root -g tpphp84 "$VENDOR/8.4" "$VENDOR/8.4/8.4.25" "$VENDOR/8.4/8.4.25/bin"
	install -m 0750 -o root -g tpphp84 "$WORK/fake-lsphp" "$VENDOR/8.4/8.4.25/bin/lsphp"
	ln -sfn 8.4.25 "$VENDOR/8.4/current"
	install -m 4750 -o root -g tpphplaunch "$WORK/tp-php-launch" "$LAUNCH"
	registry version=1 > "$REG/$SITE"
	chmod 0644 "$REG/$SITE"
	rm -f "/srv/users/alice/tmp/$REPORT" "/tmp/$REPORT"
}

# launch AS KIND PATH CMD...: CMD as AS, with a stdin of KIND (sockwrap.c) at
# PATH ("--" is the test socket).
LAST_ERR=""
LAST_RC=0
launch() {
	local as="$1" kind="$2" path="$3"
	shift 3
	[[ "$path" == "--" ]] && path="$SOCK"
	set +e
	LAST_ERR="$(runuser -u "$as" -- "$WORK/sockwrap" "$kind" "$path" "$@" 2>&1 >/dev/null)"
	LAST_RC=$?
	set -e
}

ok() { PASS=$((PASS + 1)); }
bad() {
	FAIL=$((FAIL + 1))
	echo "FAIL: $*" >&2
}
expect() { # DESCRIPTION COMMAND...
	local what="$1"
	shift
	if "$@"; then ok; else bad "$what"; fi
}

# refused NAME EXPECTED-REASON: exit 1, the reason logged, lsphp never ran.
refused() {
	local name="$1" reason="$2"
	if [[ "$LAST_RC" != 1 ]]; then bad "$name: exit $LAST_RC, want 1 ($LAST_ERR)"; return; fi
	if [[ "$LAST_ERR" != *"$reason"* ]]; then bad "$name: logged '$LAST_ERR', want '$reason'"; return; fi
	if [[ -e "/srv/users/alice/tmp/$REPORT" || -e "/tmp/$REPORT" ]]; then bad "$name: lsphp ran"; return; fi
	ok
}

# hostile NAME REASON SETUP [KIND PATH CMD...]: reset, run SETUP, then launch
# as tpols (by default `lsapi <site>` on a listening socket).
hostile() {
	local name="$1" reason="$2" setup="$3"
	shift 3
	reset_world
	eval "$setup"
	if [[ $# -eq 0 ]]; then set -- listen -- "$LAUNCH" lsapi "$SITE"; fi
	launch tpols "$@"
	refused "$name" "$reason"
}

# --- the one good launch --------------------------------------------------------
reset_world
launch tpols listen -- /usr/bin/env LD_PRELOAD=/nonexistent.so PHPRC=/tmp/evil LSAPI_CHILDREN=999 \
	PHP_INI_SCAN_DIR=/tmp "$LAUNCH" lsapi "$SITE"
R="/srv/users/alice/tmp/$REPORT"
if [[ "$LAST_RC" != 0 || ! -f "$R" ]]; then
	bad "good launch: exit $LAST_RC, report missing ($LAST_ERR)"
else
	want() { if grep -qxF -- "$1" "$R"; then ok; else bad "good launch: no '$1' in report"; fi; }
	never() { if grep -qE -- "$1" "$R"; then bad "good launch: report matches '$1'"; else ok; fi; }
	want "uid=15001,15001,15001"
	want "gid=15001,15001,15001"
	want "group=15001"
	want "group=9902"
	expect "good launch: exactly two groups" test "$(grep -c '^group=' "$R")" = 2
	want "argv0=lsphp"
	want "argc=1"
	want "env=PATH=/usr/local/bin:/usr/bin:/bin"
	want "env=TMPDIR=/tmp"
	want "env=PHPRC=/etc/turbopanel/php/sites/$SITE/php.ini"
	want "env=PHP_LSAPI_CHILDREN=10"
	want "env=LSAPI_AVOID_FORK=200M"
	expect "good launch: exactly five environment variables" test "$(grep -c '^env=' "$R")" = 5
	never "LD_PRELOAD|/tmp/evil|=999|PHP_INI_SCAN_DIR"
	want "phprc.readable=1"
	want "etc_turbopanel=php"
	expect "good launch: only php/ under /etc/turbopanel" test "$(grep -c '^etc_turbopanel=' "$R")" = 1
	want "stdin.listening=1"
	want "umask=022"
	want "rlimit.core=0"
	want "cwd=/"
	want "setuid0=-1"
	want $'status.NoNewPrivs:\t1'
	want $'status.CapEff:\t0000000000000000'
	want $'status.CapPrm:\t0000000000000000'
	want $'status.CapAmb:\t0000000000000000'
	expect "good launch: only fds 0-2" test "$(grep '^fd=' "$R" | tr '\n' ' ')" = "fd=0 fd=1 fd=2 "
	expect "good launch: report not alice's" test "$(stat -c %U "$R")" = alice
fi
expect "good launch: wrote the host /tmp" test ! -e "/tmp/$REPORT"

# --- argv -----------------------------------------------------------------------
L="$LAUNCH"
hostile "no args" "usage" ":" listen -- "$L"
hostile "mode only" "usage" ":" listen -- "$L" lsapi
hostile "extra arg" "usage" ":" listen -- "$L" lsapi "$SITE" x
hostile "other mode" "usage" ":" listen -- "$L" fcgi "$SITE"
hostile "upper case site" "usage" ":" listen -- "$L" lsapi Shop-1
hostile "dotdot site" "usage" ":" listen -- "$L" lsapi ../shop-1
hostile "slash site" "usage" ":" listen -- "$L" lsapi a/b
hostile "leading dash" "usage" ":" listen -- "$L" lsapi -x
hostile "empty site" "usage" ":" listen -- "$L" lsapi ""
hostile "65-char site" "usage" ":" listen -- "$L" lsapi "$(printf 'a%.0s' {1..65})"
hostile "newline site" "usage" ":" listen -- "$L" lsapi $'shop-1\n'
hostile "option" "usage" ":" listen -- "$L" --help

# --- caller ---------------------------------------------------------------------
reset_world
launch tpnginx listen -- "$LAUNCH" lsapi "$SITE"
refused "tpnginx in tpphplaunch" "caller is not tpols"
reset_world
launch root listen -- "$LAUNCH" lsapi "$SITE"
refused "root caller" "caller is not tpols"
reset_world
launch bob listen -- "$LAUNCH" lsapi "$SITE"
expect "bob ran the launcher" test "$LAST_RC" != 0 -a ! -e "/srv/users/alice/tmp/$REPORT"
reset_world
launch alice listen -- "$LAUNCH" lsapi "$SITE"
expect "alice ran the launcher" test "$LAST_RC" != 0 -a ! -e "/srv/users/alice/tmp/$REPORT"

# --- registry -------------------------------------------------------------------
E="$REG/$SITE"
hostile "no entry" "no registry entry" "rm -f $E"
hostile "mode php-fpm" "mode is not lsphp-attached" "registry mode=php-fpm > $E"
hostile "uid 0" "uid outside" "registry uid=0 > $E"
hostile "uid tp" "uid outside" "registry uid=9999 > $E"
hostile "uid 60001" "uid outside" "registry uid=60001 > $E"
hostile "uid leading zero" "uid outside" "registry uid=015001 > $E"
hostile "uid sign" "uid outside" "registry uid=+15001 > $E"
hostile "gid 0" "gid outside" "registry gid=0 > $E"
hostile "tp user" "user name" "registry user=tpevil uid=15003 gid=15003 group=tpevil-grp home=/srv/users/tpevil/home tmp=/srv/users/tpevil/tmp > $E"
hostile "root user" "group is not" "registry user=root > $E"
hostile "user uid mismatch" "user does not match passwd" "registry uid=15002 > $E"
hostile "other owner's ids" "user does not match passwd" "registry user=bob group=bob-grp home=/srv/users/bob/home tmp=/srv/users/bob/tmp > $E"
hostile "group mismatch" "group is not <user>-grp" "registry group=bob-grp > $E"
hostile "home elsewhere" "home" "registry home=/root > $E"
hostile "tmp elsewhere" "tmp" "registry tmp=/tmp > $E"
hostile "ini elsewhere" "ini" "registry ini=/tmp/php.ini > $E"
hostile "bin elsewhere" "bin" "registry bin=/bin/sh > $E"
hostile "php series unknown" "PHP series not in this build" "registry php=7.4 > $E"
hostile "site mismatch" "registry site" "registry site=other > $E"
hostile "version 2" "registry version" "registry version=2 > $E"
hostile "children 0" "children" "registry children=0 > $E"
hostile "children 65" "children" "registry children=65 > $E"
hostile "missing key" "registry key missing" "registry children='<unset>' > $E"
hostile "unknown key" "registry key unknown" "{ registry; echo 'LD_PRELOAD=/x.so'; } > $E"
hostile "duplicate key" "registry key repeated" "{ registry; echo 'uid=0'; } > $E"
hostile "CRLF" "registry value character" "registry | sed 's/\$/\\r/' > $E"
hostile "space in value" "registry value character" "registry 'ini=/etc/turbopanel/php/sites/$SITE/php.ini x' > $E"
hostile "no final newline" "newline" "registry | head -c -1 > $E"
hostile "empty file" "registry size" ": > $E"
hostile "blank line" "without =" "{ echo; registry; } > $E"
hostile "oversize" "registry" "{ registry; head -c 5000 /dev/zero | tr '\\0' a; echo; } > $E"
hostile "group-writable entry" "root:root" "chmod 0664 $E"
hostile "world-writable entry" "root:root" "chmod 0646 $E"
hostile "entry owned by alice" "root:root" "chown alice $E"
hostile "entry group alice" "root:root" "chgrp alice-grp $E"
hostile "setuid entry" "root:root" "chmod 4644 $E"
hostile "hard-linked entry" "one link" "ln $E $REG/linked"
hostile "symlinked entry" "no registry entry" "mv $E $REG/real && ln -s real $E"
hostile "entry is a directory" "root:root" "rm $E && mkdir $E"
hostile "entry is a fifo" "root:root" "rm $E && mkfifo -m 0644 $E"
hostile "symlinked registry dir" "$REG" "mv $REG /etc/tp-reg-real && ln -s /etc/tp-reg-real $REG"
hostile "registry dir not root's" "$REG" "chown tpols $REG"
hostile "registry dir group-writable" "$REG" "chmod 0775 $REG"
rm -rf /etc/tp-reg-real

# --- target user ----------------------------------------------------------------
hostile "not entitled to the series" "not entitled" "gpasswd -d alice tpphp84 >/dev/null" listen -- "$LAUNCH" lsapi "$SITE"
usermod -a -G tpphp84 alice
hostile "passwd home moved" "user does not match passwd" "usermod -d /srv/users/alice alice" listen -- "$LAUNCH" lsapi "$SITE"
usermod -d /srv/users/alice/home alice
hostile "tmp is a symlink" "owner tmp" "rmdir /srv/users/alice/tmp && ln -s /srv/users/bob/tmp /srv/users/alice/tmp"
hostile "tmp owned by bob" "owner tmp" "chown bob /srv/users/alice/tmp"
hostile "tmp world-writable" "owner tmp mode" "chmod 1777 /srv/users/alice/tmp"
hostile "tmp missing" "/srv/users/alice/tmp" "rmdir /srv/users/alice/tmp"
hostile "principal home not sealed" "/srv/users/alice/tmp" "chown alice /srv/users/alice"
hostile "principal root writable" "/srv/users/alice/tmp" "chmod 0777 /srv/users"

# --- site config ------------------------------------------------------------------
hostile "config dir missing" "$CONF" "rm -rf $CONF"
hostile "config dir a symlink" "site config directory" "mv $CONF /etc/turbopanel/php/real && ln -s real $CONF"
hostile "config dir bob's group" "site config directory" "chgrp bob-grp $CONF"
hostile "config dir group-writable" "site config directory" "chmod 0770 $CONF"
hostile "config dir tp-owned" "site config directory" "chown tp $CONF"
hostile "php/ swapped by tp" "$CONF" "mv /etc/turbopanel/php /etc/turbopanel/php.old && runuser -u tp -- mkdir -p $CONF"
hostile "sites/ tp-owned" "$CONF" "chown tp /etc/turbopanel/php/sites"
hostile "config root a symlink" "$CONF" "mv /etc/turbopanel /etc/tp-real && ln -s tp-real /etc/turbopanel"
hostile "php.ini missing" "site php.ini" "rm $CONF/php.ini"
hostile "php.ini a symlink" "site php.ini" "mv $CONF/php.ini $CONF/real.ini && ln -s real.ini $CONF/php.ini"
hostile "php.ini group-writable" "site php.ini" "chmod 0660 $CONF/php.ini"
hostile "php.ini tp-owned" "site php.ini" "chown tp $CONF/php.ini"
rm -rf /etc/tp-real

# --- stdin ----------------------------------------------------------------------
hostile "stdin a file" "stdin not a socket" ":" file "$REG/$SITE" "$LAUNCH" lsapi "$SITE"
hostile "stdin /dev/null" "stdin not a socket" ":" file /dev/null "$LAUNCH" lsapi "$SITE"
# libc reopens a closed fd 0-2 on /dev/null for a setuid program (AT_SECURE).
hostile "stdin closed" "stdin not a socket" ":" closed -- "$LAUNCH" lsapi "$SITE"
hostile "stdin dgram" "stdin not a stream socket" ":" dgram -- "$LAUNCH" lsapi "$SITE"
hostile "stdin unlistened" "stdin not listening" ":" unlistened -- "$LAUNCH" lsapi "$SITE"
hostile "stdin tcp" "stdin not AF_UNIX" ":" tcp -- "$LAUNCH" lsapi "$SITE"

# --- lsphp tree -----------------------------------------------------------------
B="$VENDOR/8.4/8.4.25/bin/lsphp"
hostile "current escapes" "$VENDOR/8.4/current/bin/lsphp" "ln -sfn ../../x $VENDOR/8.4/current"
hostile "current absolute" "$VENDOR/8.4/current/bin/lsphp" "ln -sfn /bin $VENDOR/8.4/current"
hostile "binary group-writable" "lsphp binary" "chmod 0770 $B"
hostile "binary setuid" "lsphp binary" "chmod 4750 $B"
hostile "binary not root's" "lsphp binary" "chown tpols $B"
hostile "binary is a symlink" "lsphp binary" "mv $B $B.real && ln -s lsphp.real $B"
hostile "bin dir writable" "$VENDOR/8.4/current/bin/lsphp" "chmod 0770 $VENDOR/8.4/8.4.25/bin"
hostile "vendor not root's" "$VENDOR/8.4/current/bin/lsphp" "chown tpols /opt/turbopanel/vendor"

# --- the binary itself ----------------------------------------------------------
reset_world
chmod 0755 "$LAUNCH"
launch tpols listen -- "$LAUNCH" lsapi "$SITE"
refused "not setuid" "not running setuid root"
reset_world
launch tpols listen -- /usr/bin/setpriv --no-new-privs "$LAUNCH" lsapi "$SITE"
refused "caller set no_new_privs" "not running setuid root"

rm -rf "$REG" /srv/users /opt/turbopanel "${SOCK%/*}" /etc/turbopanel
echo "hostile-test: $PASS passed, $FAIL failed"
[[ "$FAIL" == 0 ]]
