#!/bin/sh
# Remove TurboPanel from a managed host.
#
# This script lives only in the repository. Release packages do not ship it,
# and workers/turbopanel-sh does not serve it.
#
# Canonical command (must already be root — there is no sudo re-exec):
#   curl -fsSL https://raw.githubusercontent.com/TurboPanel/turbopaneld/trunk/scripts/uninstall.sh | sudo sh
#
# From a checkout:
#   sudo sh uninstall.sh
#   sudo sh uninstall.sh --dry-run
#
# --dry-run still requires root and a controlling terminal. There is no
# non-interactive bypass. Detection only changes labels and warnings; every
# removal step runs for whichever install is found, including a partial one.
#
# Option 2 calls tp_purge_hosted_data after the remove-only steps. That deletes
# principal accounts and homes, Docker Engine, data folders, and apt packages.
# Every purge command goes through tp_run, so --dry-run only logs it.
#
# After confirmation, option 2 writes a root-only purge-in-progress marker and
# a resume manifest under /var/lib/turbopanel-uninstall. The marker is outside
# the trees purge deletes. A later run resumes purge when that marker is
# present, including when inventory markers are already gone. Docker being
# installed is not itself a TurboPanel install. The manifest reloads discovered
# config, state, log, run, backup, and principal roots. --dry-run does not
# write either file. Both are removed only after purge finishes with no
# failures.

# shellcheck shell=sh

# --- printers (same trio as scripts/run.sh, plus a log line and a warning) ---

tp_log_line() {
  [ -n "${TP_LOG_FILE:-}" ] || return 0
  printf '%s\n' "$1" >> "$TP_LOG_FILE" 2>/dev/null || true
}

tp_print_step() {
  _glyph="$1"; _msg="$2"
  if [ -t 1 ]; then
    printf '\033[36m%s\033[0m %s\n' "$_glyph" "$_msg"
  else
    printf '%s %s\n' "$_glyph" "$_msg"
  fi
  tp_log_line "$_glyph $_msg"
}

tp_print_ok() {
  _msg="$1"
  if [ -t 1 ]; then
    printf '\033[32m✓\033[0m %s\n' "$_msg"
  else
    printf '✓ %s\n' "$_msg"
  fi
  tp_log_line "✓ $_msg"
}

tp_print_error() {
  _msg="$1"
  if [ -t 2 ]; then
    printf '\033[31m✗\033[0m %s\n' "$_msg" >&2
  else
    printf '✗ %s\n' "$_msg" >&2
  fi
  tp_log_line "✗ $_msg"
}

tp_print_warn() {
  _msg="$1"
  if [ -t 2 ]; then
    printf '\033[33m!\033[0m %s\n' "$_msg" >&2
  else
    printf '! %s\n' "$_msg" >&2
  fi
  tp_log_line "! $_msg"
}

tp_say() {
  printf '%s\n' "$1"
  tp_log_line "$1"
}

# stdin is the script under `curl | sh`, so prompts use the controlling terminal.
tp_is_interactive() {
  if [ -t 0 ]; then
    return 0
  fi
  ( : </dev/tty >/dev/tty ) 2>/dev/null
}

tp_read_tty() {
  _tty_prompt=$1
  printf '%s' "$_tty_prompt" >/dev/tty
  if ! IFS= read -r _tty_answer </dev/tty; then
    return 1
  fi
  printf '%s' "$_tty_answer"
  return 0
}

# --- bookkeeping ------------------------------------------------------------

tp_record_fail() {
  TP_FAIL_COUNT=$((TP_FAIL_COUNT + 1))
  if [ -n "${TP_TMP:-}" ]; then
    printf '%s\n' "$1" >> "$TP_TMP/failed"
  fi
  tp_log_line "FAIL: $1"
}

tp_record_skip() {
  tp_print_warn "SKIPPED: $1"
  if [ -n "${TP_TMP:-}" ]; then
    printf '%s\n' "SKIPPED: $1" >> "$TP_TMP/skipped"
  fi
}

# The post-removal inventory is only a diff. Repeating "tool not installed"
# there would list the same skip twice in the summary.
tp_inv_skip() {
  if [ "${TP_INV_QUIET:-false}" = true ]; then
    return 0
  fi
  tp_record_skip "$1"
}

tp_inv_warn() {
  if [ "${TP_INV_QUIET:-false}" = true ]; then
    return 0
  fi
  tp_print_warn "$1"
}

tp_inv_keep_previous() {
  _ikp=$1
  if [ "${TP_INV_QUIET:-false}" = true ] && [ -f "$TP_TMP/before.${_ikp}" ]; then
    cp "$TP_TMP/before.${_ikp}" "$TP_TMP/inv.${_ikp}"
  fi
}

tp_has_tool() {
  command -v "$1" >/dev/null 2>&1
}

# tp_run "description" command arg...
# Dry-run logs the command and returns success. Otherwise the exit status is
# the command's, and a non-zero status is recorded (the script keeps going).
tp_run() {
  _tp_run_desc=$1
  shift
  if [ "$#" -eq 0 ]; then
    tp_record_fail "$_tp_run_desc"
    return 1
  fi
  _tp_run_show=
  for _tp_run_arg in "$@"; do
    _tp_run_show="${_tp_run_show} ${_tp_run_arg}"
  done
  if [ "$DRY_RUN" = true ]; then
    tp_print_step "·" "[dry-run] would run:${_tp_run_show}"
    printf '%s\n' "[dry-run] $_tp_run_desc" >> "$TP_TMP/removed"
    return 0
  fi
  tp_print_step "▸" "$_tp_run_desc"
  tp_log_line "run:${_tp_run_show}"
  # Capture the status before any later command. An if/fi with no else
  # reports 0 when the condition fails, which would hide a real failure.
  "$@" >> "$TP_LOG_FILE" 2>&1
  _tp_run_status=$?
  if [ "$_tp_run_status" -eq 0 ]; then
    tp_log_line "ok: $_tp_run_desc"
    printf '%s\n' "$_tp_run_desc" >> "$TP_TMP/removed"
    return 0
  fi
  tp_log_line "fail (${_tp_run_status}): $_tp_run_desc"
  tp_record_fail "$_tp_run_desc"
  tp_print_error "$_tp_run_desc failed"
  return "$_tp_run_status"
}

tp_file_add() {
  _fa_file=$1
  _fa_item=$2
  [ -n "$_fa_item" ] || return 0
  if [ -f "$_fa_file" ] && grep -Fxq "$_fa_item" "$_fa_file"; then
    return 0
  fi
  printf '%s\n' "$_fa_item" >> "$_fa_file"
}

tp_ws_add() {
  _ws_list=$1
  _ws_item=$2
  [ -n "$_ws_item" ] || {
    printf '%s' "$_ws_list"
    return 0
  }
  for _ws_existing in $_ws_list; do
    if [ "$_ws_existing" = "$_ws_item" ]; then
      printf '%s' "$_ws_list"
      return 0
    fi
  done
  if [ -z "$_ws_list" ]; then
    printf '%s' "$_ws_item"
  else
    printf '%s %s' "$_ws_list" "$_ws_item"
  fi
}

tp_list_has_word() {
  _lhw_needle=$1
  shift
  for _lhw_word in "$@"; do
    if [ "$_lhw_word" = "$_lhw_needle" ]; then
      return 0
    fi
  done
  return 1
}

tp_legacy_lists_aligned() {
  # shellcheck disable=SC2086
  _lla=$(printf '%s\n' $TP_LEGACY_ACCOUNTS | awk 'END { print NR+0 }')
  # shellcheck disable=SC2086
  _llb=$(printf '%s\n' $TP_LEGACY_ACCOUNT_IDS | awk 'END { print NR+0 }')
  [ "$_lla" = "$_llb" ]
}

# --- paths ------------------------------------------------------------------

tp_normalize_path() {
  _np=$1
  while :; do
    case $_np in
      //*) _np=${_np#/} ;;
      *) break ;;
    esac
  done
  while [ "$_np" != / ] && [ "${_np%/}" != "$_np" ]; do
    _np=${_np%/}
  done
  printf '%s' "$_np"
}

# Same refusals as tp_safe_rm_tree: empty, relative, "..", and filesystem roots.
tp_path_is_safe() {
  _pis=$1
  [ -n "$_pis" ] || return 1
  case $_pis in
    /*) ;;
    *) return 1 ;;
  esac
  case $_pis in
    *..*) return 1 ;;
    *[[:space:]]*) return 1 ;;
  esac
  _pis=$(tp_normalize_path "$_pis")
  case $_pis in
    /|/etc|/var|/srv|/opt|/usr|/home|/root|/tmp) return 1 ;;
  esac
  return 0
}

tp_path_present() {
  [ -e "$1" ] || [ -L "$1" ]
}

tp_is_mountpoint() {
  _imp=$1
  if tp_has_tool mountpoint; then
    mountpoint -q "$_imp"
    return $?
  fi
  awk -v p="$_imp" '$2 == p { found = 1 } END { exit !found }' /proc/mounts 2>/dev/null
}

# A mount kept on purpose is cleared when its own filesystem has nothing left
# under it. Nested mounts and other leftovers still count as contents.
tp_empty_retained_mount() {
  _erm=$1
  [ -d "$_erm" ] || return 1
  [ -L "$_erm" ] && return 1
  tp_is_mountpoint "$_erm" || return 1
  _erm_left=$(find "$_erm" -mindepth 1 -print -quit 2>/dev/null || true)
  [ -z "$_erm_left" ]
}

tp_safe_rm_tree() {
  _srt=$1
  if ! tp_path_is_safe "$_srt"; then
    tp_record_fail "refusing unsafe path ${_srt:-<empty>}"
    tp_print_error "refusing unsafe path ${_srt:-<empty>}"
    return 1
  fi
  _srt=$(tp_normalize_path "$_srt")
  if [ -L "$_srt" ]; then
    # Unlink the symlink only. The resolved target was not inventoried on its
    # own, so following it would delete a directory the operator was not shown.
    _srt_dest=$(readlink "$_srt" 2>/dev/null || true)
    tp_run "remove symlink $_srt" rm -f "$_srt" || true
    if [ -n "$_srt_dest" ]; then
      tp_print_warn "symlink $_srt pointed at $_srt_dest; removed the link and kept the target"
    fi
    return 0
  fi
  if [ ! -e "$_srt" ]; then
    return 0
  fi
  if tp_is_mountpoint "$_srt"; then
    # Keep the mount, drop only what this filesystem holds at that path.
    tp_run "clear contents of mount $_srt" find "$_srt" -mindepth 1 -xdev -delete || true
    return 0
  fi
  tp_run "remove $_srt" rm -rf "$_srt" || true
  return 0
}

tp_env_file_value() {
  _efv_file=$1
  _efv_key=$2
  [ -f "$_efv_file" ] || return 0
  _efv_line=$(grep -E "^(export[[:space:]]+)?${_efv_key}=" "$_efv_file" 2>/dev/null | head -n 1 || true)
  [ -n "$_efv_line" ] || return 0
  _efv_val=${_efv_line#*=}
  _efv_val=$(printf '%s' "$_efv_val" | tr -d '\r')
  case $_efv_val in
    \"*)
      _efv_val=${_efv_val#\"}
      _efv_val=${_efv_val%\"}
      ;;
    \'*)
      _efv_val=${_efv_val#\'}
      _efv_val=${_efv_val%\'}
      ;;
  esac
  printf '%s' "$_efv_val"
}

tp_discover_add() {
  _da_kind=$1
  _da_path=$2
  _da_source=$3
  [ -n "$_da_path" ] || return 0
  _da_path=$(tp_normalize_path "$_da_path")
  if ! tp_path_is_safe "$_da_path"; then
    tp_print_warn "ignoring unsafe ${_da_kind} path: ${_da_path}"
    return 0
  fi
  case $_da_kind in
    config)
      TP_CONFIG_DIRS=$(tp_ws_add "$TP_CONFIG_DIRS" "$_da_path")
      ;;
    state)
      TP_STATE_DIRS=$(tp_ws_add "$TP_STATE_DIRS" "$_da_path")
      ;;
    log)
      TP_LOG_DIRS=$(tp_ws_add "$TP_LOG_DIRS" "$_da_path")
      ;;
    runtimes)
      TP_RUNTIMES_DIRS=$(tp_ws_add "$TP_RUNTIMES_DIRS" "$_da_path")
      ;;
    run)
      TP_RUN_DIRS=$(tp_ws_add "$TP_RUN_DIRS" "$_da_path")
      ;;
    backup)
      TP_BACKUP_DIRS=$(tp_ws_add "$TP_BACKUP_DIRS" "$_da_path")
      if [ "$_da_source" = explicit ]; then
        TP_BACKUP_EXPLICIT=true
      fi
      ;;
    principal)
      TP_PRINCIPAL_HOME_ROOTS=$(tp_ws_add "$TP_PRINCIPAL_HOME_ROOTS" "$_da_path")
      if [ "$_da_source" = explicit ]; then
        TP_PRINCIPAL_EXPLICIT=true
      fi
      ;;
    *)
      TP_OTHER_DIRS=$(tp_ws_add "$TP_OTHER_DIRS" "$_da_path")
      ;;
  esac
  return 0
}

tp_classify_discovered_path() {
  _cdp=$1
  _cdp_source=$2
  case $_cdp in
    /etc/turbopanel|/etc/turbopanel/*) tp_discover_add config "$_cdp" "$_cdp_source" ;;
    /var/lib/turbopanel|/var/lib/turbopanel/*) tp_discover_add state "$_cdp" "$_cdp_source" ;;
    /var/log/turbopanel|/var/log/turbopanel/*) tp_discover_add log "$_cdp" "$_cdp_source" ;;
    /opt/turbopanel/vendor|/opt/turbopanel/vendor/*) tp_discover_add runtimes "$_cdp" "$_cdp_source" ;;
    /run/turbopanel|/run/turbopanel/*|/var/run/turbopanel|/var/run/turbopanel/*)
      tp_discover_add run "$_cdp" "$_cdp_source"
      ;;
    /backup|/backup/*) tp_discover_add backup "$_cdp" "$_cdp_source" ;;
    /srv/users|/srv/users/*) tp_discover_add principal "$_cdp" "$_cdp_source" ;;
    *turbopanel*)
      tp_discover_add other "$_cdp" "$_cdp_source"
      ;;
    *)
      tp_print_warn "tmpfiles or unit path does not match a known folder: $_cdp"
      ;;
  esac
}

tp_take_env_key() {
  _tek_file=$1
  _tek_key=$2
  _tek_kind=$3
  _tek_val=$(tp_env_file_value "$_tek_file" "$_tek_key")
  [ -n "$_tek_val" ] || return 0
  tp_discover_add "$_tek_kind" "$_tek_val" explicit
}

tp_discover_from_env_file() {
  _def_file=$1
  [ -f "$_def_file" ] || return 0
  tp_take_env_key "$_def_file" TURBOPANEL_CONFIG_DIR config
  tp_take_env_key "$_def_file" TURBOPANEL_STATE_DIR state
  tp_take_env_key "$_def_file" TURBOPANEL_DAEMON_STATE_DIR state
  tp_take_env_key "$_def_file" STATE_DIR state
  tp_take_env_key "$_def_file" TURBOPANEL_LOG_DIR log
  tp_take_env_key "$_def_file" LOG_DIR log
  tp_take_env_key "$_def_file" TURBOPANEL_RUNTIMES_DIR runtimes
  tp_take_env_key "$_def_file" RUNTIMES_DIR runtimes
  tp_take_env_key "$_def_file" TURBOPANEL_RUN_DIR run
  tp_take_env_key "$_def_file" RUN_DIR run
  tp_take_env_key "$_def_file" TURBOPANEL_BACKUP_DIR backup
  tp_take_env_key "$_def_file" BACKUP_DIR backup
  tp_take_env_key "$_def_file" TURBOPANEL_PRINCIPAL_HOME_ROOT principal
  tp_take_env_key "$_def_file" PRINCIPAL_HOME_ROOT principal
}

tp_blob_value() {
  _bv_blob=$1
  _bv_key=$2
  # Split on spaces so STATE_DIR does not match inside TURBOPANEL_STATE_DIR.
  _bv_hit=$(printf '%s\n' "$_bv_blob" | tr ' ' '\n' | grep -E "^${_bv_key}=" | head -n 1 || true)
  [ -n "$_bv_hit" ] || return 0
  _bv_val=${_bv_hit#*=}
  case $_bv_val in
    \"*)
      _bv_val=${_bv_val#\"}
      _bv_val=${_bv_val%\"}
      ;;
    \'*)
      _bv_val=${_bv_val#\'}
      _bv_val=${_bv_val%\'}
      ;;
  esac
  printf '%s' "$_bv_val"
}

tp_discover_from_units() {
  _dfu_list=$TP_TMP/unit-env-files
  : > "$_dfu_list"
  for _dfu_dir in $TP_SYSTEMD_DIRS; do
    [ -d "$_dfu_dir" ] || continue
    find "$_dfu_dir" -maxdepth 3 -type f -name '*turbopanel*' >> "$_dfu_list" 2>/dev/null || true
  done
  if [ -s "$_dfu_list" ]; then
    while IFS= read -r _dfu_file; do
      [ -n "$_dfu_file" ] || continue
      case $_dfu_file in
        *turbopanel*) ;;
        *) continue ;;
      esac
      _dfu_envfiles=$TP_TMP/envfiles.one
      : > "$_dfu_envfiles"
      grep -E '^EnvironmentFile=' "$_dfu_file" > "$TP_TMP/envfile.lines" 2>/dev/null || true
      while IFS= read -r _dfu_eline; do
        [ -n "$_dfu_eline" ] || continue
        _dfu_epath=${_dfu_eline#EnvironmentFile=}
        _dfu_epath=${_dfu_epath#-}
        printf '%s\n' "$_dfu_epath" >> "$_dfu_envfiles"
      done < "$TP_TMP/envfile.lines"
      while IFS= read -r _dfu_epath; do
        [ -n "$_dfu_epath" ] || continue
        tp_discover_from_env_file "$_dfu_epath"
      done < "$_dfu_envfiles"
      grep -E '^Environment=' "$_dfu_file" 2>/dev/null > "$TP_TMP/env.lines" || true
      while IFS= read -r _dfu_line; do
        [ -n "$_dfu_line" ] || continue
        _dfu_blob=${_dfu_line#Environment=}
        tp_apply_env_blob "$_dfu_blob"
      done < "$TP_TMP/env.lines"
    done < "$_dfu_list"
  fi
  if tp_has_tool systemctl; then
    for _dfu_unit in turbopaneld.service turbopanel-instance.service; do
      _dfu_blob=$(systemctl show -p Environment --value "$_dfu_unit" 2>/dev/null || true)
      [ -n "$_dfu_blob" ] || continue
      tp_apply_env_blob "$_dfu_blob"
    done
  fi
}

tp_apply_env_blob() {
  _aeb=$1
  _aeb_key=
  for _aeb_key in \
    TURBOPANEL_CONFIG_DIR \
    TURBOPANEL_STATE_DIR \
    TURBOPANEL_DAEMON_STATE_DIR \
    STATE_DIR \
    TURBOPANEL_LOG_DIR \
    LOG_DIR \
    TURBOPANEL_RUNTIMES_DIR \
    RUNTIMES_DIR \
    TURBOPANEL_RUN_DIR \
    RUN_DIR \
    TURBOPANEL_BACKUP_DIR \
    BACKUP_DIR \
    TURBOPANEL_PRINCIPAL_HOME_ROOT \
    PRINCIPAL_HOME_ROOT
  do
    _aeb_val=$(tp_blob_value "$_aeb" "$_aeb_key")
    [ -n "$_aeb_val" ] || continue
    case $_aeb_val in
      \"*)
        _aeb_val=${_aeb_val#\"}
        _aeb_val=${_aeb_val%\"}
        ;;
    esac
    case $_aeb_key in
      TURBOPANEL_CONFIG_DIR) tp_discover_add config "$_aeb_val" explicit ;;
      TURBOPANEL_STATE_DIR|TURBOPANEL_DAEMON_STATE_DIR|STATE_DIR) tp_discover_add state "$_aeb_val" explicit ;;
      TURBOPANEL_LOG_DIR|LOG_DIR) tp_discover_add log "$_aeb_val" explicit ;;
      TURBOPANEL_RUNTIMES_DIR|RUNTIMES_DIR) tp_discover_add runtimes "$_aeb_val" explicit ;;
      TURBOPANEL_RUN_DIR|RUN_DIR) tp_discover_add run "$_aeb_val" explicit ;;
      TURBOPANEL_BACKUP_DIR|BACKUP_DIR) tp_discover_add backup "$_aeb_val" explicit ;;
      TURBOPANEL_PRINCIPAL_HOME_ROOT|PRINCIPAL_HOME_ROOT) tp_discover_add principal "$_aeb_val" explicit ;;
    esac
  done
}

tp_discover_from_tmpfiles() {
  _dft=/etc/tmpfiles.d/turbopanel.conf
  [ -f "$_dft" ] || return 0
  while IFS= read -r _dft_line; do
    case $_dft_line in
      ''|\#*) continue ;;
    esac
    set -f
    # shellcheck disable=SC2086
    set -- $_dft_line
    set +f
    [ "$#" -ge 2 ] || continue
    case $2 in
      /*) tp_classify_discovered_path "$2" explicit ;;
    esac
  done < "$_dft"
}

# Resume state lives outside every tree purge deletes. A symlink is never
# followed: the marker is how a rerun knows a confirmed purge did not finish.
tp_purge_marker_pending() {
  [ -L "$TP_PURGE_MARKER" ] && return 1
  [ -f "$TP_PURGE_MARKER" ]
}

tp_resume_prepare_dir() {
  if [ -L "$TP_RESUME_DIR" ]; then
    tp_print_error "refusing purge resume state through a symlink"
    tp_record_fail "refusing purge resume state through a symlink"
    return 1
  fi
  if [ -e "$TP_RESUME_DIR" ] && [ ! -d "$TP_RESUME_DIR" ]; then
    tp_print_error "purge resume path is not a directory"
    tp_record_fail "purge resume path is not a directory"
    return 1
  fi
  if [ ! -d "$TP_RESUME_DIR" ]; then
    if ! mkdir -m 0700 "$TP_RESUME_DIR"; then
      tp_record_fail "could not create $TP_RESUME_DIR"
      return 1
    fi
  fi
  if ! chmod 0700 "$TP_RESUME_DIR"; then
    tp_record_fail "could not restrict $TP_RESUME_DIR"
    return 1
  fi
  return 0
}

tp_secure_replace() {
  _sr_dest=$1
  _sr_src=$2
  if [ -L "$_sr_dest" ] || [ -d "$_sr_dest" ]; then
    tp_print_error "refusing to replace $_sr_dest"
    tp_record_fail "refusing to replace $_sr_dest"
    rm -f "$_sr_src"
    return 1
  fi
  if ! mv -f "$_sr_src" "$_sr_dest"; then
    tp_record_fail "could not write $_sr_dest"
    rm -f "$_sr_src"
    return 1
  fi
  if ! chmod 0600 "$_sr_dest"; then
    tp_record_fail "could not restrict $_sr_dest"
    return 1
  fi
  return 0
}

tp_manifest_append_paths() {
  _map_file=$1
  _map_kind=$2
  shift 2
  for _map_path in "$@"; do
    [ -n "$_map_path" ] || continue
    printf 'path %s %s\n' "$_map_kind" "$_map_path" >> "$_map_file"
  done
}

tp_manifest_note_explicit_path() {
  _mnep_kind=$1
  _mnep_path=$2
  _mnep_path=$(tp_normalize_path "$_mnep_path")
  if [ "$_mnep_kind" = backup ] && [ "$_mnep_path" != /backup ]; then
    TP_BACKUP_EXPLICIT=true
  fi
  if [ "$_mnep_kind" = principal ] && [ "$_mnep_path" != /srv/users ]; then
    TP_PRINCIPAL_EXPLICIT=true
  fi
}

tp_load_resume_manifest() {
  [ -e "$TP_RESUME_MANIFEST" ] || [ -L "$TP_RESUME_MANIFEST" ] || return 0
  if [ -L "$TP_RESUME_MANIFEST" ] || [ ! -f "$TP_RESUME_MANIFEST" ]; then
    tp_print_warn "ignoring unsafe resume manifest ${TP_RESUME_MANIFEST}"
    return 0
  fi
  while IFS= read -r _lrm_line || [ -n "$_lrm_line" ]; do
    case $_lrm_line in
      ''|\#*) continue ;;
    esac
    set -f
    # shellcheck disable=SC2086
    set -- $_lrm_line
    set +f
    case ${1:-} in
      flag)
        [ "${3:-}" = true ] || continue
        case ${2:-} in
          backup_explicit) TP_BACKUP_EXPLICIT=true ;;
          principal_explicit) TP_PRINCIPAL_EXPLICIT=true ;;
        esac
        ;;
      path)
        [ -n "${2:-}" ] && [ -n "${3:-}" ] || continue
        case $2 in
          config|state|log|run|backup|principal) ;;
          *) continue ;;
        esac
        tp_discover_add "$2" "$3" manifest
        tp_manifest_note_explicit_path "$2" "$3"
        ;;
      docker_data_root)
        [ -n "${2:-}" ] || continue
        if [ "$2" = unknown ]; then
          TP_DOCKER_DATA_ROOT_SAVED_UNKNOWN=true
          continue
        fi
        if tp_path_is_safe "$2"; then
          TP_DOCKER_DATA_ROOT_SAVED=$(tp_normalize_path "$2")
        else
          tp_print_warn "ignoring unsafe Docker data root in resume manifest"
        fi
        ;;
    esac
  done < "$TP_RESUME_MANIFEST"
}

tp_write_resume_manifest_body() {
  _wrmb=$1
  : > "$_wrmb"
  printf '%s\n' "# turbopanel-uninstall resume manifest" >> "$_wrmb"
  if [ "$TP_BACKUP_EXPLICIT" = true ]; then
    printf '%s\n' "flag backup_explicit true" >> "$_wrmb"
  fi
  if [ "$TP_PRINCIPAL_EXPLICIT" = true ]; then
    printf '%s\n' "flag principal_explicit true" >> "$_wrmb"
  fi
  set -f
  # shellcheck disable=SC2086
  tp_manifest_append_paths "$_wrmb" config $TP_CONFIG_DIRS
  # shellcheck disable=SC2086
  tp_manifest_append_paths "$_wrmb" state $TP_STATE_DIRS
  # shellcheck disable=SC2086
  tp_manifest_append_paths "$_wrmb" log $TP_LOG_DIRS
  # shellcheck disable=SC2086
  tp_manifest_append_paths "$_wrmb" run $TP_RUN_DIRS
  # shellcheck disable=SC2086
  tp_manifest_append_paths "$_wrmb" backup $TP_BACKUP_DIRS
  # shellcheck disable=SC2086
  tp_manifest_append_paths "$_wrmb" principal $TP_PRINCIPAL_HOME_ROOTS
  set +f
  if [ "$TP_DOCKER_DATA_ROOT_STATUS" = custom ] && [ -n "$TP_DOCKER_DATA_ROOT" ]; then
    printf 'docker_data_root %s\n' "$TP_DOCKER_DATA_ROOT" >> "$_wrmb"
  elif [ "$TP_DOCKER_DATA_ROOT_STATUS" = unknown ]; then
    printf '%s\n' "docker_data_root unknown" >> "$_wrmb"
  fi
}

tp_persist_purge_resume() {
  # Dry-run must not leave a marker or rewrite the manifest.
  [ "$DRY_RUN" = true ] && return 0
  tp_resume_prepare_dir || return 1
  tp_write_resume_manifest_body "$TP_TMP/resume-manifest.body"
  _ppr_manifest=$(umask 077; mktemp "$TP_RESUME_DIR/manifest.XXXXXX") || {
    tp_record_fail "could not create resume manifest"
    return 1
  }
  if [ -L "$_ppr_manifest" ] || [ ! -f "$_ppr_manifest" ]; then
    rm -f "$_ppr_manifest"
    tp_record_fail "could not create resume manifest"
    return 1
  fi
  if ! cat "$TP_TMP/resume-manifest.body" > "$_ppr_manifest"; then
    rm -f "$_ppr_manifest"
    tp_record_fail "could not write resume manifest"
    return 1
  fi
  if ! tp_secure_replace "$TP_RESUME_MANIFEST" "$_ppr_manifest"; then
    return 1
  fi
  _ppr_marker=$(umask 077; mktemp "$TP_RESUME_DIR/marker.XXXXXX") || {
    rm -f "$TP_RESUME_MANIFEST"
    tp_record_fail "could not create purge marker"
    return 1
  }
  if [ -L "$_ppr_marker" ] || [ ! -f "$_ppr_marker" ]; then
    rm -f "$_ppr_marker" "$TP_RESUME_MANIFEST"
    tp_record_fail "could not create purge marker"
    return 1
  fi
  if ! printf '%s\n' purge > "$_ppr_marker"; then
    rm -f "$_ppr_marker" "$TP_RESUME_MANIFEST"
    tp_record_fail "could not write purge marker"
    return 1
  fi
  if ! tp_secure_replace "$TP_PURGE_MARKER" "$_ppr_marker"; then
    rm -f "$TP_RESUME_MANIFEST"
    return 1
  fi
  return 0
}

tp_clear_purge_resume() {
  [ "$DRY_RUN" = true ] && return 0
  if [ -L "$TP_RESUME_DIR" ] || [ -L "$TP_PURGE_MARKER" ] || [ -L "$TP_RESUME_MANIFEST" ]; then
    tp_record_fail "refusing to clear purge resume state through a symlink"
    return 1
  fi
  rm -f "$TP_PURGE_MARKER" "$TP_RESUME_MANIFEST" || {
    tp_record_fail "could not clear purge resume state"
    return 1
  }
  if [ -d "$TP_RESUME_DIR" ]; then
    rmdir "$TP_RESUME_DIR" 2>/dev/null || true
  fi
  if tp_purge_marker_pending || [ -f "$TP_RESUME_MANIFEST" ]; then
    tp_record_fail "could not clear purge resume state"
    return 1
  fi
  return 0
}

tp_discover_paths() {
  # Production defaults from src/paths/layout.ts. Later sources add more paths;
  # a partial install can disagree with itself, so every distinct path is kept.
  tp_discover_add config /etc/turbopanel default
  tp_discover_add state /var/lib/turbopanel default
  tp_discover_add log /var/log/turbopanel default
  tp_discover_add runtimes /opt/turbopanel/vendor default
  tp_discover_add run /run/turbopanel default
  tp_discover_add backup /backup default
  tp_discover_add principal /srv/users default
  tp_discover_from_env_file "$TP_DAEMON_ENV"
  tp_discover_from_units
  tp_discover_from_tmpfiles
  # A previous purge may already have deleted the files these paths came from.
  tp_load_resume_manifest
}

# --- dev-environment refusal ------------------------------------------------

tp_execstart_has_main_ts() {
  if tp_has_tool systemctl; then
    _eh_show=$(systemctl show -p ExecStart --value turbopaneld.service 2>/dev/null || true)
    case $_eh_show in
      *main.ts*) return 0 ;;
    esac
  fi
  for _eh_dir in $TP_SYSTEMD_DIRS; do
    if [ -f "$_eh_dir/turbopaneld.service" ] && grep -F 'main.ts' "$_eh_dir/turbopaneld.service" >/dev/null 2>&1; then
      return 0
    fi
    for _eh_drop in "$_eh_dir/turbopaneld.service.d/"*.conf; do
      [ -f "$_eh_drop" ] || continue
      if grep -F 'main.ts' "$_eh_drop" >/dev/null 2>&1; then
        return 0
      fi
    done
  done
  return 1
}

tp_refuse_dev_environment() {
  _rde=
  _rde_mode=$(tp_env_file_value "$TP_DAEMON_ENV" TURBOPANEL_MODE)
  if [ "$_rde_mode" = development ]; then
    _rde="TURBOPANEL_MODE=development"
  fi
  if [ -z "$_rde" ]; then
    _rde_root=$(tp_env_file_value "$TP_DAEMON_ENV" TURBOPANEL_DEV_ROOT)
    if [ -n "$_rde_root" ]; then
      _rde="TURBOPANEL_DEV_ROOT is set"
    fi
  fi
  if [ -z "$_rde" ]; then
    _rde_user=$(tp_env_file_value "$TP_DAEMON_ENV" TURBOPANEL_DEV_USER)
    if [ -n "$_rde_user" ]; then
      _rde="TURBOPANEL_DEV_USER is set"
    fi
  fi
  if [ -z "$_rde" ] && [ -e /etc/sudoers.d/turbopanel-dev-nopasswd ]; then
    _rde="/etc/sudoers.d/turbopanel-dev-nopasswd exists"
  fi
  if [ -z "$_rde" ] && [ -e /etc/turbopanel/dev-forward-hosts ]; then
    _rde="/etc/turbopanel/dev-forward-hosts exists"
  fi
  if [ -z "$_rde" ] && tp_execstart_has_main_ts; then
    _rde="turbopaneld.service ExecStart runs main.ts"
  fi
  [ -n "$_rde" ] || return 0
  tp_print_error "This host is a TurboPanel development environment (${_rde}). Nothing was changed."
  tp_print_error "Use ~/dev/console → Developer → Reset development environment / Purge completely."
  exit 1
}

# --- inventory --------------------------------------------------------------

tp_inv_reset() {
  for _ir_name in $TP_INV_NAMES; do
    : > "$TP_TMP/inv.${_ir_name}"
  done
}

tp_snapshot_inventory() {
  for _si_name in $TP_INV_NAMES; do
    cp "$TP_TMP/inv.${_si_name}" "$TP_TMP/before.${_si_name}"
  done
}

tp_inventory_empty() {
  for _ie_name in $TP_INV_NAMES; do
    # purge_targets repeats data paths for the post-purge diff. A default
    # backup directory must not, by itself, look like an installation, and
    # neither does an unrelated Docker data root.
    [ "$_ie_name" = purge_targets ] && continue
    if [ -s "$TP_TMP/inv.${_ie_name}" ]; then
      return 1
    fi
  done
  return 0
}

tp_print_group() {
  _pg_title=$1
  _pg_file=$2
  tp_say "$_pg_title"
  if [ ! -s "$_pg_file" ]; then
    tp_say "  (none)"
    return 0
  fi
  while IFS= read -r _pg_line; do
    [ -n "$_pg_line" ] || continue
    tp_say "  ${_pg_line}"
  done < "$_pg_file"
}

tp_unit_present() {
  _up_unit=$1
  if tp_has_tool systemctl; then
    _up_load=$(systemctl show -p LoadState --value "$_up_unit" 2>/dev/null || true)
    if [ -n "$_up_load" ] && [ "$_up_load" != not-found ]; then
      return 0
    fi
  fi
  for _up_dir in $TP_SYSTEMD_DIRS; do
    if [ -e "$_up_dir/$_up_unit" ]; then
      return 0
    fi
  done
  return 1
}

tp_note_unit() {
  _nu=$1
  [ -n "$_nu" ] || return 0
  _nu_base=$(basename "$_nu")
  # shellcheck disable=SC2086
  if tp_list_has_word "$_nu_base" $TP_LEGACY_UNITS || tp_list_has_word "$_nu" $TP_LEGACY_UNITS; then
    tp_file_add "$TP_TMP/inv.units" "$_nu (older release)"
  else
    tp_file_add "$TP_TMP/inv.units" "$_nu"
  fi
}

tp_scan_systemctl_units() {
  _ssu_out=$TP_TMP/systemctl.list
  systemctl list-units --all --no-legend --plain 'turbopanel*' 'turbopaneld*' > "$_ssu_out" 2>/dev/null || \
    systemctl list-units --all --no-legend 'turbopanel*' 'turbopaneld*' > "$_ssu_out" 2>/dev/null || true
  systemctl list-unit-files --no-legend 'turbopanel*' 'turbopaneld*' >> "$_ssu_out" 2>/dev/null || true
  systemctl list-units --all --no-legend --plain 'turbopanel*.slice' 'turbopaneld*.slice' >> "$_ssu_out" 2>/dev/null || \
    systemctl list-units --all --no-legend '*turbopanel*.slice' >> "$_ssu_out" 2>/dev/null || true
  while IFS= read -r _ssu_line; do
    [ -n "$_ssu_line" ] || continue
    _ssu_name=$(printf '%s\n' "$_ssu_line" | awk '{
      for (i = 1; i <= NF; i++) {
        if ($i ~ /turbopanel/ || $i ~ /^wg-quick@tp0/) { print $i; exit }
      }
    }')
    [ -n "$_ssu_name" ] || continue
    tp_note_unit "$_ssu_name"
  done < "$_ssu_out"
}

tp_inventory_units() {
  if tp_has_tool systemctl; then
    tp_scan_systemctl_units
  else
    tp_inv_skip "systemctl not installed"
  fi
  _iu_files=$TP_TMP/unit.files
  : > "$_iu_files"
  for _iu_dir in $TP_SYSTEMD_DIRS; do
    [ -d "$_iu_dir" ] || continue
    find "$_iu_dir" -maxdepth 3 \( -name 'turbopanel*' -o -name 'turbopaneld*' \) >> "$_iu_files" 2>/dev/null || true
  done
  while IFS= read -r _iu_path; do
    [ -n "$_iu_path" ] || continue
    [ -e "$_iu_path" ] || continue
    tp_note_unit "$_iu_path"
  done < "$_iu_files"
  # shellcheck disable=SC2086
  for _iu_legacy in $TP_LEGACY_UNITS; do
    if tp_unit_present "$_iu_legacy"; then
      tp_note_unit "$_iu_legacy"
    fi
  done
  if tp_unit_present wg-quick@tp0.service || tp_unit_present wg-quick@tp0; then
    tp_note_unit "wg-quick@tp0.service"
  fi
  for _iu_dir in $TP_SYSTEMD_DIRS; do
    if [ -e "$_iu_dir/wg-quick@tp0.service" ] || [ -L "$_iu_dir/multi-user.target.wants/wg-quick@tp0.service" ]; then
      tp_note_unit "wg-quick@tp0.service"
    fi
  done
}

tp_path_under_dirs() {
  _pud=$1
  [ -n "$_pud" ] || return 1
  [ "$_pud" = - ] && return 1
  for _pud_root in $TP_CONFIG_DIRS $TP_STATE_DIRS; do
    [ -n "$_pud_root" ] || continue
    case $_pud in
      "$_pud_root"|"$_pud_root"/*|*"${_pud_root}/"*) return 0 ;;
    esac
  done
  return 1
}

tp_docker_ready() {
  tp_has_tool docker || return 1
  docker info >/dev/null 2>&1
}

# Live daemon wins. daemon.json is next, then the docker unit command line.
# A value of "unknown" is remembered so a later run still reports that the
# root could not be read after the config is gone.
tp_docker_root_from_info() {
  TP_DOCKER_ROOT_PARSED=
  tp_docker_ready || return 0
  _drfi=$(docker info --format '{{.DockerRootDir}}' 2>>"$TP_LOG_FILE" || true)
  _drfi=$(printf '%s' "$_drfi" | tr -d '\r')
  case $_drfi in
    ""|"<no value>") return 0 ;;
    /*) TP_DOCKER_ROOT_PARSED=$_drfi ;;
  esac
}

tp_docker_root_from_daemon_json() {
  TP_DOCKER_ROOT_PARSED=
  TP_DOCKER_ROOT_JSON_BAD=false
  TP_DOCKER_ROOT_JSON_SEEN=false
  _drj=/etc/docker/daemon.json
  [ -f "$_drj" ] || return 0
  TP_DOCKER_ROOT_JSON_SEEN=true
  _drj_line=$(grep -E '"data-root"[[:space:]]*:' "$_drj" 2>/dev/null | head -n 1 || true)
  [ -n "$_drj_line" ] || return 0
  _drj_val=$(printf '%s\n' "$_drj_line" | sed -n 's/.*"data-root"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
  _drj_val=$(printf '%s' "$_drj_val" | sed 's|\\/|/|g')
  case $_drj_val in
    /*) TP_DOCKER_ROOT_PARSED=$_drj_val ;;
    *) TP_DOCKER_ROOT_JSON_BAD=true ;;
  esac
}

tp_docker_root_from_execstart() {
  TP_DOCKER_ROOT_PARSED=
  TP_DOCKER_ROOT_EXEC_BAD=false
  tp_has_tool systemctl || return 0
  _dre=$(systemctl show -p ExecStart --value docker.service 2>/dev/null || true)
  case $_dre in
    *--data-root*) ;;
    *) return 0 ;;
  esac
  case $_dre in
    *--data-root=*) _dre_val=${_dre#*--data-root=} ;;
    *--data-root\ *) _dre_val=${_dre#*--data-root } ;;
    *) 
      TP_DOCKER_ROOT_EXEC_BAD=true
      return 0
      ;;
  esac
  _dre_val=${_dre_val%%[[:space:]]*}
  _dre_val=${_dre_val%%;*}
  _dre_val=${_dre_val%%\}*}
  case $_dre_val in
    /*) TP_DOCKER_ROOT_PARSED=$_dre_val ;;
    *) TP_DOCKER_ROOT_EXEC_BAD=true ;;
  esac
}

tp_accept_docker_data_root() {
  _addr=$(tp_normalize_path "$1")
  if [ "$_addr" = "$TP_DOCKER_DATA_ROOT_DEFAULT" ]; then
    TP_DOCKER_DATA_ROOT=
    TP_DOCKER_DATA_ROOT_STATUS=default
    return 0
  fi
  TP_DOCKER_DATA_ROOT=$_addr
  TP_DOCKER_DATA_ROOT_STATUS=custom
}

tp_resolve_docker_data_root() {
  [ "$TP_DOCKER_DATA_ROOT_LOCKED" = true ] && return 0
  TP_DOCKER_ROOT_JSON_BAD=false
  TP_DOCKER_ROOT_JSON_SEEN=false
  TP_DOCKER_ROOT_EXEC_BAD=false
  _rddr=
  _rddr_state=missing
  tp_docker_root_from_info
  if [ -n "$TP_DOCKER_ROOT_PARSED" ]; then
    _rddr=$TP_DOCKER_ROOT_PARSED
    _rddr_state=found
  fi
  if [ "$_rddr_state" = missing ]; then
    tp_docker_root_from_daemon_json
    if [ -n "$TP_DOCKER_ROOT_PARSED" ]; then
      _rddr=$TP_DOCKER_ROOT_PARSED
      _rddr_state=found
    elif [ "$TP_DOCKER_ROOT_JSON_BAD" = true ]; then
      _rddr_state=unknown
    elif [ "$TP_DOCKER_ROOT_JSON_SEEN" = true ]; then
      _rddr_state=default
    fi
  fi
  if [ "$_rddr_state" != found ]; then
    tp_docker_root_from_execstart
    if [ -n "$TP_DOCKER_ROOT_PARSED" ]; then
      _rddr=$TP_DOCKER_ROOT_PARSED
      _rddr_state=found
    elif [ "$TP_DOCKER_ROOT_EXEC_BAD" = true ]; then
      _rddr_state=unknown
    fi
  fi
  if [ "$_rddr_state" = found ]; then
    tp_accept_docker_data_root "$_rddr"
  elif [ "$_rddr_state" = missing ] && [ -n "$TP_DOCKER_DATA_ROOT_SAVED" ]; then
    tp_accept_docker_data_root "$TP_DOCKER_DATA_ROOT_SAVED"
  elif [ "$_rddr_state" = unknown ] && [ -n "$TP_DOCKER_DATA_ROOT_SAVED" ]; then
    tp_accept_docker_data_root "$TP_DOCKER_DATA_ROOT_SAVED"
  elif [ "$_rddr_state" = unknown ] || { [ "$_rddr_state" = missing ] && [ "$TP_DOCKER_DATA_ROOT_SAVED_UNKNOWN" = true ]; }; then
    TP_DOCKER_DATA_ROOT=
    TP_DOCKER_DATA_ROOT_STATUS=unknown
  else
    TP_DOCKER_DATA_ROOT=
    TP_DOCKER_DATA_ROOT_STATUS=default
  fi
  TP_DOCKER_DATA_ROOT_LOCKED=true
}

tp_print_docker_data_root_line() {
  case $TP_DOCKER_DATA_ROOT_STATUS in
    custom)
      tp_say "Docker data root: ${TP_DOCKER_DATA_ROOT}"
      ;;
    unknown)
      tp_print_warn "Docker data root could not be determined"
      ;;
  esac
}

tp_docker_consider_row() {
  _dcr_name=$1
  _dcr_role=$2
  _dcr_component=$3
  _dcr_service=$4
  _dcr_work=$5
  _dcr_config=$6
  _dcr_project=$7
  [ -n "$_dcr_name" ] || return 0
  _dcr_match=false
  if [ "$_dcr_role" != - ] || [ "$_dcr_component" != - ] || [ "$_dcr_service" != - ]; then
    _dcr_match=true
  fi
  case $_dcr_name in
    turbopanel*|tpn_*) _dcr_match=true ;;
  esac
  # shellcheck disable=SC2086
  if tp_list_has_word "$_dcr_name" $TP_LEGACY_CONTAINER_NAMES; then
    _dcr_match=true
  fi
  case $_dcr_project in
    turbopanel*) _dcr_match=true ;;
  esac
  if tp_path_under_dirs "$_dcr_work" || tp_path_under_dirs "$_dcr_config"; then
    _dcr_match=true
  fi
  if [ "$_dcr_match" = true ]; then
    tp_file_add "$TP_TMP/work.containers" "$_dcr_name"
  fi
  case $_dcr_name in
    turbopanel-system*) tp_file_add "$TP_TMP/work.cpmarkers" "$_dcr_name" ;;
  esac
  case $_dcr_project in
    turbopanel-system) tp_file_add "$TP_TMP/work.cpmarkers" "project turbopanel-system" ;;
  esac
}

tp_docker_collect() {
  : > "$TP_TMP/work.containers"
  : > "$TP_TMP/work.networks"
  : > "$TP_TMP/work.volumes"
  : > "$TP_TMP/work.cpmarkers"
  _dc_rows=$TP_TMP/docker.rows
  _dc_fmt='{{.Names}}|{{.Label "turbopanel.role"}}|{{.Label "com.turbopanel.system.component"}}|{{.Label "com.turbopanel.service"}}|{{.Label "com.docker.compose.project.working_dir"}}|{{.Label "com.docker.compose.project.config_files"}}|{{.Label "com.docker.compose.project"}}'
  if docker ps -a --format "$_dc_fmt" > "$_dc_rows" 2>>"$TP_LOG_FILE"; then
    awk -F '|' '{
      name = $1
      role = ($2 == "" ? "-" : $2)
      component = ($3 == "" ? "-" : $3)
      service = ($4 == "" ? "-" : $4)
      work = ($5 == "" ? "-" : $5)
      config = ($6 == "" ? "-" : $6)
      project = ($7 == "" ? "-" : $7)
      printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\n", name, role, component, service, work, config, project
    }' "$_dc_rows" > "$TP_TMP/docker.tsv"
    while IFS= read -r _dc_line; do
      [ -n "$_dc_line" ] || continue
      _dc_saved=$IFS
      IFS='	'
      set -f
      # shellcheck disable=SC2086
      set -- $_dc_line
      set +f
      IFS=$_dc_saved
      [ "$#" -ge 7 ] || continue
      tp_docker_consider_row "$1" "$2" "$3" "$4" "$5" "$6" "$7"
    done < "$TP_TMP/docker.tsv"
  else
    tp_print_warn "docker ps label format failed; matching container names only"
    docker ps -a --format '{{.Names}}' > "$TP_TMP/docker.names" 2>>"$TP_LOG_FILE" || true
    while IFS= read -r _dc_name; do
      [ -n "$_dc_name" ] || continue
      tp_docker_consider_row "$_dc_name" - - - - - -
    done < "$TP_TMP/docker.names"
  fi

  docker network ls --format '{{.Name}}' > "$TP_TMP/docker.nets" 2>>"$TP_LOG_FILE" || true
  while IFS= read -r _dc_net; do
    [ -n "$_dc_net" ] || continue
    case $_dc_net in
      bridge|host|none) continue ;;
    esac
    _dc_project=$(docker network inspect -f '{{if index .Labels "com.docker.compose.project"}}{{index .Labels "com.docker.compose.project"}}{{else}}-{{end}}' "$_dc_net" 2>>"$TP_LOG_FILE" || printf '%s' -)
    _dc_take=false
    case $_dc_net in
      turbopanel*|tpn_*) _dc_take=true ;;
    esac
    case $_dc_project in
      turbopanel*) _dc_take=true ;;
    esac
    if [ "$_dc_take" = true ]; then
      tp_file_add "$TP_TMP/work.networks" "$_dc_net"
    fi
    case $_dc_project in
      turbopanel-system) tp_file_add "$TP_TMP/work.cpmarkers" "network-project turbopanel-system" ;;
    esac
  done < "$TP_TMP/docker.nets"

  docker volume ls --format '{{.Name}}' > "$TP_TMP/docker.vols" 2>>"$TP_LOG_FILE" || true
  while IFS= read -r _dc_vol; do
    [ -n "$_dc_vol" ] || continue
    case $_dc_vol in
      turbopanel*|tpn_*)
        tp_file_add "$TP_TMP/work.volumes" "$_dc_vol"
        ;;
    esac
    case $_dc_vol in
      *turbopanel-system*) tp_file_add "$TP_TMP/work.cpmarkers" "volume $_dc_vol" ;;
    esac
  done < "$TP_TMP/docker.vols"
}

tp_copy_legacy_names() {
  _cln_src=$1
  _cln_dest=$2
  _cln_kind=$3
  [ -s "$_cln_src" ] || return 0
  while IFS= read -r _cln_name; do
    [ -n "$_cln_name" ] || continue
    _cln_legacy=false
    if [ "$_cln_kind" = container ]; then
      # shellcheck disable=SC2086
      if tp_list_has_word "$_cln_name" $TP_LEGACY_CONTAINER_NAMES; then
        _cln_legacy=true
      fi
    fi
    if [ "$_cln_legacy" = true ]; then
      tp_file_add "$_cln_dest" "$_cln_name (older release)"
    else
      tp_file_add "$_cln_dest" "$_cln_name"
    fi
  done < "$_cln_src"
}

tp_inventory_docker() {
  if ! tp_has_tool docker; then
    tp_inv_skip "docker not installed"
    return 0
  fi
  if ! tp_docker_ready; then
    tp_inv_warn "Docker is installed but the daemon is not responding; containers could not be listed yet"
    tp_inv_keep_previous containers
    tp_inv_keep_previous networks
    tp_inv_keep_previous volumes
    tp_inv_keep_previous cpmarkers
    return 0
  fi
  if ! tp_docker_collect; then
    tp_inv_warn "Docker inventory failed"
    tp_inv_keep_previous containers
    tp_inv_keep_previous networks
    tp_inv_keep_previous volumes
    tp_inv_keep_previous cpmarkers
    return 0
  fi
  tp_copy_legacy_names "$TP_TMP/work.containers" "$TP_TMP/inv.containers" container
  tp_copy_legacy_names "$TP_TMP/work.networks" "$TP_TMP/inv.networks" network
  tp_copy_legacy_names "$TP_TMP/work.volumes" "$TP_TMP/inv.volumes" volume
  if [ -s "$TP_TMP/work.cpmarkers" ]; then
    while IFS= read -r _id_mark; do
      tp_file_add "$TP_TMP/inv.cpmarkers" "$_id_mark"
    done < "$TP_TMP/work.cpmarkers"
  fi
}

tp_inventory_firewall() {
  for _if_bin in iptables ip6tables; do
    if ! tp_has_tool "$_if_bin"; then
      tp_inv_skip "$_if_bin not installed"
      continue
    fi
    if ! "$_if_bin" -w 5 -S > "$TP_TMP/fw.${_if_bin}" 2>>"$TP_LOG_FILE"; then
      tp_inv_warn "could not list $_if_bin chains"
      if [ "${TP_INV_QUIET:-false}" = true ] && [ -f "$TP_TMP/before.chains" ]; then
        grep "^${_if_bin} " "$TP_TMP/before.chains" >> "$TP_TMP/inv.chains" || true
      fi
      continue
    fi
    sed -n 's/^-N \(TP-[^ ]*\).*/\1/p' "$TP_TMP/fw.${_if_bin}" > "$TP_TMP/fw.chains"
    while IFS= read -r _if_chain; do
      [ -n "$_if_chain" ] || continue
      tp_file_add "$TP_TMP/inv.chains" "$_if_bin $_if_chain"
    done < "$TP_TMP/fw.chains"
  done
}

tp_inventory_wireguard() {
  if tp_has_tool ip; then
    if ip link show tp0 >/dev/null 2>&1; then
      tp_file_add "$TP_TMP/inv.wireguard" "interface tp0"
    fi
  else
    tp_inv_skip "ip not installed"
  fi
  if [ -f /etc/wireguard/tp0.conf ]; then
    tp_file_add "$TP_TMP/inv.wireguard" "/etc/wireguard/tp0.conf"
  fi
}

tp_inventory_host_files() {
  for _ih_pattern in /etc/sysctl.d/99-turbopanel-*.conf /etc/udev/rules.d/99-turbopanel-*.rules /etc/sudoers.d/turbopanel-*; do
    for _ih_file in $_ih_pattern; do
      [ -e "$_ih_file" ] || continue
      tp_file_add "$TP_TMP/inv.hostfiles" "$_ih_file"
    done
  done
  for _ih_file in \
    /etc/tmpfiles.d/turbopanel.conf \
    /etc/sudoers.d/tp \
    /etc/ssh/sshd_config.d/60-turbopanel.conf \
    /usr/local/bin/php
  do
    if [ -e "$_ih_file" ]; then
      tp_file_add "$TP_TMP/inv.hostfiles" "$_ih_file"
    fi
  done
}

tp_id_in_band() {
  _iib=$1
  case $_iib in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$_iib" -ge 9900 ] && [ "$_iib" -le 9999 ]
}

tp_name_is_tp() {
  case $1 in
    tp*|turbopanel*) return 0 ;;
    *) return 1 ;;
  esac
}

tp_home_is_principal() {
  _hip=$1
  for _hip_root in $TP_PRINCIPAL_HOME_ROOTS; do
    [ -n "$_hip_root" ] || continue
    case $_hip in
      "$_hip_root"|"$_hip_root"/*) return 0 ;;
    esac
  done
  return 1
}

tp_home_in_install_tree() {
  _hit=$1
  [ -n "$_hit" ] || return 1
  if tp_home_is_principal "$_hit"; then
    return 1
  fi
  case $_hit in
    /opt/turbopanel|/opt/turbopanel/*) return 0 ;;
    /tmp/turbopanel-ansible|/tmp/turbopanel-ansible/*) return 0 ;;
    /tmp/turbopanel-orchestrate|/tmp/turbopanel-orchestrate/*) return 0 ;;
  esac
  for _hit_root in $TP_CONFIG_DIRS $TP_STATE_DIRS $TP_LOG_DIRS $TP_RUN_DIRS $TP_RUNTIMES_DIRS; do
    [ -n "$_hit_root" ] || continue
    case $_hit in
      "$_hit_root"|"$_hit_root"/*) return 0 ;;
    esac
  done
  return 1
}

tp_inventory_accounts() {
  if ! tp_has_tool getent; then
    tp_inv_skip "getent not installed"
    tp_inv_keep_previous accounts
    tp_inv_keep_previous groups
    tp_inv_keep_previous leftalone
    return 0
  fi
  getent passwd > "$TP_TMP/passwd" 2>/dev/null || true
  while IFS=: read -r _ia_name _ia_pw _ia_uid _ia_gid _ia_gecos _ia_home _ia_shell; do
    [ -n "$_ia_name" ] || continue
    _ia_legacy=false
    # shellcheck disable=SC2086
    if tp_list_has_word "$_ia_name" $TP_LEGACY_ACCOUNTS; then
      _ia_legacy=true
    fi
    _ia_label=$_ia_name
    if [ "$_ia_legacy" = true ]; then
      _ia_label="$_ia_name (older release)"
    fi
    if tp_home_is_principal "$_ia_home"; then
      # The home directory may already be gone. The account is still a
      # principal, and the preflight inventory has to see it.
      tp_file_add "$TP_TMP/inv.principals" "$(tp_normalize_path "$_ia_home")"
      continue
    fi
    if tp_name_is_tp "$_ia_name" && tp_id_in_band "$_ia_uid"; then
      tp_file_add "$TP_TMP/inv.accounts" "$_ia_label uid ${_ia_uid} home ${_ia_home}"
    elif tp_home_in_install_tree "$_ia_home"; then
      tp_file_add "$TP_TMP/inv.accounts" "$_ia_label uid ${_ia_uid} home ${_ia_home}"
    elif tp_name_is_tp "$_ia_name"; then
      tp_file_add "$TP_TMP/inv.leftalone" "account $_ia_label uid ${_ia_uid} (left alone, check by hand)"
    fi
  done < "$TP_TMP/passwd"

  getent group > "$TP_TMP/groups" 2>/dev/null || true
  while IFS=: read -r _ia_gname _ia_gpw _ia_ggid _ia_members; do
    [ -n "$_ia_gname" ] || continue
    _ia_glabel=$_ia_gname
    # shellcheck disable=SC2086
    if tp_list_has_word "$_ia_gname" $TP_LEGACY_ACCOUNTS; then
      _ia_glabel="$_ia_gname (older release)"
    fi
    if tp_name_is_tp "$_ia_gname" && tp_id_in_band "$_ia_ggid"; then
      tp_file_add "$TP_TMP/inv.groups" "$_ia_glabel gid ${_ia_ggid}"
    elif tp_name_is_tp "$_ia_gname"; then
      tp_file_add "$TP_TMP/inv.leftalone" "group $_ia_glabel gid ${_ia_ggid} (left alone, check by hand)"
    fi
  done < "$TP_TMP/groups"
}

tp_add_existing() {
  _ae_file=$1
  _ae_path=$2
  _ae_note=$3
  [ -e "$_ae_path" ] || return 0
  if [ -n "$_ae_note" ]; then
    tp_file_add "$_ae_file" "$_ae_path ${_ae_note}"
  else
    tp_file_add "$_ae_file" "$_ae_path"
  fi
}

tp_inventory_signal() {
  for _is_name in units containers networks chains wireguard hostfiles accounts groups principals volumes cpmarkers folders_remove folders_keep; do
    if [ -s "$TP_TMP/inv.${_is_name}" ]; then
      return 0
    fi
  done
  [ -f "$TP_DAEMON_ENV" ] && return 0
  return 1
}

tp_inventory_folders() {
  tp_add_existing "$TP_TMP/inv.folders_remove" /opt/turbopanel ""
  for _ifo_rel in $TP_LEGACY_OPT_PATHS; do
    tp_add_existing "$TP_TMP/inv.folders_remove" "/opt/turbopanel/${_ifo_rel}" "(older release)"
  done
  for _ifo_path in $TP_RUNTIMES_DIRS $TP_RUN_DIRS; do
    tp_add_existing "$TP_TMP/inv.folders_remove" "$_ifo_path" ""
  done
  tp_add_existing "$TP_TMP/inv.folders_remove" /tmp/turbopanel-ansible ""
  tp_add_existing "$TP_TMP/inv.folders_remove" /tmp/turbopanel-orchestrate ""
  for _ifo_path in $TP_CONFIG_DIRS $TP_STATE_DIRS $TP_LOG_DIRS; do
    tp_add_existing "$TP_TMP/inv.folders_keep" "$_ifo_path" ""
  done
  for _ifo_path in $TP_OTHER_DIRS; do
    case $_ifo_path in
      *turbopanel*) tp_add_existing "$TP_TMP/inv.folders_keep" "$_ifo_path" "" ;;
    esac
  done
  # Principal homes are evidence on their own. Scan every discovered root,
  # including the default /srv/users, before later gates consult the inventory.
  for _ifo_root in $TP_PRINCIPAL_HOME_ROOTS; do
    [ -d "$_ifo_root" ] || continue
    for _ifo_child in "$_ifo_root"/*; do
      [ -d "$_ifo_child" ] || continue
      _ifo_base=$(basename "$_ifo_child")
      [ "$_ifo_base" = lost+found ] && continue
      tp_file_add "$TP_TMP/inv.principals" "$_ifo_child"
    done
  done
  if tp_inventory_signal || [ "$TP_BACKUP_EXPLICIT" = true ]; then
    for _ifo_path in $TP_BACKUP_DIRS; do
      tp_add_existing "$TP_TMP/inv.folders_keep" "$_ifo_path" ""
    done
  fi
  if tp_inventory_signal || [ "$TP_PRINCIPAL_EXPLICIT" = true ]; then
    for _ifo_root in $TP_PRINCIPAL_HOME_ROOTS; do
      tp_add_existing "$TP_TMP/inv.folders_keep" "$_ifo_root" ""
    done
    tp_add_existing "$TP_TMP/inv.folders_remove" /root/.ansible ""
  fi
}

# Same homes and filenames as the startup-file cleanup. Each matching line is
# one row (file, tab, line text). Removal edits those inventoried files, and
# the final scan compares this same category.
tp_collect_shell_homes() {
  : > "$TP_TMP/homes"
  printf '%s\n' /root >> "$TP_TMP/homes"
  if [ -r /etc/passwd ]; then
    while IFS=: read -r _csh_name _csh_pw _csh_uid _csh_gid _csh_gecos _csh_home _csh_shell; do
      case $_csh_uid in
        ''|*[!0-9]*) continue ;;
      esac
      [ "$_csh_uid" -ge 1000 ] || continue
      [ -n "$_csh_home" ] || continue
      [ "$_csh_home" = /root ] && continue
      printf '%s\n' "$_csh_home" >> "$TP_TMP/homes"
    done < /etc/passwd
  fi
}

tp_shell_rc_matches() {
  _srm=$1
  grep -F -e '/opt/turbopanel/' -e "$TP_LEGACY_SHELL_RC_NEEDLE" "$_srm" >/dev/null 2>&1
}

tp_inventory_shell_rcs() {
  tp_collect_shell_homes
  while IFS= read -r _isr_home; do
    [ -n "$_isr_home" ] || continue
    [ -d "$_isr_home" ] || continue
    for _isr_name in .bashrc .profile .bash_profile .zshrc .zshenv .zprofile; do
      _isr_file="${_isr_home}/${_isr_name}"
      [ -f "$_isr_file" ] || continue
      tp_shell_rc_matches "$_isr_file" || continue
      grep -F -e '/opt/turbopanel/' -e "$TP_LEGACY_SHELL_RC_NEEDLE" "$_isr_file" > "$TP_TMP/shell.hits" || true
      while IFS= read -r _isr_line; do
        [ -n "$_isr_line" ] || continue
        tp_file_add "$TP_TMP/inv.shellrc" "${_isr_file}	${_isr_line}"
      done < "$TP_TMP/shell.hits"
    done
  done < "$TP_TMP/homes"
}

tp_note_purge_target() {
  _npt=$1
  [ -n "$_npt" ] || return 0
  if tp_path_present "$_npt"; then
    tp_file_add "$TP_TMP/inv.purge_targets" "$_npt"
  fi
}

# Paths option 2 deletes, including ones the second scan must compare with
# the pre-removal snapshot. Principal homes are copied even when the
# directory is already gone, because the account is still a purge target.
tp_inventory_purge_targets() {
  : > "$TP_TMP/inv.purge_targets"
  set -f
  # shellcheck disable=SC2086
  for _ipt in $TP_CONFIG_DIRS $TP_STATE_DIRS $TP_LOG_DIRS $TP_RUN_DIRS $TP_BACKUP_DIRS $TP_PRINCIPAL_HOME_ROOTS; do
    tp_note_purge_target "$_ipt"
  done
  set +f
  tp_note_purge_target /etc/ssh/turbopanel
  if [ "$TP_DOCKER_DATA_ROOT_STATUS" = custom ]; then
    tp_note_purge_target "$TP_DOCKER_DATA_ROOT"
  fi
  if [ -s "$TP_TMP/inv.principals" ]; then
    while IFS= read -r _ipt; do
      [ -n "$_ipt" ] || continue
      tp_file_add "$TP_TMP/inv.purge_targets" "$_ipt"
    done < "$TP_TMP/inv.principals"
  fi
  if [ -f "$TP_TMP/before.purge_targets" ]; then
    while IFS= read -r _ipt; do
      [ -n "$_ipt" ] || continue
      if tp_path_present "$_ipt"; then
        tp_file_add "$TP_TMP/inv.purge_targets" "$_ipt"
        continue
      fi
      if [ -f "$TP_TMP/inv.principals" ] && grep -Fxq "$_ipt" "$TP_TMP/inv.principals"; then
        tp_file_add "$TP_TMP/inv.purge_targets" "$_ipt"
      fi
    done < "$TP_TMP/before.purge_targets"
  fi
}

tp_inventory() {
  tp_inv_reset
  tp_inventory_units
  tp_inventory_docker
  tp_inventory_firewall
  tp_inventory_wireguard
  tp_inventory_host_files
  tp_inventory_shell_rcs
  tp_inventory_accounts
  tp_inventory_folders
  tp_resolve_docker_data_root
  tp_inventory_purge_targets
}

# --- detection (labels only) ------------------------------------------------

tp_url_host() {
  _uh=$1
  _uh=${_uh#*://}
  _uh=${_uh%%/*}
  _uh=${_uh%%:*}
  printf '%s' "$_uh"
}

tp_host_is_ha() {
  case $1 in
    turbopanel.app|*.turbopanel.dev) return 0 ;;
    *) return 1 ;;
  esac
}

tp_detect_server_type() {
  TP_INSTANCE_URL=$(tp_env_file_value "$TP_DAEMON_ENV" TURBOPANEL_INSTANCE_URL)
  _dst_env=false
  [ -f "$TP_DAEMON_ENV" ] && _dst_env=true
  _dst_unit=false
  tp_unit_present turbopaneld.service && _dst_unit=true
  _dst_instance=false
  if [ -e /opt/turbopanel/bin/turbopanel ] || tp_unit_present turbopanel-instance.service; then
    _dst_instance=true
  fi
  _dst_cp=false
  if [ "$_dst_instance" = true ] || [ -d /etc/turbopanel/instance ]; then
    _dst_cp=true
  fi
  if [ -s "$TP_TMP/inv.cpmarkers" ]; then
    _dst_cp=true
  fi
  _dst_partial=false
  if [ "$_dst_env" != true ] || [ "$_dst_unit" != true ]; then
    _dst_partial=true
  fi

  if [ -n "$TP_INSTANCE_URL" ]; then
    _dst_host=$(tp_url_host "$TP_INSTANCE_URL")
    if tp_host_is_ha "$_dst_host"; then
      TP_SERVER_KIND=ha-daemon
      TP_SERVER_LABEL="TurboPanel High Availability"
    else
      TP_SERVER_KIND=remote-daemon
      TP_SERVER_LABEL="self-hosted control plane at ${TP_INSTANCE_URL}"
    fi
    return 0
  fi
  if [ "$_dst_partial" = true ]; then
    if [ "$_dst_cp" = true ]; then
      TP_SERVER_KIND=control-plane-leftovers
      TP_SERVER_LABEL="control-plane leftovers"
    else
      TP_SERVER_KIND=leftovers-unknown
      TP_SERVER_LABEL="leftovers, type unknown"
    fi
    return 0
  fi
  if [ "$_dst_instance" = true ]; then
    TP_SERVER_KIND=control-plane
    TP_SERVER_LABEL="self-hosted control plane"
    return 0
  fi
  TP_SERVER_KIND=daemon-unconfigured
  TP_SERVER_LABEL="TurboPanel daemon (control plane URL not set)"
}

tp_print_detection_warnings() {
  case $TP_SERVER_KIND in
    control-plane|control-plane-leftovers)
      tp_print_warn "The database and the secret keyring live under /etc/turbopanel and in Docker volumes."
      tp_print_warn "Purging hosted data is unrecoverable and leaves other enrolled servers without this control plane."
      ;;
    ha-daemon|remote-daemon)
      tp_print_warn "After uninstall, delete this server in the console so the control plane drops the enrolment."
      ;;
  esac
}

tp_print_sizes() {
  tp_say "Data folder sizes:"
  if ! tp_has_tool du; then
    tp_record_skip "du not installed"
    return 0
  fi
  _ps_any=false
  for _ps_path in $TP_CONFIG_DIRS $TP_STATE_DIRS $TP_LOG_DIRS $TP_RUNTIMES_DIRS $TP_RUN_DIRS $TP_BACKUP_DIRS $TP_PRINCIPAL_HOME_ROOTS /opt/turbopanel; do
    [ -e "$_ps_path" ] || continue
    _ps_size=$(du -sh "$_ps_path" 2>/dev/null | awk '{ print $1; exit }')
    [ -n "$_ps_size" ] || _ps_size=?
    tp_say "  ${_ps_size}  ${_ps_path}"
    _ps_any=true
  done
  if [ "$_ps_any" = false ]; then
    tp_say "  (none)"
  fi
}

tp_print_report() {
  _pr_host=$(hostname 2>/dev/null || true)
  if [ -z "$_pr_host" ]; then
    _pr_host=$(uname -n 2>/dev/null || true)
  fi
  [ -n "$_pr_host" ] || _pr_host=unknown
  TP_HOSTNAME=$_pr_host
  tp_say ""
  tp_say "Host: ${_pr_host}"
  tp_say "Install: ${TP_SERVER_LABEL}"
  if [ -n "$TP_INSTANCE_URL" ]; then
    tp_say "Control plane URL: ${TP_INSTANCE_URL}"
  fi
  _pr_principals=0
  if [ -f "$TP_TMP/inv.principals" ]; then
    _pr_principals=$(awk 'END { print NR+0 }' "$TP_TMP/inv.principals")
  fi
  tp_say "Principals: ${_pr_principals} under ${TP_PRINCIPAL_HOME_ROOTS}"
  if tp_has_tool docker; then
    if tp_docker_ready; then
      tp_say "Docker: installed, daemon responding"
    else
      tp_say "Docker: installed, daemon not responding"
    fi
  else
    tp_say "Docker: not installed"
  fi
  tp_print_docker_data_root_line
  tp_say ""
  tp_print_group "Units" "$TP_TMP/inv.units"
  tp_print_group "Containers" "$TP_TMP/inv.containers"
  tp_print_group "Networks" "$TP_TMP/inv.networks"
  tp_print_group "Docker volumes (kept)" "$TP_TMP/inv.volumes"
  tp_print_group "Firewall chains" "$TP_TMP/inv.chains"
  tp_print_group "WireGuard" "$TP_TMP/inv.wireguard"
  tp_print_group "Host files" "$TP_TMP/inv.hostfiles"
  tp_print_group "Shell startup files" "$TP_TMP/inv.shellrc"
  tp_print_group "Folders to remove" "$TP_TMP/inv.folders_remove"
  tp_print_group "Data folders kept by option 1" "$TP_TMP/inv.folders_keep"
  tp_print_group "Accounts to remove" "$TP_TMP/inv.accounts"
  tp_print_group "Groups to remove" "$TP_TMP/inv.groups"
  tp_print_group "Principal homes (kept)" "$TP_TMP/inv.principals"
  tp_print_group "Left alone" "$TP_TMP/inv.leftalone"
  tp_say ""
  tp_print_sizes
  tp_say ""
  tp_print_detection_warnings
}

tp_print_choice_table() {
  tp_say ""
  if [ "$TP_ACTION" = purge ]; then
    tp_say "This option removes:"
    tp_say "  systemd units, Docker containers and networks, TP-* firewall chains,"
    tp_say "  WireGuard tp0, host config drop-ins, /opt/turbopanel, runtime and run"
    tp_say "  folders, ansible scratch dirs, /opt/turbopanel/ lines in shell startup"
    tp_say "  files, service accounts/groups in the 9900-9999 band, principal"
    tp_say "  accounts and homes, Docker Engine, config, state, log, run, and"
    tp_say "  backup folders, and apt packages TurboPanel installed."
    tp_say ""
    if [ "$TP_DOCKER_DATA_ROOT_STATUS" = custom ]; then
      tp_say "Docker data root: ${TP_DOCKER_DATA_ROOT}"
      tp_say ""
    fi
    if [ "$TP_DOCKER_DATA_ROOT_STATUS" = unknown ]; then
      tp_print_warn "Docker data root could not be determined. Custom Docker data may remain."
      tp_say ""
    fi
    tp_print_warn "Purging Docker Engine removes every container, volume, and image on this host, including ones TurboPanel did not create."
    return 0
  fi
  tp_say "This option removes:"
  tp_say "  systemd units, Docker containers and networks, TP-* firewall chains,"
  tp_say "  WireGuard tp0, host config drop-ins, /opt/turbopanel, runtime and run"
  tp_say "  folders, ansible scratch dirs, /opt/turbopanel/ lines in shell startup"
  tp_say "  files, and service accounts/groups in the 9900-9999 band"
  tp_say "This option keeps:"
  tp_say "  config, state, log, and backup folders, principal homes and accounts,"
  tp_say "  Docker volumes, Docker images, Docker Engine, and apt packages"
  tp_say ""
}

tp_menu() {
  tp_say "1) Remove TurboPanel only (keeps hosted data)"
  tp_say "2) Remove TurboPanel and purge all hosted data"
  tp_say "q) Quit"
  while :; do
    if ! _menu_choice=$(tp_read_tty "Choice: "); then
      tp_print_error "Aborted — nothing changed"
      exit 1
    fi
    case $_menu_choice in
      1)
        TP_ACTION=remove
        return 0
        ;;
      2)
        TP_ACTION=purge
        return 0
        ;;
      q|Q)
        tp_print_ok "Quit — nothing changed"
        exit 0
        ;;
      *)
        tp_print_error "Enter 1, 2, or q"
        ;;
    esac
  done
}

tp_confirm() {
  tp_print_choice_table
  tp_print_detection_warnings
  if ! tp_has_tool od || ! tp_has_tool tr; then
    tp_print_error "od and tr are required to confirm. Nothing was changed."
    exit 1
  fi
  TP_CODE=$(od -An -tx1 -N4 /dev/urandom | tr -d ' \n' | tr 'a-f' 'A-F')
  case $TP_CODE in
    [0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F]) ;;
    *)
      tp_print_error "Could not generate a confirmation code. Nothing was changed."
      exit 1
      ;;
  esac
  if [ "$TP_ACTION" = purge ]; then
    _cf_expected="purge ${TP_HOSTNAME} ${TP_CODE}"
    tp_say "To confirm, type the line below exactly — the code alone is not enough:"
    tp_say ""
    tp_say "  ${_cf_expected}"
    tp_say ""
  else
    _cf_expected="remove-${TP_CODE}"
    tp_say "Type ${_cf_expected} to remove TurboPanel."
  fi
  if ! _cf_got=$(tp_read_tty "Confirmation: "); then
    tp_print_error "Aborted — nothing changed"
    exit 1
  fi
  if [ "$_cf_got" != "$_cf_expected" ]; then
    tp_print_error "Aborted — nothing changed"
    exit 1
  fi
}

# --- removal ----------------------------------------------------------------

tp_collect_unit_names() {
  : > "$TP_TMP/work.unitnames"
  if tp_has_tool systemctl; then
    _cun_list=$TP_TMP/unit.names.raw
    : > "$_cun_list"
    systemctl list-units --all --no-legend --plain 'turbopanel*' 'turbopaneld*' >> "$_cun_list" 2>/dev/null || \
      systemctl list-units --all --no-legend 'turbopanel*' 'turbopaneld*' >> "$_cun_list" 2>/dev/null || true
    systemctl list-unit-files --no-legend 'turbopanel*' 'turbopaneld*' >> "$_cun_list" 2>/dev/null || true
    systemctl list-units --all --no-legend --plain 'turbopanel*.slice' 'turbopaneld*.slice' >> "$_cun_list" 2>/dev/null || true
    systemctl list-units --all --no-legend --plain 'wg-quick@tp0.service' >> "$_cun_list" 2>/dev/null || true
    while IFS= read -r _cun_line; do
      _cun_name=$(printf '%s\n' "$_cun_line" | awk '{
        for (i = 1; i <= NF; i++) {
          if ($i ~ /turbopanel/ || $i ~ /^wg-quick@tp0/) { print $i; exit }
        }
      }')
      [ -n "$_cun_name" ] || continue
      tp_file_add "$TP_TMP/work.unitnames" "$_cun_name"
    done < "$_cun_list"
  fi
  # shellcheck disable=SC2086
  for _cun_legacy in $TP_LEGACY_UNITS wg-quick@tp0.service wg-quick@tp0; do
    if tp_unit_present "$_cun_legacy"; then
      case $_cun_legacy in
        wg-quick@tp0) tp_file_add "$TP_TMP/work.unitnames" "wg-quick@tp0.service" ;;
        *) tp_file_add "$TP_TMP/work.unitnames" "$_cun_legacy" ;;
      esac
    fi
  done
  tp_file_add "$TP_TMP/work.unitnames" "turbopaneld.service"
  tp_file_add "$TP_TMP/work.unitnames" "turbopaneld-update-guard.timer"
}

tp_stop_disable_unit() {
  _sdu=$1
  if ! tp_unit_present "$_sdu"; then
    return 0
  fi
  _sdu_active=$(systemctl is-active "$_sdu" 2>/dev/null || true)
  case $_sdu_active in
    inactive|unknown|"") ;;
    *)
      tp_run "stop $_sdu" systemctl stop "$_sdu" || true
      ;;
  esac
  _sdu_enabled=$(systemctl is-enabled "$_sdu" 2>/dev/null || true)
  case $_sdu_enabled in
    enabled|enabled-runtime|alias|indirect)
      tp_run "disable $_sdu" systemctl disable "$_sdu" || true
      ;;
  esac
}

tp_stop_units_matching() {
  _sum_kind=$1
  [ -s "$TP_TMP/work.unitnames" ] || return 0
  while IFS= read -r _sum_name; do
    [ -n "$_sum_name" ] || continue
    case $_sum_kind in
      timer)
        case $_sum_name in
          *.timer)
            case $_sum_name in
              turbopaneld-update-guard.timer) ;;
              *) tp_stop_disable_unit "$_sum_name" ;;
            esac
            ;;
        esac
        ;;
      service)
        case $_sum_name in
          *.service)
            case $_sum_name in
              turbopaneld.service) ;;
              *) tp_stop_disable_unit "$_sum_name" ;;
            esac
            ;;
        esac
        ;;
      other)
        case $_sum_name in
          *.timer|*.service|turbopaneld-update-guard.timer|turbopaneld.service) ;;
          *) tp_stop_disable_unit "$_sum_name" ;;
        esac
        ;;
    esac
  done < "$TP_TMP/work.unitnames"
}

tp_remove_unit_files() {
  _ruf_list=$TP_TMP/unit.paths
  : > "$_ruf_list"
  for _ruf_dir in $TP_SYSTEMD_DIRS; do
    [ -d "$_ruf_dir" ] || continue
    find "$_ruf_dir" -maxdepth 3 \( -name 'turbopanel*' -o -name 'turbopaneld*' \) >> "$_ruf_list" 2>/dev/null || true
  done
  while IFS= read -r _ruf_path; do
    [ -n "$_ruf_path" ] || continue
    [ -e "$_ruf_path" ] || [ -L "$_ruf_path" ] || continue
    case $_ruf_path in
      */wg-quick@.service|*/wg-quick@.service/*) continue ;;
    esac
    if [ -d "$_ruf_path" ] && [ ! -L "$_ruf_path" ]; then
      tp_safe_rm_tree "$_ruf_path"
    else
      tp_run "remove unit file $_ruf_path" rm -f "$_ruf_path" || true
    fi
  done < "$_ruf_list"
}

tp_prune_wants_symlinks() {
  _pws_list=$TP_TMP/wants.links
  : > "$_pws_list"
  for _pws_dir in $TP_SYSTEMD_DIRS; do
    [ -d "$_pws_dir" ] || continue
    find "$_pws_dir" -maxdepth 3 -type l \( -path '*/.wants/*' -o -path '*/.requires/*' \) >> "$_pws_list" 2>/dev/null || true
  done
  while IFS= read -r _pws_link; do
    [ -n "$_pws_link" ] || continue
    _pws_base=$(basename "$_pws_link")
    _pws_target=$(readlink "$_pws_link" 2>/dev/null || true)
    _pws_ours=false
    case $_pws_base in
      turbopanel*|turbopaneld*|wg-quick@tp0*) _pws_ours=true ;;
    esac
    case $_pws_target in
      *turbopanel*|*turbopaneld*) _pws_ours=true ;;
    esac
    [ "$_pws_ours" = true ] || continue
    if [ ! -e "$_pws_link" ]; then
      tp_run "remove dangling symlink $_pws_link" rm -f "$_pws_link" || true
    fi
  done < "$_pws_list"
}

tp_remove_units() {
  tp_print_step "▸" "Units"
  if ! tp_has_tool systemctl; then
    tp_record_skip "systemctl not installed"
    return 0
  fi
  tp_collect_unit_names
  # Timer first so it cannot start the daemon again while that unit is stopping.
  tp_stop_disable_unit turbopaneld-update-guard.timer
  tp_stop_disable_unit turbopaneld.service
  tp_stop_units_matching timer
  tp_stop_units_matching service
  tp_stop_units_matching other
  tp_remove_unit_files
  tp_prune_wants_symlinks
  tp_run "systemctl daemon-reload" systemctl daemon-reload || true
  # Scoped to TurboPanel units. A bare reset-failed would clear every failed
  # unit on the host, including ones this uninstall did not touch. A glob
  # that matches nothing is not a failed uninstall, but wg-quick@tp0.service
  # is a literal name, not a glob: systemctl errors on "not loaded" for a
  # literal it has never seen, which is the common case on a host that never
  # brought up a WireGuard tunnel. Only pass it when it is actually known.
  _ru_units="turbopanel* turbopaneld*"
  if systemctl list-units --all --no-legend --plain 'wg-quick@tp0.service' \
      2>/dev/null | grep -q .; then
    _ru_units="$_ru_units wg-quick@tp0.service"
  fi
  # Dry-run must skip this: it clears live unit state.
  # shellcheck disable=SC2086
  tp_run "clear failed TurboPanel unit state" \
    systemctl reset-failed $_ru_units || true
}

tp_remove_docker() {
  tp_print_step "▸" "Docker containers and networks"
  if ! tp_has_tool docker; then
    tp_record_skip "docker not installed"
    return 0
  fi
  if ! tp_docker_ready; then
    if tp_has_tool systemctl; then
      tp_run "start docker" systemctl start docker.service || true
    fi
    if ! tp_docker_ready; then
      tp_record_skip "docker daemon not responding; containers remain"
      tp_print_warn "Docker containers remain because the daemon did not respond"
      return 0
    fi
  fi
  tp_docker_collect || {
    tp_record_fail "list docker containers"
    return 0
  }
  if [ -s "$TP_TMP/work.containers" ]; then
    while IFS= read -r _rd_name; do
      [ -n "$_rd_name" ] || continue
      tp_run "docker rm -f $_rd_name" docker rm -f "$_rd_name" || true
    done < "$TP_TMP/work.containers"
  else
    tp_print_ok "no TurboPanel containers"
  fi
  if [ -s "$TP_TMP/work.networks" ]; then
    while IFS= read -r _rd_net; do
      [ -n "$_rd_net" ] || continue
      tp_run "docker network rm $_rd_net" docker network rm "$_rd_net" || true
    done < "$TP_TMP/work.networks"
  else
    tp_print_ok "no TurboPanel networks"
  fi
}

tp_firewall_delete_jumps() {
  _fdj_bin=$1
  _fdj_chain=$2
  _fdj_list=$TP_TMP/fw.lines
  "$_fdj_bin" -w 5 -L "$_fdj_chain" -n --line-numbers > "$_fdj_list" 2>>"$TP_LOG_FILE" || return 0
  _fdj_nums=$(awk 'NR > 2 && $1 ~ /^[0-9]+$/ && $2 ~ /^TP-/ { print $1 }' "$_fdj_list" | sort -nr)
  for _fdj_num in $_fdj_nums; do
    tp_run "delete $_fdj_bin $_fdj_chain rule $_fdj_num" "$_fdj_bin" -w 5 -D "$_fdj_chain" "$_fdj_num" || true
  done
}

tp_firewall_family() {
  _ff_bin=$1
  if ! tp_has_tool "$_ff_bin"; then
    tp_record_skip "$_ff_bin not installed"
    return 0
  fi
  "$_ff_bin" -w 5 -S > "$TP_TMP/fw.save" 2>>"$TP_LOG_FILE" || {
    tp_record_fail "list $_ff_bin rules"
    return 0
  }
  _ff_chains=$(sed -n 's/^-N \(TP-[^ ]*\).*/\1/p' "$TP_TMP/fw.save")
  if [ -z "$_ff_chains" ]; then
    tp_print_ok "no $_ff_bin TP-* chains"
    return 0
  fi
  for _ff_chain in INPUT FORWARD DOCKER-USER; do
    tp_firewall_delete_jumps "$_ff_bin" "$_ff_chain"
  done
  # Flush every TP-* chain before deleting any of them. A chain that jumps to
  # another TP-* chain is still referenced if the callee is deleted first, and
  # iptables -X then fails permanently.
  for _ff_chain in $_ff_chains; do
    tp_run "flush $_ff_bin $_ff_chain" "$_ff_bin" -w 5 -F "$_ff_chain" || true
  done
  _ff_pending=
  for _ff_chain in $_ff_chains; do
    if tp_firewall_try_delete "$_ff_bin" "$_ff_chain"; then
      continue
    fi
    _ff_pending=$(tp_ws_add "$_ff_pending" "$_ff_chain")
  done
  [ -n "$_ff_pending" ] || return 0
  # A sibling that is still here can hold a jump. Flush the chains that
  # survived the first delete, then delete them again. Already-removed chains
  # are not flushed again. Only this retry is recorded.
  for _ff_chain in $_ff_pending; do
    tp_run "flush $_ff_bin $_ff_chain" "$_ff_bin" -w 5 -F "$_ff_chain" || true
  done
  for _ff_chain in $_ff_pending; do
    tp_run "delete $_ff_bin $_ff_chain" "$_ff_bin" -w 5 -X "$_ff_chain" || true
  done
}

# First delete attempt. Success is logged like tp_run. Failure is not recorded
# yet: the caller flushes again and retries through tp_run.
tp_firewall_try_delete() {
  _ftd_bin=$1
  _ftd_chain=$2
  if [ "$DRY_RUN" = true ]; then
    tp_run "delete $_ftd_bin $_ftd_chain" "$_ftd_bin" -w 5 -X "$_ftd_chain" || true
    return 0
  fi
  tp_print_step "▸" "delete $_ftd_bin $_ftd_chain"
  tp_log_line "run: $_ftd_bin -w 5 -X $_ftd_chain"
  if "$_ftd_bin" -w 5 -X "$_ftd_chain" >>"$TP_LOG_FILE" 2>&1; then
    tp_log_line "ok: delete $_ftd_bin $_ftd_chain"
    printf '%s\n' "delete $_ftd_bin $_ftd_chain" >> "$TP_TMP/removed"
    return 0
  fi
  tp_log_line "retry: delete $_ftd_bin $_ftd_chain after cross-chain jumps are flushed"
  return 1
}

tp_remove_firewall() {
  tp_print_step "▸" "Firewall chains"
  tp_firewall_family iptables
  tp_firewall_family ip6tables
}

tp_remove_wireguard() {
  tp_print_step "▸" "WireGuard"
  if tp_has_tool ip; then
    if ip link show tp0 >/dev/null 2>&1; then
      tp_run "delete WireGuard interface tp0" ip link del tp0 || true
    fi
  else
    tp_record_skip "ip not installed"
  fi
  if [ -f /etc/wireguard/tp0.conf ]; then
    tp_run "remove /etc/wireguard/tp0.conf" rm -f /etc/wireguard/tp0.conf || true
  fi
  if [ -d /etc/wireguard ]; then
    _rw_rest=$(find /etc/wireguard -mindepth 1 -print -quit 2>/dev/null || true)
    if [ -z "$_rw_rest" ]; then
      tp_run "remove empty /etc/wireguard" rmdir /etc/wireguard || true
    fi
  fi
}

tp_remove_glob() {
  _rg_pattern=$1
  _rg_found=false
  for _rg_file in $_rg_pattern; do
    [ -e "$_rg_file" ] || continue
    _rg_found=true
    tp_run "remove $_rg_file" rm -f "$_rg_file" || true
  done
  [ "$_rg_found" = true ]
}

tp_sshd_bin() {
  if tp_has_tool sshd; then
    command -v sshd
    return 0
  fi
  if [ -x /usr/sbin/sshd ]; then
    printf '%s\n' /usr/sbin/sshd
    return 0
  fi
  return 1
}

tp_remove_sshd_dropin() {
  _rsd=/etc/ssh/sshd_config.d/60-turbopanel.conf
  [ -f "$_rsd" ] || return 0
  _rsd_bin=$(tp_sshd_bin || true)
  _rsd_bak=$TP_TMP/sshd-dropin.bak
  tp_run "backup $_rsd" cp -a "$_rsd" "$_rsd_bak" || return 0
  tp_run "remove $_rsd" rm -f "$_rsd" || true
  if [ "$DRY_RUN" = true ]; then
    if [ -n "$_rsd_bin" ]; then
      tp_run "test sshd config" "$_rsd_bin" -t || true
    fi
    return 0
  fi
  if [ -z "$_rsd_bin" ]; then
    tp_record_skip "sshd not installed; drop-in removed without a config test"
    return 0
  fi
  if "$_rsd_bin" -t >> "$TP_LOG_FILE" 2>&1; then
    if tp_has_tool systemctl; then
      if systemctl is-active --quiet ssh 2>/dev/null; then
        tp_run "reload ssh" systemctl reload ssh || true
      elif systemctl is-active --quiet sshd 2>/dev/null; then
        tp_run "reload sshd" systemctl reload sshd || true
      else
        tp_print_ok "ssh is not active; drop-in removed"
      fi
    else
      tp_record_skip "systemctl not installed; ssh not reloaded"
    fi
  else
    if tp_run "restore $_rsd" cp -a "$_rsd_bak" "$_rsd"; then
      tp_print_warn "sshd -t failed; restored $_rsd so sshd can still start"
    else
      tp_print_error "sshd -t failed and restoring $_rsd failed"
    fi
    tp_record_fail "sshd config test failed; drop-in restored"
  fi
}

# Same rule as tp_account_delete_names for groups. TP_LEGACY_ACCOUNTS
# (turbopanel, turbopaneli, turbopanelc) match tp_name_is_tp, and the gid
# must sit in 9900-9999. Name alone must not match: an operator group such
# as tpbackup is left alone, including its dpkg statoverrides.
tp_group_is_turbopanel() {
  _git=$1
  [ -n "$_git" ] || return 1
  tp_has_tool getent || return 1
  _git_line=$(getent group "$_git" 2>/dev/null | head -n 1 || true)
  [ -n "$_git_line" ] || return 1
  _git_name=${_git_line%%:*}
  _git_gid=$(printf '%s\n' "$_git_line" | awk -F: '{ print $3; exit }')
  tp_name_is_tp "$_git_name" && tp_id_in_band "$_git_gid"
}

tp_remove_statoverrides() {
  if ! tp_has_tool dpkg-statoverride; then
    tp_record_skip "dpkg-statoverride not installed"
    return 0
  fi
  dpkg-statoverride --list > "$TP_TMP/statoverride" 2>>"$TP_LOG_FILE" || true
  [ -s "$TP_TMP/statoverride" ] || return 0
  awk '{
    path = $4
    for (i = 5; i <= NF; i++) path = path " " $i
    printf "%s\t%s\n", $2, path
  }' "$TP_TMP/statoverride" > "$TP_TMP/statoverride.tsv"
  while IFS= read -r _rso_line; do
    [ -n "$_rso_line" ] || continue
    _rso_group=${_rso_line%%	*}
    _rso_path=${_rso_line#*	}
    [ -n "$_rso_group" ] || continue
    [ -n "$_rso_path" ] || continue
    if tp_group_is_turbopanel "$_rso_group"; then
      tp_run "dpkg-statoverride --remove $_rso_path" dpkg-statoverride --remove "$_rso_path" || true
    fi
  done < "$TP_TMP/statoverride.tsv"
}

tp_remove_host_config() {
  tp_print_step "▸" "Host config files"
  if tp_remove_glob '/etc/sysctl.d/99-turbopanel-*.conf'; then
    if tp_has_tool sysctl; then
      tp_run "sysctl --system" sysctl --system || true
    else
      tp_record_skip "sysctl not installed"
    fi
  fi
  if tp_remove_glob '/etc/udev/rules.d/99-turbopanel-*.rules'; then
    if tp_has_tool udevadm; then
      tp_run "udevadm control --reload-rules" udevadm control --reload-rules || true
      tp_run "udevadm trigger" udevadm trigger || true
    else
      tp_record_skip "udevadm not installed"
    fi
  fi
  for _rhc in /etc/tmpfiles.d/turbopanel.conf /etc/sudoers.d/tp; do
    if [ -e "$_rhc" ]; then
      tp_run "remove $_rhc" rm -f "$_rhc" || true
    fi
  done
  tp_remove_glob '/etc/sudoers.d/turbopanel-*' || true
  tp_remove_sshd_dropin
  if [ -e /usr/local/bin/php ]; then
    tp_run "remove /usr/local/bin/php" rm -f /usr/local/bin/php || true
  fi
  tp_remove_statoverrides
}

# cat's redirect keeps the destination inode. tp_run applies its own stdout
# redirect to the function, which this inner redirect replaces.
tp_write_stripped_rc() {
  cat "$1" > "$2"
}

tp_strip_one_rc() {
  _sor=$1
  [ -f "$_sor" ] || return 0
  if [ -L "$_sor" ]; then
    tp_print_warn "$_sor is a symlink; left it unchanged"
    return 0
  fi
  if ! tp_shell_rc_matches "$_sor"; then
    return 0
  fi
  _sor_bak="${_sor}.turbopanel-uninstall.bak"
  tp_run "backup $_sor" cp -a "$_sor" "$_sor_bak" || return 0
  if [ "$DRY_RUN" = true ]; then
    tp_run "strip TurboPanel lines from $_sor" tp_write_stripped_rc "$TP_TMP/rc.strip" "$_sor" || true
    return 0
  fi
  # grep -v exits 1 when every line matched, which still leaves a correct file.
  grep -v -F -e '/opt/turbopanel/' -e "$TP_LEGACY_SHELL_RC_NEEDLE" "$_sor" > "$TP_TMP/rc.strip" || true
  if tp_run "strip TurboPanel lines from $_sor" tp_write_stripped_rc "$TP_TMP/rc.strip" "$_sor"; then
    tp_print_ok "stripped $_sor (backup $_sor_bak)"
  else
    tp_run "restore $_sor" cp -a "$_sor_bak" "$_sor" || true
  fi
}

tp_strip_shell_rcs() {
  : > "$TP_TMP/shellrc.files"
  if [ -f "$TP_TMP/inv.shellrc" ]; then
    while IFS= read -r _ssr_row; do
      [ -n "$_ssr_row" ] || continue
      _ssr_file=${_ssr_row%%	*}
      tp_file_add "$TP_TMP/shellrc.files" "$_ssr_file"
    done < "$TP_TMP/inv.shellrc"
  fi
  [ -s "$TP_TMP/shellrc.files" ] || return 0
  while IFS= read -r _ssr_file; do
    [ -n "$_ssr_file" ] || continue
    tp_strip_one_rc "$_ssr_file"
  done < "$TP_TMP/shellrc.files"
}

tp_remove_folders_and_shell() {
  tp_print_step "▸" "Folders and shell startup lines"
  tp_safe_rm_tree /opt/turbopanel
  for _rfs in $TP_RUNTIMES_DIRS $TP_RUN_DIRS; do
    tp_safe_rm_tree "$_rfs"
  done
  tp_safe_rm_tree /tmp/turbopanel-ansible
  tp_safe_rm_tree /tmp/turbopanel-orchestrate
  tp_safe_rm_tree /root/.ansible
  tp_strip_shell_rcs
}

# A signal whose target has already exited is success. A signal that leaves
# the process running is a real failure and is recorded by tp_run.
tp_signal_pid() {
  _sp_pid=$1
  _sp_sig=$2
  case $_sp_sig in
    KILL) kill -KILL "$_sp_pid" ;;
    *) kill "$_sp_pid" ;;
  esac
  _sp_status=$?
  if [ "$_sp_status" -eq 0 ]; then
    return 0
  fi
  if ! kill -0 "$_sp_pid" 2>/dev/null; then
    return 0
  fi
  return "$_sp_status"
}

tp_kill_pid() {
  _kp=$1
  case $_kp in
    ''|*[!0-9]*) return 0 ;;
  esac
  [ "$_kp" -eq 1 ] && return 0
  [ "$_kp" -eq $$ ] && return 0
  [ "$_kp" -eq "${PPID:-0}" ] && return 0
  if ! kill -0 "$_kp" 2>/dev/null; then
    return 0
  fi
  tp_run "signal process $_kp" tp_signal_pid "$_kp" TERM || true
  if [ "$DRY_RUN" = true ]; then
    return 0
  fi
  sleep 1
  if kill -0 "$_kp" 2>/dev/null; then
    tp_run "signal KILL process $_kp" tp_signal_pid "$_kp" KILL || true
  fi
  if kill -0 "$_kp" 2>/dev/null; then
    tp_record_fail "process $_kp did not exit"
  else
    printf '%s\n' "stopped process $_kp" >> "$TP_TMP/removed"
  fi
}

tp_exe_is_ours() {
  _eio=$1
  case $_eio in
    *" (deleted)") _eio=${_eio%" (deleted)"} ;;
  esac
  case $_eio in
    /opt/turbopanel|/opt/turbopanel/*) return 0 ;;
  esac
  for _eio_root in $TP_RUNTIMES_DIRS; do
    [ -n "$_eio_root" ] || continue
    case $_eio in
      "$_eio_root"|"$_eio_root"/*) return 0 ;;
    esac
  done
  return 1
}

# pkill exits 1 when no process matches. Keep that distinct from a real failure
# so a host with nothing to signal is not recorded as a failed uninstall.
tp_pkill_turbopanel() {
  pkill -f /opt/turbopanel
  _ppt_status=$?
  if [ "$_ppt_status" -eq 0 ] || [ "$_ppt_status" -eq 1 ]; then
    return 0
  fi
  return "$_ppt_status"
}

tp_kill_by_exe() {
  if [ ! -d /proc/1 ]; then
    if tp_has_tool pkill; then
      # Exit 1 means nothing matched. That is not a failed uninstall.
      tp_run "signal processes running from /opt/turbopanel" tp_pkill_turbopanel || true
    else
      tp_record_skip "pkill not installed"
    fi
    return 0
  fi
  for _kbe_proc in /proc/[0-9]*; do
    [ -d "$_kbe_proc" ] || continue
    _kbe_pid=${_kbe_proc#/proc/}
    _kbe_exe=$(readlink "$_kbe_proc/exe" 2>/dev/null || true)
    [ -n "$_kbe_exe" ] || continue
    if tp_exe_is_ours "$_kbe_exe"; then
      tp_kill_pid "$_kbe_pid"
    fi
  done
}

tp_account_delete_names() {
  : > "$TP_TMP/work.users"
  : > "$TP_TMP/work.groups"
  if ! tp_has_tool getent; then
    tp_record_skip "getent not installed"
    return 0
  fi
  getent passwd > "$TP_TMP/passwd" 2>/dev/null || true
  while IFS=: read -r _adn_name _adn_pw _adn_uid _adn_gid _adn_gecos _adn_home _adn_shell; do
    [ -n "$_adn_name" ] || continue
    if tp_home_is_principal "$_adn_home"; then
      continue
    fi
    if tp_name_is_tp "$_adn_name" && tp_id_in_band "$_adn_uid"; then
      tp_file_add "$TP_TMP/work.users" "$_adn_name"
    elif tp_home_in_install_tree "$_adn_home"; then
      tp_file_add "$TP_TMP/work.users" "$_adn_name"
    fi
  done < "$TP_TMP/passwd"
  getent group > "$TP_TMP/groups" 2>/dev/null || true
  while IFS=: read -r _adn_gname _adn_gpw _adn_ggid _adn_members; do
    [ -n "$_adn_gname" ] || continue
    if tp_name_is_tp "$_adn_gname" && tp_id_in_band "$_adn_ggid"; then
      tp_file_add "$TP_TMP/work.groups" "$_adn_gname"
    fi
  done < "$TP_TMP/groups"
}

tp_kill_users_in_file() {
  _kuif=$1
  [ -s "$_kuif" ] || return 0
  if ! tp_has_tool ps; then
    tp_record_skip "ps not installed"
    return 0
  fi
  while IFS= read -r _kuif_user; do
    [ -n "$_kuif_user" ] || continue
    _kuif_pids=$(ps -u "$_kuif_user" -o pid= 2>/dev/null || true)
    for _kuif_pid in $_kuif_pids; do
      tp_kill_pid "$_kuif_pid"
    done
  done < "$_kuif"
}

tp_kill_account_procs() {
  tp_kill_users_in_file "$TP_TMP/work.users"
}

tp_remove_processes_and_accounts() {
  tp_print_step "▸" "Processes and accounts"
  tp_account_delete_names
  tp_kill_by_exe
  tp_kill_account_procs
  if [ -s "$TP_TMP/work.users" ]; then
    if ! tp_has_tool userdel; then
      tp_record_skip "userdel not installed"
    else
      while IFS= read -r _rpa_user; do
        [ -n "$_rpa_user" ] || continue
        if getent passwd "$_rpa_user" >/dev/null 2>&1; then
          # No -r: service homes sit on state dirs this phase must keep.
          tp_run "userdel $_rpa_user" userdel "$_rpa_user" || true
        fi
      done < "$TP_TMP/work.users"
    fi
  else
    tp_print_ok "no service accounts to remove"
  fi
  if [ -s "$TP_TMP/work.groups" ]; then
    if ! tp_has_tool groupdel; then
      tp_record_skip "groupdel not installed"
    else
      while IFS= read -r _rpa_group; do
        [ -n "$_rpa_group" ] || continue
        if getent group "$_rpa_group" >/dev/null 2>&1; then
          tp_run "groupdel $_rpa_group" groupdel "$_rpa_group" || true
        fi
      done < "$TP_TMP/work.groups"
    fi
  else
    tp_print_ok "no service groups to remove"
  fi
}

# --- purge (option 2, after the remove-only steps) --------------------------

tp_purge_note_kept() {
  _pnk_pkg=$1
  _pnk_why=$2
  tp_file_add "$TP_TMP/kept-packages.names" "$_pnk_pkg"
  tp_file_add "$TP_TMP/kept-packages" "${_pnk_pkg}: ${_pnk_why}"
  tp_print_warn "keeping ${_pnk_pkg}: ${_pnk_why}"
}

tp_pkg_installed() {
  _pi_status=$(dpkg-query -W -f '${Status}' "$1" 2>/dev/null || true)
  [ "$_pi_status" = "install ok installed" ]
}

tp_pkg_protect_reason() {
  _protect_ess=$(dpkg-query -W -f '${Essential}' "$1" 2>/dev/null || true)
  _protect_pri=$(dpkg-query -W -f '${Priority}' "$1" 2>/dev/null || true)
  if [ "$_protect_ess" = yes ]; then
    printf '%s' "marked Essential"
    return 0
  fi
  if [ "$_protect_pri" = required ]; then
    printf '%s' "priority required"
    return 0
  fi
  return 1
}

tp_consider_apt_package() {
  _cap=$1
  [ -n "$_cap" ] || return 0
  tp_pkg_installed "$_cap" || return 0
  case $_cap in
    sudo|systemd-timesyncd|curl)
      tp_purge_note_kept "$_cap" "never removed by this script"
      return 0
      ;;
  esac
  _cap_why=$(tp_pkg_protect_reason "$_cap" || true)
  if [ -n "$_cap_why" ]; then
    tp_purge_note_kept "$_cap" "$_cap_why"
    return 0
  fi
  tp_file_add "$TP_TMP/apt.candidates" "$_cap"
}

tp_apt_source_removed_by_purge() {
  case $1 in
    /etc/apt/sources.list.d/sury-php.sources|/etc/apt/sources.list.d/sury-php.list)
      return 0
      ;;
  esac
  case $1 in
    /etc/apt/sources.list.d/*)
      grep -q 'download.docker.com' "$1" 2>/dev/null
      return $?
      ;;
  esac
  return 1
}

tp_apt_https_remains() {
  : > "$TP_TMP/apt.https"
  if [ -f /etc/apt/sources.list ]; then
    printf '%s\n' /etc/apt/sources.list >> "$TP_TMP/apt.https"
  fi
  if [ -d /etc/apt/sources.list.d ]; then
    find /etc/apt/sources.list.d -maxdepth 1 \( -type f -o -type l \) >> "$TP_TMP/apt.https" 2>/dev/null || true
  fi
  while IFS= read -r _ahr; do
    [ -n "$_ahr" ] || continue
    [ -f "$_ahr" ] || continue
    # Dry-run does not delete source files. Ignore the ones purge removes
    # before this check so the package plan matches a real run. Sources that
    # survive those removals still count.
    if [ "$DRY_RUN" = true ] && tp_apt_source_removed_by_purge "$_ahr"; then
      continue
    fi
    if grep -q 'https://' "$_ahr" 2>/dev/null; then
      return 0
    fi
  done < "$TP_TMP/apt.https"
  return 1
}

tp_drop_https_tls_packages() {
  tp_apt_https_remains || return 0
  for _dht in ca-certificates openssl; do
    if [ -f "$TP_TMP/apt.candidates" ] && grep -Fxq "$_dht" "$TP_TMP/apt.candidates"; then
      grep -Fxv "$_dht" "$TP_TMP/apt.candidates" > "$TP_TMP/apt.candidates.next" || true
      mv "$TP_TMP/apt.candidates.next" "$TP_TMP/apt.candidates"
      tp_purge_note_kept "$_dht" "an apt source still uses https://"
    fi
  done
}

tp_collect_purge_candidates() {
  : > "$TP_TMP/apt.candidates"
  for _cpc in $TP_PURGE_BASE_PACKAGES $TP_PURGE_APACHE_PACKAGES; do
    tp_consider_apt_package "$_cpc"
  done
  dpkg-query -W -f '${Package}\n' 'php*' > "$TP_TMP/apt.php" 2>/dev/null || true
  while IFS= read -r _cpc; do
    [ -n "$_cpc" ] || continue
    tp_consider_apt_package "$_cpc"
  done < "$TP_TMP/apt.php"
  tp_consider_apt_package debsuryorg-archive-keyring
  tp_drop_https_tls_packages
  if [ -s "$TP_TMP/apt.candidates" ]; then
    LC_ALL=C sort -u "$TP_TMP/apt.candidates" > "$TP_TMP/apt.candidates.sorted"
    mv "$TP_TMP/apt.candidates.sorted" "$TP_TMP/apt.candidates"
  fi
}

# apt-get -s stays in English under LC_ALL=C. Purg/Remv lines are one package
# each; the REMOVED paragraph is the same set wrapped across lines.
tp_apt_parse_removed() {
  awk '
    function emit(name) {
      sub(/\*$/, "", name)
      sub(/:.*/, "", name)
      gsub(/^[ \t]+|[ \t]+$/, "", name)
      if (name != "") print name
    }
    $1 == "Purg" || $1 == "Remv" { emit($2); next }
    /^The following packages will be REMOVED:/ { grab = 1; next }
    grab && /^[0-9]+ upgraded/ { grab = 0; next }
    grab && /^[^[:space:]]/ { grab = 0; next }
    grab {
      for (i = 1; i <= NF; i++) emit($i)
    }
  ' "$1"
}

tp_apt_simulate_file() {
  _asf_list=$1
  _asf_out=$2
  : > "$_asf_out"
  [ -s "$_asf_list" ] || return 0
  set --
  while IFS= read -r _asf_pkg; do
    [ -n "$_asf_pkg" ] || continue
    set -- "$@" "$_asf_pkg"
  done < "$_asf_list"
  [ "$#" -gt 0 ] || return 0
  tp_log_line "simulate: apt-get -s purge $*"
  if ! env LC_ALL=C DEBIAN_FRONTEND=noninteractive apt-get -s purge "$@" > "$TP_TMP/apt.sim.raw" 2>&1; then
    cat "$TP_TMP/apt.sim.raw" >> "$TP_LOG_FILE" 2>/dev/null || true
    return 1
  fi
  cat "$TP_TMP/apt.sim.raw" >> "$TP_LOG_FILE" 2>/dev/null || true
  tp_apt_parse_removed "$TP_TMP/apt.sim.raw" | LC_ALL=C sort -u > "$_asf_out"
  return 0
}

tp_sim_write_extras() {
  _swe_sim=$1
  _swe_allow=$2
  _swe_dest=$3
  : > "$_swe_dest"
  while IFS= read -r _swe_name; do
    [ -n "$_swe_name" ] || continue
    if ! grep -Fxq "$_swe_name" "$_swe_allow"; then
      printf '%s\n' "$_swe_name" >> "$_swe_dest"
    fi
  done < "$_swe_sim"
  if [ -s "$_swe_dest" ]; then
    LC_ALL=C sort -u "$_swe_dest" > "$_swe_dest.sorted"
    mv "$_swe_dest.sorted" "$_swe_dest"
  fi
}

tp_file_words() {
  _fw=
  while IFS= read -r _fw_line; do
    [ -n "$_fw_line" ] || continue
    if [ -z "$_fw" ]; then
      _fw=${_fw_line}
    else
      _fw="${_fw} ${_fw_line}"
    fi
  done < "$1"
  printf '%s' "$_fw"
}

# _sim_kind is ok, extras, or fail. extras also sets _sim_why.
# ok means every requested package showed up in the simulation and every
# package the simulation would remove is on the allow list.
tp_classify_removal() {
  _cr_list=$1
  _cr_allow=$2
  _sim_kind=fail
  _sim_why=
  if ! tp_apt_simulate_file "$_cr_list" "$TP_TMP/apt.sim.check"; then
    return 0
  fi
  while IFS= read -r _cr_pkg; do
    [ -n "$_cr_pkg" ] || continue
    if ! grep -Fxq "$_cr_pkg" "$TP_TMP/apt.sim.check"; then
      return 0
    fi
  done < "$_cr_list"
  tp_sim_write_extras "$TP_TMP/apt.sim.check" "$_cr_allow" "$TP_TMP/apt.extras"
  if [ -s "$TP_TMP/apt.extras" ]; then
    _sim_kind=extras
    _sim_why=$(tp_file_words "$TP_TMP/apt.extras")
    return 0
  fi
  _sim_kind=ok
}

tp_choose_note_sim() {
  _cns_pkg=$1
  if [ "$_sim_kind" = extras ]; then
    tp_purge_note_kept "$_cns_pkg" "purge would also remove ${_sim_why}"
  else
    tp_purge_note_kept "$_cns_pkg" "could not simulate removal"
  fi
}

tp_choose_purge_packages() {
  : > "$TP_TMP/apt.final"
  [ -s "$TP_TMP/apt.candidates" ] || return 0
  tp_classify_removal "$TP_TMP/apt.candidates" "$TP_TMP/apt.candidates"
  if [ "$_sim_kind" = ok ]; then
    cp "$TP_TMP/apt.candidates" "$TP_TMP/apt.final"
    return 0
  fi
  if [ "$_sim_kind" = extras ]; then
    tp_print_warn "Purging these packages together would remove others; testing them one at a time"
  else
    tp_print_warn "Could not simulate purging these packages together; testing them one at a time"
  fi
  : > "$TP_TMP/apt.growing"
  while IFS= read -r _cpp_pkg; do
    [ -n "$_cpp_pkg" ] || continue
    printf '%s\n' "$_cpp_pkg" > "$TP_TMP/apt.one"
    tp_classify_removal "$TP_TMP/apt.one" "$TP_TMP/apt.candidates"
    if [ "$_sim_kind" != ok ]; then
      tp_choose_note_sim "$_cpp_pkg"
      continue
    fi
    if [ -s "$TP_TMP/apt.growing" ]; then
      cp "$TP_TMP/apt.growing" "$TP_TMP/apt.trial"
      printf '%s\n' "$_cpp_pkg" >> "$TP_TMP/apt.trial"
      tp_classify_removal "$TP_TMP/apt.trial" "$TP_TMP/apt.candidates"
      if [ "$_sim_kind" != ok ]; then
        tp_choose_note_sim "$_cpp_pkg"
        continue
      fi
    fi
    printf '%s\n' "$_cpp_pkg" >> "$TP_TMP/apt.growing"
  done < "$TP_TMP/apt.candidates"
  if [ -s "$TP_TMP/apt.growing" ]; then
    cp "$TP_TMP/apt.growing" "$TP_TMP/apt.final"
  fi
}

tp_run_listed_packages() {
  _rlp_desc=$1
  _rlp_file=$2
  shift 2
  [ -s "$_rlp_file" ] || return 0
  _rlp_any=false
  while IFS= read -r _rlp_pkg; do
    [ -n "$_rlp_pkg" ] || continue
    set -- "$@" "$_rlp_pkg"
    _rlp_any=true
  done < "$_rlp_file"
  [ "$_rlp_any" = true ] || return 0
  tp_run "$_rlp_desc" "$@" || true
}

tp_protect_never_removed_packages() {
  for _pnr in $TP_AUTOREMOVE_PROTECTED; do
    tp_pkg_installed "$_pnr" || continue
    if [ -f "$TP_TMP/kept-packages.names" ] && grep -Fxq "$_pnr" "$TP_TMP/kept-packages.names"; then
      continue
    fi
    tp_purge_note_kept "$_pnr" "never removed by this script"
  done
}

tp_mark_kept_packages_manual() {
  [ -s "$TP_TMP/kept-packages.names" ] || return 0
  if ! tp_has_tool apt-mark; then
    tp_record_skip "apt-mark not installed"
    return 1
  fi
  _mkp_fail=false
  while IFS= read -r _mkp; do
    [ -n "$_mkp" ] || continue
    tp_pkg_installed "$_mkp" || continue
    if ! tp_run "mark $_mkp manual" apt-mark manual "$_mkp"; then
      _mkp_fail=true
    fi
  done < "$TP_TMP/kept-packages.names"
  [ "$_mkp_fail" = false ]
}

tp_purge_apt_packages() {
  tp_print_step "▸" "Apt packages"
  if ! tp_has_tool apt-get || ! tp_has_tool dpkg-query; then
    tp_record_skip "apt-get or dpkg-query not installed"
    return 0
  fi
  for _pap in /etc/apt/sources.list.d/sury-php.sources /etc/apt/sources.list.d/sury-php.list; do
    if [ -e "$_pap" ] || [ -L "$_pap" ]; then
      tp_run "remove $_pap" rm -f "$_pap" || true
    fi
  done
  tp_run "apt-get update" env LC_ALL=C DEBIAN_FRONTEND=noninteractive apt-get update || true
  tp_collect_purge_candidates
  tp_choose_purge_packages
  # sudo, systemd-timesyncd, and curl are not purge candidates. Mark them
  # manual before autoremove, or an automatic install is removed with its
  # stack. curl is kept so the reinstall commands this script prints (and
  # the curl | sh install itself) still work after a purge.
  tp_protect_never_removed_packages
  _pap_marked=false
  if tp_mark_kept_packages_manual; then
    _pap_marked=true
  fi
  tp_run_listed_packages "purge apt packages" "$TP_TMP/apt.final" \
    env LC_ALL=C DEBIAN_FRONTEND=noninteractive apt-get purge -y
  if [ "$_pap_marked" = true ]; then
    tp_run "autoremove apt packages" \
      env LC_ALL=C DEBIAN_FRONTEND=noninteractive apt-get autoremove --purge -y || true
  else
    tp_print_error "skipped autoremove so sudo, systemd-timesyncd, and curl cannot be removed"
    tp_record_fail "skipped autoremove so sudo, systemd-timesyncd, and curl cannot be removed"
  fi
}

tp_stop_unit_if_running() {
  _suir=$1
  tp_has_tool systemctl || return 0
  tp_unit_present "$_suir" || return 0
  _suir_state=$(systemctl is-active "$_suir" 2>/dev/null || true)
  case $_suir_state in
    inactive|unknown|failed|"") return 0 ;;
  esac
  tp_run "stop $_suir" systemctl stop "$_suir" || true
}

tp_collect_signed_by() {
  _csb_file=$1
  _csb_out=$2
  grep -E '^[[:space:]]*Signed-By:|signed-by=' "$_csb_file" > "$TP_TMP/docker.signed" 2>/dev/null || true
  while IFS= read -r _csb_line; do
    [ -n "$_csb_line" ] || continue
    _csb_rest=$_csb_line
    case $_csb_rest in
      *signed-by=*) _csb_rest=${_csb_rest#*signed-by=} ;;
      *Signed-By:*) _csb_rest=${_csb_rest#*Signed-By:} ;;
      *) continue ;;
    esac
    _csb_rest=${_csb_rest# }
    set -f
    for _csb_word in $_csb_rest; do
      _csb_word=${_csb_word#\"}
      _csb_word=${_csb_word%\"}
      _csb_word=${_csb_word#\'}
      _csb_word=${_csb_word%\'}
      _csb_word=${_csb_word%%]*}
      _csb_word=${_csb_word%%,*}
      case $_csb_word in
        /*) tp_file_add "$_csb_out" "$_csb_word" ;;
      esac
    done
    set +f
  done < "$TP_TMP/docker.signed"
}

tp_purge_docker_sources() {
  [ -d /etc/apt/sources.list.d ] || return 0
  : > "$TP_TMP/docker.keyrings"
  find /etc/apt/sources.list.d -maxdepth 1 \( -type f -o -type l \) > "$TP_TMP/docker.sourcefiles" 2>/dev/null || true
  while IFS= read -r _pds; do
    [ -n "$_pds" ] || continue
    grep -q 'download.docker.com' "$_pds" 2>/dev/null || continue
    tp_collect_signed_by "$_pds" "$TP_TMP/docker.keyrings"
    tp_run "remove $_pds" rm -f "$_pds" || true
  done < "$TP_TMP/docker.sourcefiles"
  [ -s "$TP_TMP/docker.keyrings" ] || return 0
  while IFS= read -r _pds_key; do
    [ -n "$_pds_key" ] || continue
    [ -e "$_pds_key" ] || [ -L "$_pds_key" ] || continue
    if ! tp_path_is_safe "$_pds_key"; then
      tp_record_fail "refusing unsafe Docker keyring ${_pds_key}"
      tp_print_error "refusing unsafe Docker keyring ${_pds_key}"
      continue
    fi
    if [ -d "$_pds_key" ] && [ ! -L "$_pds_key" ]; then
      tp_safe_rm_tree "$_pds_key"
    else
      tp_run "remove $_pds_key" rm -f "$_pds_key" || true
    fi
  done < "$TP_TMP/docker.keyrings"
}

tp_purge_docker_data_root() {
  if [ "$TP_DOCKER_DATA_ROOT_STATUS" = unknown ]; then
    tp_print_error "Docker data root could not be determined. Custom containers, images, and volumes may remain."
    tp_record_fail "Docker data root could not be determined"
    return 0
  fi
  [ "$TP_DOCKER_DATA_ROOT_STATUS" = custom ] || return 0
  [ -n "$TP_DOCKER_DATA_ROOT" ] || return 0
  if ! tp_path_is_safe "$TP_DOCKER_DATA_ROOT"; then
    tp_print_error "could not remove Docker data root ${TP_DOCKER_DATA_ROOT}"
    tp_record_fail "could not remove Docker data root ${TP_DOCKER_DATA_ROOT}"
    return 0
  fi
  tp_safe_rm_tree "$TP_DOCKER_DATA_ROOT"
  if [ "$DRY_RUN" = true ]; then
    return 0
  fi
  if tp_path_present "$TP_DOCKER_DATA_ROOT" && ! tp_empty_retained_mount "$TP_DOCKER_DATA_ROOT"; then
    tp_print_error "could not remove Docker data root ${TP_DOCKER_DATA_ROOT}"
    tp_record_fail "could not remove Docker data root ${TP_DOCKER_DATA_ROOT}"
  fi
}

tp_purge_docker_engine() {
  tp_print_step "▸" "Docker Engine"
  # Capture data-root while daemon.json and the daemon are still available.
  tp_resolve_docker_data_root
  tp_stop_unit_if_running docker.socket
  tp_stop_unit_if_running docker
  tp_stop_unit_if_running containerd
  : > "$TP_TMP/docker.pkgs"
  if ! tp_has_tool dpkg-query; then
    tp_record_skip "dpkg-query not installed"
  else
    for _pde in $TP_DOCKER_PACKAGES; do
      if tp_pkg_installed "$_pde"; then
        tp_file_add "$TP_TMP/docker.pkgs" "$_pde"
      fi
    done
  fi
  if [ -s "$TP_TMP/docker.pkgs" ]; then
    if tp_has_tool apt-get; then
      tp_run_listed_packages "purge Docker packages" "$TP_TMP/docker.pkgs" \
        env LC_ALL=C DEBIAN_FRONTEND=noninteractive apt-get purge -y
    else
      tp_record_skip "apt-get not installed"
    fi
  fi
  tp_safe_rm_tree /var/lib/docker
  tp_safe_rm_tree /var/lib/containerd
  tp_purge_docker_data_root
  tp_safe_rm_tree /etc/docker
  tp_purge_docker_sources
  if tp_has_tool getent && getent group docker >/dev/null 2>&1; then
    if tp_has_tool groupdel; then
      tp_run "groupdel docker" groupdel docker || true
    else
      tp_record_skip "groupdel not installed"
    fi
  fi
  if tp_has_tool ip; then
    if ip link show docker0 >/dev/null 2>&1; then
      tp_run "delete docker0 bridge" ip link del docker0 || true
    fi
  else
    tp_record_skip "ip not installed"
  fi
}

tp_purge_path_file() {
  _ppf=$1
  [ -s "$_ppf" ] || return 0
  awk '{ printf "%d %s\n", length($0), $0 }' "$_ppf" | sort -nr > "$TP_TMP/purge.ranked"
  while IFS= read -r _ppf_line; do
    [ -n "$_ppf_line" ] || continue
    _ppf_path=${_ppf_line#* }
    [ -n "$_ppf_path" ] || continue
    tp_safe_rm_tree "$_ppf_path"
  done < "$TP_TMP/purge.ranked"
}

tp_purge_data_folders() {
  tp_print_step "▸" "Data folders"
  : > "$TP_TMP/purge.paths"
  for _pdf in $TP_CONFIG_DIRS $TP_STATE_DIRS $TP_LOG_DIRS $TP_RUN_DIRS $TP_BACKUP_DIRS /etc/ssh/turbopanel; do
    [ -n "$_pdf" ] || continue
    tp_file_add "$TP_TMP/purge.paths" "$_pdf"
  done
  tp_purge_path_file "$TP_TMP/purge.paths"
}

# Primary gid is not listed in the group members field. A group still has a
# member when either that field is set or some account uses the gid.
tp_group_has_members() {
  _ghm=$1
  _ghm_line=$(getent group "$_ghm" 2>/dev/null | head -n 1 || true)
  [ -n "$_ghm_line" ] || return 1
  _ghm_gid=$(printf '%s\n' "$_ghm_line" | awk -F: '{ print $3; exit }')
  _ghm_members=$(printf '%s\n' "$_ghm_line" | awk -F: '{ print $4; exit }')
  [ -n "$_ghm_members" ] && return 0
  [ -n "$_ghm_gid" ] || return 1
  getent passwd | awk -F: -v gid="$_ghm_gid" '$4 == gid { found = 1 } END { exit !found }'
}

tp_principal_leave_home() {
  _plh_home=$1
  _plh_why=$2
  _ppr_hold=true
  tp_record_skip "left ${_plh_home} in place (${_plh_why})"
}

tp_purge_principal_account() {
  _ppa_user=$1
  _ppa_home=$2
  _ppa_root=$3
  if getent passwd "$_ppa_user" >/dev/null 2>&1; then
    if [ "$DRY_RUN" != true ] && ! tp_has_tool userdel; then
      tp_principal_leave_home "$_ppa_home" "userdel not installed"
      return 0
    fi
    tp_run "userdel $_ppa_user" userdel "$_ppa_user" || true
    if [ "$DRY_RUN" != true ] && getent passwd "$_ppa_user" >/dev/null 2>&1; then
      tp_principal_leave_home "$_ppa_home" "${_ppa_user} still exists"
      return 0
    fi
  fi
  _ppa_grp="${_ppa_user}-grp"
  if getent group "$_ppa_grp" >/dev/null 2>&1; then
    if [ "$DRY_RUN" != true ] && ! tp_has_tool groupdel; then
      tp_principal_leave_home "$_ppa_home" "groupdel not installed"
      return 0
    fi
    tp_run "groupdel $_ppa_grp" groupdel "$_ppa_grp" || true
    if [ "$DRY_RUN" != true ] && getent group "$_ppa_grp" >/dev/null 2>&1; then
      tp_principal_leave_home "$_ppa_home" "${_ppa_grp} still exists"
      return 0
    fi
  fi
  _ppa_home=$(tp_normalize_path "$_ppa_home")
  if [ "$_ppa_home" = "$_ppa_root" ]; then
    return 0
  fi
  tp_file_add "$TP_TMP/principal.homes" "$_ppa_home"
}

tp_purge_principal_orphan() {
  _ppo_dir=$1
  _ppo_root=$2
  _ppo_name=$(basename "$_ppo_dir")
  [ -n "$_ppo_name" ] || return 0
  [ "$_ppo_name" = lost+found ] && return 0
  _ppo_grp="${_ppo_name}-grp"
  if getent group "$_ppo_grp" >/dev/null 2>&1; then
    if tp_group_has_members "$_ppo_grp"; then
      tp_principal_leave_home "$_ppo_dir" "${_ppo_grp} still has members"
      return 0
    fi
    if [ "$DRY_RUN" != true ] && ! tp_has_tool groupdel; then
      tp_principal_leave_home "$_ppo_dir" "groupdel not installed"
      return 0
    fi
    tp_run "groupdel $_ppo_grp" groupdel "$_ppo_grp" || true
    if [ "$DRY_RUN" != true ] && getent group "$_ppo_grp" >/dev/null 2>&1; then
      tp_principal_leave_home "$_ppo_dir" "${_ppo_grp} still exists"
      return 0
    fi
  fi
  _ppo_dir=$(tp_normalize_path "$_ppo_dir")
  if [ "$_ppo_dir" = "$_ppo_root" ]; then
    return 0
  fi
  tp_file_add "$TP_TMP/principal.homes" "$_ppo_dir"
}

tp_home_under_root() {
  _hur_home=$1
  _hur_root=$2
  case $_hur_home in
    "$_hur_root"|"$_hur_root"/*) return 0 ;;
  esac
  return 1
}

tp_purge_principal_root_dirs() {
  _pprd=$1
  [ -d "$_pprd" ] || [ -L "$_pprd" ] || return 0
  for _ppr_child in "$_pprd"/*; do
    [ -d "$_ppr_child" ] || continue
    _ppr_child_norm=$(tp_normalize_path "$_ppr_child")
    if grep -Fxq "$_ppr_child_norm" "$TP_TMP/principal.known-homes"; then
      continue
    fi
    tp_purge_principal_orphan "$_ppr_child_norm" "$_pprd"
  done
}

tp_purge_principal_root() {
  _ppr=$(tp_normalize_path "$1")
  [ -n "$_ppr" ] || return 0
  _ppr_hold=false
  : > "$TP_TMP/principal.users"
  : > "$TP_TMP/principal.rows"
  : > "$TP_TMP/principal.homes"
  : > "$TP_TMP/principal.known-homes"
  # An empty passwd list must not look like "every directory is an orphan".
  # Accounts are removed even when the home root directory is already gone.
  if ! getent passwd > "$TP_TMP/passwd" 2>/dev/null || [ ! -s "$TP_TMP/passwd" ]; then
    tp_record_fail "list accounts under $_ppr"
    return 0
  fi
  while IFS=: read -r _ppr_name _ppr_pw _ppr_uid _ppr_gid _ppr_gecos _ppr_home _ppr_shell; do
    [ -n "$_ppr_name" ] || continue
    [ -n "$_ppr_home" ] || continue
    _ppr_home=$(tp_normalize_path "$_ppr_home")
    tp_home_under_root "$_ppr_home" "$_ppr" || continue
    printf '%s|%s\n' "$_ppr_name" "$_ppr_home" >> "$TP_TMP/principal.rows"
    printf '%s\n' "$_ppr_home" >> "$TP_TMP/principal.known-homes"
    tp_file_add "$TP_TMP/principal.users" "$_ppr_name"
  done < "$TP_TMP/passwd"
  tp_kill_users_in_file "$TP_TMP/principal.users"
  while IFS= read -r _ppr_row; do
    [ -n "$_ppr_row" ] || continue
    _ppr_name=${_ppr_row%%|*}
    _ppr_home=${_ppr_row#*|}
    tp_purge_principal_account "$_ppr_name" "$_ppr_home" "$_ppr"
  done < "$TP_TMP/principal.rows"
  tp_purge_principal_root_dirs "$_ppr"
  tp_purge_path_file "$TP_TMP/principal.homes"
  if [ -d "$_ppr" ] || [ -L "$_ppr" ]; then
    if [ "$_ppr_hold" = false ] && tp_path_is_safe "$_ppr"; then
      tp_safe_rm_tree "$_ppr"
    fi
  fi
}

tp_purge_principals() {
  tp_print_step "▸" "Principal users"
  if ! tp_has_tool getent; then
    tp_record_skip "getent not installed"
    return 0
  fi
  for _pp_root in $TP_PRINCIPAL_HOME_ROOTS; do
    [ -n "$_pp_root" ] || continue
    tp_purge_principal_root "$_pp_root"
  done
}

tp_purge_hosted_data() {
  : > "$TP_TMP/kept-packages"
  : > "$TP_TMP/kept-packages.names"
  tp_purge_principals
  tp_purge_docker_engine
  tp_purge_data_folders
  tp_purge_apt_packages
}

tp_report_remaining() {
  _rr_title=$1
  _rr_key=$2
  [ "$DRY_RUN" = true ] && return 0
  [ -s "$TP_TMP/inv.${_rr_key}" ] || return 0
  LC_ALL=C sort "$TP_TMP/before.${_rr_key}" > "$TP_TMP/before.sorted"
  LC_ALL=C sort "$TP_TMP/inv.${_rr_key}" > "$TP_TMP/after.sorted"
  LC_ALL=C comm -12 "$TP_TMP/before.sorted" "$TP_TMP/after.sorted" > "$TP_TMP/remain"
  : > "$TP_TMP/remain.real"
  while IFS= read -r _rr_line; do
    [ -n "$_rr_line" ] || continue
    if [ "$_rr_key" = folders_remove ] || [ "$_rr_key" = folders_keep ] || [ "$_rr_key" = principals ] || [ "$_rr_key" = purge_targets ]; then
      _rr_path=$_rr_line
      case $_rr_path in
        *" (older release)") _rr_path=${_rr_path% (older release)} ;;
      esac
      # The mount directory is kept on purpose once its contents are gone.
      if tp_empty_retained_mount "$_rr_path"; then
        continue
      fi
    fi
    printf '%s\n' "$_rr_line" >> "$TP_TMP/remain.real"
  done < "$TP_TMP/remain"
  if [ -s "$TP_TMP/remain.real" ]; then
    tp_print_error "Could not remove ${_rr_title}:"
    while IFS= read -r _rr_line; do
      [ -n "$_rr_line" ] || continue
      tp_say "  ${_rr_line}"
    done < "$TP_TMP/remain.real"
    tp_record_fail "could not remove ${_rr_title}"
  fi
}

tp_print_reinstall_commands() {
  tp_say ""
  tp_say "Install a daemon again:"
  tp_say "  curl -fsSL turbopanel.sh | TURBOPANEL_LICENSE=<license> sh"
  tp_say "Install a self-hosted control plane again:"
  tp_say "  curl -fsSL turbopanel.sh | sh"
}

tp_print_protected_package_note() {
  _ppn=
  for _ppn_pkg in $TP_AUTOREMOVE_PROTECTED; do
    if [ -f "$TP_TMP/kept-packages.names" ] && grep -Fxq "$_ppn_pkg" "$TP_TMP/kept-packages.names"; then
      _ppn="${_ppn} ${_ppn_pkg}"
    fi
  done
  [ -n "$_ppn" ] || return 0
  tp_say "Marked manual so autoremove cannot remove:${_ppn}."
}

tp_print_purge_notes() {
  tp_print_group "Packages kept" "$TP_TMP/kept-packages"
  tp_print_protected_package_note
  tp_print_warn "sury-provided library versions stay installed."
  tp_print_warn "ufw and firewalld were removed when TurboPanel was installed and are not restored."
  tp_say "/etc/systemd/timesyncd.conf is left as TurboPanel wrote it."
  tp_say "Reboot this host to clear leftover kernel state (bridges and NAT rules)."
}

tp_print_summary() {
  tp_say ""
  tp_print_step "▸" "Summary"
  if [ "$DRY_RUN" != true ]; then
    tp_report_remaining "units" units
    tp_report_remaining "containers" containers
    tp_report_remaining "networks" networks
    tp_report_remaining "firewall chains" chains
    tp_report_remaining "WireGuard" wireguard
    tp_report_remaining "host files" hostfiles
    tp_report_remaining "shell startup files" shellrc
    tp_report_remaining "folders" folders_remove
    tp_report_remaining "accounts" accounts
    tp_report_remaining "groups" groups
  fi
  tp_print_group "Removed" "$TP_TMP/removed"
  tp_print_group "Skipped" "$TP_TMP/skipped"
  tp_print_group "Failed" "$TP_TMP/failed"
  if [ "$TP_ACTION" = purge ]; then
    if [ "$DRY_RUN" != true ]; then
      tp_report_remaining "hosted data" purge_targets
    fi
    tp_print_purge_notes
  fi
  if [ "$DRY_RUN" = true ]; then
    if [ "$TP_ACTION" = purge ]; then
      tp_print_reinstall_commands
    fi
    tp_print_ok "Dry run finished — nothing was changed"
    tp_say "Log: ${TP_LOG_FILE}"
    return 0
  fi
  if [ "$TP_ACTION" != purge ]; then
    tp_print_group "Kept data folders" "$TP_TMP/inv.folders_keep"
    tp_print_group "Kept Docker volumes" "$TP_TMP/inv.volumes"
    tp_print_group "Left alone" "$TP_TMP/inv.leftalone"
    tp_say "Docker images, Docker Engine, and apt packages were kept."
    tp_say ""
    tp_say "Principal users were not deleted. Service groups in the 9900-9999 band"
    tp_say "(including SFTP and shell groups) were removed, so principal users lost"
    tp_say "those groups. Re-apply access after the host is enrolled again."
  fi
  tp_print_reinstall_commands
  tp_say ""
  tp_say "Log: ${TP_LOG_FILE}"
  if [ "$TP_FAIL_COUNT" -gt 0 ]; then
    tp_print_error "${TP_FAIL_COUNT} step(s) failed"
  else
    if [ "$TP_ACTION" = purge ]; then
      tp_clear_purge_resume || true
    fi
    if [ "$TP_FAIL_COUNT" -gt 0 ]; then
      tp_print_error "${TP_FAIL_COUNT} step(s) failed"
    else
      tp_print_ok "Uninstall finished"
    fi
  fi
}

tp_on_signal() {
  if [ "${TP_STARTED_REMOVAL:-false}" = true ] && [ "${DRY_RUN:-false}" != true ]; then
    tp_print_error "Interrupted — this host may be partly uninstalled. Log: ${TP_LOG_FILE:-}"
  else
    tp_print_error "Aborted — nothing changed"
  fi
  exit 130
}

tp_cleanup() {
  if [ -n "${TP_TMP:-}" ] && [ -d "${TP_TMP}" ]; then
    rm -rf "$TP_TMP"
  fi
}

tp_main() {
  # mktemp creates the file with O_EXCL. A predictable name in /var/tmp can be
  # planted as a symlink; appending and chmod would then follow it.
  TP_LOG_FILE=$(umask 077; mktemp "/var/tmp/turbopanel-uninstall-$(date -u +%Y%m%dT%H%M%SZ).XXXXXX") || {
    tp_print_error "Could not create a secure uninstall log. Nothing was changed."
    exit 1
  }
  if [ -L "$TP_LOG_FILE" ] || [ ! -f "$TP_LOG_FILE" ]; then
    tp_print_error "Could not create a secure uninstall log. Nothing was changed."
    exit 1
  fi
  TP_TMP=$(mktemp -d /var/tmp/turbopanel-uninstall.XXXXXX) || {
    tp_print_error "Could not create a temporary directory. Nothing was changed."
    exit 1
  }
  : > "$TP_TMP/removed"
  : > "$TP_TMP/skipped"
  : > "$TP_TMP/failed"
  trap 'tp_on_signal' INT TERM
  trap 'tp_cleanup' EXIT

  tp_print_step "▸" "TurboPanel uninstall"
  tp_print_step "·" "Log: ${TP_LOG_FILE}"
  if [ "$DRY_RUN" = true ]; then
    tp_print_warn "Dry run — no changes will be made"
  fi
  if ! tp_legacy_lists_aligned; then
    tp_print_warn "TP_LEGACY_ACCOUNTS and TP_LEGACY_ACCOUNT_IDS differ in length"
  fi

  tp_discover_paths
  tp_refuse_dev_environment
  tp_inventory
  # A finished host has an empty inventory. An interrupted purge can look the
  # same once data folders are gone, while apt packages or Docker data remain.
  # The marker is the only reason to continue; Docker alone is not an install.
  if tp_inventory_empty && ! tp_purge_marker_pending; then
    tp_print_ok "TurboPanel is not installed on this host"
    exit 0
  fi
  tp_detect_server_type
  tp_print_report
  if tp_purge_marker_pending; then
    tp_print_warn "A previous purge did not finish. Resuming purge."
    TP_ACTION=purge
  else
    tp_menu
  fi
  tp_confirm

  TP_STARTED_REMOVAL=true
  tp_snapshot_inventory
  if [ "$TP_ACTION" = purge ]; then
    if ! tp_persist_purge_resume; then
      tp_print_error "Could not save purge resume state. No removal steps were run."
      exit 1
    fi
  fi
  tp_remove_units
  tp_remove_docker
  tp_remove_firewall
  tp_remove_wireguard
  tp_remove_host_config
  tp_remove_folders_and_shell
  tp_remove_processes_and_accounts
  if [ "$TP_ACTION" = purge ]; then
    tp_purge_hosted_data
  fi
  TP_INV_QUIET=true
  tp_inventory
  tp_print_summary
  if [ "$DRY_RUN" != true ] && [ "$TP_FAIL_COUNT" -gt 0 ]; then
    exit 1
  fi
  exit 0
}

# Root check is the first thing that runs. Nothing above this line reads the
# host or prints, aside from function definitions.
if [ "$(id -u)" != 0 ]; then
  tp_print_error "root is required"
  tp_print_error "  curl -fsSL https://raw.githubusercontent.com/TurboPanel/turbopaneld/trunk/scripts/uninstall.sh | sudo sh"
  tp_print_error "  sudo sh uninstall.sh"
  exit 1
fi

DRY_RUN=false
for _arg in "$@"; do
  case $_arg in
    --dry-run) DRY_RUN=true ;;
    *)
      tp_print_error "Unknown argument: $_arg"
      tp_print_error "Usage: sudo sh uninstall.sh [--dry-run]"
      exit 1
      ;;
  esac
done

set -u

PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin${PATH:+:$PATH}"
export PATH

TP_FAIL_COUNT=0
TP_STARTED_REMOVAL=false
TP_INV_QUIET=false
TP_LOG_FILE=
TP_TMP=
TP_ACTION=
TP_CODE=
TP_HOSTNAME=
TP_INSTANCE_URL=
TP_SERVER_KIND=
TP_SERVER_LABEL=
TP_BACKUP_EXPLICIT=false
TP_PRINCIPAL_EXPLICIT=false
TP_DOCKER_DATA_ROOT=
TP_DOCKER_DATA_ROOT_STATUS=default
TP_DOCKER_DATA_ROOT_LOCKED=false
TP_DOCKER_DATA_ROOT_SAVED=
TP_DOCKER_DATA_ROOT_SAVED_UNKNOWN=false
TP_DOCKER_ROOT_PARSED=
TP_DOCKER_ROOT_JSON_BAD=false
TP_DOCKER_ROOT_JSON_SEEN=false
TP_DOCKER_ROOT_EXEC_BAD=false
TP_CONFIG_DIRS=
TP_STATE_DIRS=
TP_LOG_DIRS=
TP_RUNTIMES_DIRS=
TP_RUN_DIRS=
TP_BACKUP_DIRS=
TP_PRINCIPAL_HOME_ROOTS=
TP_OTHER_DIRS=

# Older names retired by later releases. When a release renames or retires a
# unit, account, path, or container name, add the old name here.
# TP_LEGACY_ACCOUNT_IDS lines up with TP_LEGACY_ACCOUNTS. Those ids are also
# the current service-account band, so deletion keys off the name plus the
# 9900-9999 band, not the id alone.
TP_LEGACY_ACCOUNTS="turbopanel turbopaneli turbopanelc"
TP_LEGACY_ACCOUNT_IDS="9999 9998 9997"
TP_LEGACY_UNITS="turbopanel-mailer.service turbopanel-php-fpm.service"
TP_LEGACY_CONTAINER_NAMES="turbopanel-database turbopanel-queue"
TP_LEGACY_OPT_PATHS="runtimes platform share/ansible lib/instance vendor/duckdb share/caddy bin/turbopanel-instance bin/turbopanel-mailer"
TP_LEGACY_SHELL_RC_NEEDLE='/opt/turbopanel/runtimes/deno/.install/env'
TP_SYSTEMD_DIRS="/etc/systemd/system /usr/local/lib/systemd/system /lib/systemd/system /usr/lib/systemd/system"
TP_DAEMON_ENV=/etc/turbopanel/daemon.env
TP_RESUME_DIR=/var/lib/turbopanel-uninstall
TP_PURGE_MARKER=$TP_RESUME_DIR/purge-in-progress
TP_RESUME_MANIFEST=$TP_RESUME_DIR/resume-manifest
TP_DOCKER_DATA_ROOT_DEFAULT=/var/lib/docker
TP_AUTOREMOVE_PROTECTED="sudo systemd-timesyncd curl"
TP_INV_NAMES="units containers networks chains wireguard hostfiles shellrc folders_remove folders_keep accounts groups principals volumes leftalone cpmarkers purge_targets"

# Apt packages option 2 may purge. A role that installs apt packages or adds
# an apt repository has to add them here (and the repo file, when the Docker
# download.docker.com scan or the sury filenames below would not match it).
# daemon-prereqs/tasks/main.yml, plus apt-transport-https from php-fpm.
# apache/tasks/main.yml build dependencies. Installed sudo, systemd-timesyncd,
# and curl are marked manual before autoremove; they are not purge
# candidates. time-sync installs systemd-timesyncd. curl is kept so the
# printed reinstall commands (and a repeat curl | sh) still work post-purge.
TP_PURGE_BASE_PACKAGES="acl ca-certificates curl git gnupg iptables openssl pamtester python3-debian tar unzip wireguard-tools xz-utils zstd apt-transport-https"
TP_PURGE_APACHE_PACKAGES="build-essential libexpat1-dev libpcre2-dev libssl-dev zlib1g-dev"
TP_DOCKER_PACKAGES="docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin docker-ce-rootless-extras docker.io docker-compose containerd runc"

if ! tp_is_interactive; then
  tp_print_error "A controlling terminal is required. Nothing was changed."
  exit 1
fi

tp_main
